import { styleText } from 'node:util';
import { defaultCurator } from '../../curator/index.js';
import type { Curator } from '../../curator/index.js';
import { Runner } from '../../runner/index.js';
import { ShiftLogWriter, type ShiftRecordResult } from '../../shift-log/index.js';
import { loadConfig, type Config } from '../../storage/config.js';
import { expandHome as expandHomePath } from '../../storage/paths.js';
import { TriggerEngine, type ActivityChecker, type SnapshotSource } from '../../trigger/index.js';
import type { TriggerDecision } from '../../trigger/types.js';
import type { Task, TaskResult } from '../../types/task.js';
import type { QuotaSnapshot } from '../../watcher/types.js';
import { Watcher } from '../../watcher/index.js';

export interface RunRunOptions {
  /** dry-run：不创建 worktree、不启 claude */
  dry?: boolean;
  /** 忽略 trigger 决策强制跑（仍要拿到 snapshot；dry 也建议开） */
  force?: boolean;
  /** 即使 dry-run 也写 shift log（默认 false：dry-run 不污染日志） */
  writeShiftLog?: boolean;
}

export interface RunSummary {
  decision: TriggerDecision;
  tasks: Task[];
  results: TaskResult[];
  perStrategy: Array<{
    name: string;
    discovered: number;
    skipped: number;
    error?: string;
  }>;
  snapshot: QuotaSnapshot | null;
  shift?: ShiftRecordResult;
  startedAt: string;
  finishedAt: string;
}

/**
 * 测试注入点。允许覆盖 Watcher / Curator / Runner / Config。
 */
export interface RunDeps {
  config?: Config;
  watcher?: SnapshotSource;
  curator?: Curator;
  runner?: Runner;
  /** 测试注入：避免扫真实 ~/.claude/projects/ 导致 user_activity 误判 */
  activity?: ActivityChecker;
  /** 静默 console 输出（测试用） */
  silent?: boolean;
  /** 显式注入 shift log writer。传 false 完全禁用（测试默认） */
  shiftLog?: ShiftLogWriter | false;
}

/**
 * `idleloop run [--dry] [--force]`：单次触发模拟。
 *
 * 编排：
 *   1. load config
 *   2. watcher.snapshot() —— 拿一次余量并缓存（避免被 trigger 引擎重复拉）
 *   3. TriggerEngine.shouldTrigger() —— 报告决策
 *   4. 若 triggered 或 force 或 dry：Curator.gather() —— 拿任务列表
 *   5. 每个任务：Runner.execute(task, { dry }) —— dry 模式短路
 *   6. 非 dry-run 默认写 shift log；dry-run + writeShiftLog=true 也写
 */
export async function runRun(opts: RunRunOptions = {}, deps: RunDeps = {}): Promise<RunSummary> {
  const startedAt = new Date();
  const config = deps.config ?? (await loadConfig());
  const log = deps.silent ? () => {} : (m: string) => console.log(m);

  const rawWatcher = deps.watcher ?? new Watcher();
  let snapshot: QuotaSnapshot | null = null;
  let snapshotErr: Error | null = null;
  try {
    snapshot = await rawWatcher.snapshot();
  } catch (err) {
    snapshotErr = err as Error;
  }
  const cachedWatcher: SnapshotSource = {
    snapshot: async () => {
      if (snapshotErr) throw snapshotErr;
      return snapshot!;
    },
  };

  const engine = new TriggerEngine({
    config: config.trigger,
    watcher: cachedWatcher,
    ...(deps.activity ? { activity: deps.activity } : {}),
  });

  const decision = await engine.shouldTrigger();
  if (opts.dry === true) {
    log(
      styleText(
        'cyan',
        '── PREVIEW (--dry): bypassing quiet_hours / user_activity / policy gates ──',
      ),
    );
  }
  if (snapshot) printSnapshotLine(snapshot, log);
  printDecision(decision, opts, log);

  const results: TaskResult[] = [];
  let tasks: Task[] = [];
  let perStrategy: RunSummary['perStrategy'] = [];

  const shouldProceed = decision.triggered || opts.force === true || opts.dry === true;
  if (!shouldProceed) {
    log(styleText('dim', '· decision says no trigger; not gathering tasks'));
    return finishSummary({
      decision,
      tasks,
      results,
      perStrategy,
      snapshot,
      startedAt,
      opts,
      deps,
      log,
    });
  }

  const curator = deps.curator ?? defaultCurator(config);
  const report = await curator.gather();
  tasks = report.tasks;
  perStrategy = report.perStrategy.map((s) => {
    const base = { name: s.name, discovered: s.discovered, skipped: s.skipped };
    return s.error !== undefined ? { ...base, error: s.error } : base;
  });
  printCuratorReport(report, log);

  if (tasks.length === 0) {
    log(styleText('dim', '· no tasks ready; nothing to do'));
    return finishSummary({
      decision,
      tasks,
      results,
      perStrategy,
      snapshot,
      startedAt,
      opts,
      deps,
      log,
    });
  }

  // working_dir 守门：在 require_declared_project_dir=true 时，
  // task.working_dir 必须命中 projects[].dir 之一（展开 ~ 后），否则跳过该任务。
  if (config.runner.require_declared_project_dir && config.projects.length > 0) {
    const declared = new Set(config.projects.map((p) => expandHomePath(p.dir).replace(/\/$/, '')));
    const filtered: Task[] = [];
    for (const t of tasks) {
      const wd = expandHomePath(t.working_dir).replace(/\/$/, '');
      const ok =
        declared.has(wd) || Array.from(declared).some((d) => wd === d || wd.startsWith(d + '/'));
      if (!ok) {
        log(
          styleText(
            'red',
            `! skipping ${t.id}: working_dir ${t.working_dir} not in configured projects`,
          ),
        );
        continue;
      }
      filtered.push(t);
    }
    tasks = filtered;
  }

  if (tasks.length === 0) {
    log(styleText('dim', '· no tasks survived working_dir allowlist; nothing to do'));
    return finishSummary({
      decision,
      tasks,
      results,
      perStrategy,
      snapshot,
      startedAt,
      opts,
      deps,
      log,
    });
  }

  const runner =
    deps.runner ??
    new Runner({
      claudeCliPath: config.runner.claude_cli_path,
      verifyTimeoutMs: config.runner.per_task_timeout_minutes * 60_000,
    });

  // 单次 shift 累计成本上限
  const shiftBudget = config.runner.max_shift_usd;
  let shiftSpent = 0;
  for (const task of tasks) {
    log('');
    if (!opts.dry && shiftSpent + task.budget_usd > shiftBudget) {
      log(
        styleText(
          'yellow',
          `! shift budget cap $${shiftBudget.toFixed(2)} would be exceeded by ${task.id} (already spent $${shiftSpent.toFixed(2)}, est $${task.budget_usd}); skipping remaining tasks`,
        ),
      );
      break;
    }
    log(styleText('bold', `→ executing ${task.id} (${task.title})${opts.dry ? ' [dry-run]' : ''}`));
    const result = await runner.execute(task, { dry: opts.dry === true });
    printResult(result, log);
    results.push(result);
    shiftSpent += result.costUsd;
  }

  return finishSummary({
    decision,
    tasks,
    results,
    perStrategy,
    snapshot,
    startedAt,
    opts,
    deps,
    log,
  });
}

interface FinishArgs {
  decision: TriggerDecision;
  tasks: Task[];
  results: TaskResult[];
  perStrategy: RunSummary['perStrategy'];
  snapshot: QuotaSnapshot | null;
  startedAt: Date;
  opts: RunRunOptions;
  deps: RunDeps;
  log: LogFn;
}

async function finishSummary(args: FinishArgs): Promise<RunSummary> {
  const finishedAt = new Date();
  const summary: RunSummary = {
    decision: args.decision,
    tasks: args.tasks,
    results: args.results,
    perStrategy: args.perStrategy,
    snapshot: args.snapshot,
    startedAt: args.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };

  const shouldWriteLog = shouldWriteShiftLog(args);
  if (shouldWriteLog) {
    const writer =
      args.deps.shiftLog instanceof ShiftLogWriter ? args.deps.shiftLog : new ShiftLogWriter();
    try {
      const rec = await writer.record({
        startedAt: args.startedAt,
        finishedAt,
        decision: args.decision,
        snapshot: args.snapshot,
        tasks: args.tasks,
        results: args.results,
        strategies: args.perStrategy,
      });
      summary.shift = rec;
      args.log(styleText('dim', `· shift log: ${rec.shiftMdPath}`));
    } catch (err) {
      args.log(styleText('red', `! failed to write shift log: ${(err as Error).message}`));
    }
  }

  return summary;
}

function shouldWriteShiftLog(args: FinishArgs): boolean {
  if (args.deps.shiftLog === false) return false;
  if (args.opts.dry === true && args.opts.writeShiftLog !== true) return false;
  return true;
}

type LogFn = (msg: string) => void;

function printDecision(d: TriggerDecision, opts: RunRunOptions, log: LogFn): void {
  const prefix = opts.dry === true ? '[would]' : '';
  if (d.triggered) {
    log(styleText('green', `✓ ${prefix} TRIGGER: ${d.reason}`));
  } else if (opts.dry === true) {
    // 在 preview 模式下，把 "SKIP" 重新解释为「现在不会触发，但 --dry 还是继续看」
    log(
      styleText(
        'yellow',
        `· gate not satisfied right now: ${d.reason} (blockedBy=${d.blockedBy ?? 'n/a'})`,
      ),
    );
    log(styleText('dim', '  → preview continues; not pausing on gate'));
  } else {
    log(styleText('yellow', `✗ SKIP: ${d.reason} (blockedBy=${d.blockedBy ?? 'n/a'})`));
  }
}

function printSnapshotLine(s: QuotaSnapshot, log: LogFn): void {
  const fiveRem = s.fiveHour.remainingPct.toFixed(0);
  const sevenRem = s.sevenDay.remainingPct.toFixed(0);
  const fiveReset = formatRelative(s.fiveHour.resetsAt);
  const sevenReset = formatRelative(s.sevenDay.resetsAt);
  log(
    styleText(
      'dim',
      `quota: 5h=${fiveRem}% (reset ${fiveReset}) · 7d=${sevenRem}% (reset ${sevenReset})`,
    ),
  );
}

function formatRelative(resetsAt: Date | null): string {
  if (!resetsAt) return 'unknown';
  const ms = resetsAt.getTime() - Date.now();
  if (ms <= 0) return 'past';
  if (ms < 3600_000) return `in ${Math.round(ms / 60_000)}min`;
  if (ms < 86400_000) return `in ${(ms / 3600_000).toFixed(1)}h`;
  return `in ${(ms / 86400_000).toFixed(1)}d`;
}

function printCuratorReport(
  report: {
    tasks: Task[];
    perStrategy: Array<{ name: string; discovered: number; skipped: number; error?: string }>;
  },
  log: LogFn,
): void {
  log(styleText('bold', `\nCurator: ${report.tasks.length} tasks ready`));
  for (const s of report.perStrategy) {
    const errSuffix = s.error ? styleText('red', ` (error: ${s.error})`) : '';
    log(
      styleText(
        'dim',
        `  · ${s.name}: discovered=${s.discovered} skipped=${s.skipped}${errSuffix}`,
      ),
    );
  }
}

function printResult(r: TaskResult, log: LogFn): void {
  const colorFor: Record<TaskResult['status'], (s: string) => string> = {
    success: (s) => styleText('green', s),
    dry_run: (s) => styleText('cyan', s),
    verify_failed: (s) => styleText('yellow', s),
    aborted_oversized: (s) => styleText('yellow', s),
    aborted_budget: (s) => styleText('yellow', s),
    aborted_forbidden_path: (s) => styleText('red', s),
    error: (s) => styleText('red', s),
  };
  const colorize = colorFor[r.status] ?? ((s: string) => s);
  log(
    `  ${colorize(`[${r.status}]`)} tokens=${r.tokensSpent} cost=$${r.costUsd.toFixed(4)} diff=${r.diffLinesChanged}L/${r.filesChanged}f duration=${r.durationMs}ms`,
  );
  if (r.errorMessage) log(styleText('dim', `    ${r.errorMessage}`));
}
