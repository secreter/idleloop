import { styleText } from 'node:util';
import { defaultCurator } from '../../curator/index.js';
import type { Curator } from '../../curator/index.js';
import { Runner } from '../../runner/index.js';
import { loadConfig, type Config } from '../../storage/config.js';
import { TriggerEngine, type SnapshotSource } from '../../trigger/index.js';
import type { TriggerDecision } from '../../trigger/types.js';
import type { Task, TaskResult } from '../../types/task.js';
import { Watcher } from '../../watcher/index.js';

export interface RunRunOptions {
  /** dry-run：不创建 worktree、不启 claude */
  dry?: boolean;
  /** 忽略 trigger 决策强制跑（仍要拿到 snapshot；dry 也建议开） */
  force?: boolean;
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
  /** 静默 console 输出（测试用） */
  silent?: boolean;
}

/**
 * `idleloop run [--dry] [--force]`：单次触发模拟。
 *
 * 编排：
 *   1. load config
 *   2. TriggerEngine.shouldTrigger() —— 报告决策
 *   3. 若 triggered 或 force：Curator.gather() —— 拿任务列表
 *   4. 每个任务：Runner.execute(task, { dry }) —— dry 模式短路
 *   5. 返回完整 summary
 */
export async function runRun(opts: RunRunOptions = {}, deps: RunDeps = {}): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const config = deps.config ?? (await loadConfig());
  const log = deps.silent ? () => {} : (m: string) => console.log(m);

  const watcher = deps.watcher ?? new Watcher();
  const engine = new TriggerEngine({
    config: config.trigger,
    watcher,
  });

  const decision = await engine.shouldTrigger();
  printDecision(decision, log);

  const results: TaskResult[] = [];
  let tasks: Task[] = [];
  let perStrategy: RunSummary['perStrategy'] = [];

  const shouldProceed = decision.triggered || opts.force === true || opts.dry === true;
  if (!shouldProceed) {
    log(styleText('dim', '· decision says no trigger; not gathering tasks'));
    return {
      decision,
      tasks,
      results,
      perStrategy,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const curator = deps.curator ?? defaultCurator();
  const report = await curator.gather();
  tasks = report.tasks;
  perStrategy = report.perStrategy.map((s) => {
    const base = { name: s.name, discovered: s.discovered, skipped: s.skipped };
    return s.error !== undefined ? { ...base, error: s.error } : base;
  });
  printCuratorReport(report, log);

  if (tasks.length === 0) {
    log(styleText('dim', '· no tasks ready; nothing to do'));
    return {
      decision,
      tasks,
      results,
      perStrategy,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const runner =
    deps.runner ??
    new Runner({
      claudeCliPath: config.runner.claude_cli_path,
      verifyTimeoutMs: config.runner.per_task_timeout_minutes * 60_000,
    });

  for (const task of tasks) {
    log('');
    log(styleText('bold', `→ executing ${task.id} (${task.title})${opts.dry ? ' [dry-run]' : ''}`));
    const result = await runner.execute(task, { dry: opts.dry === true });
    printResult(result, log);
    results.push(result);
  }

  return {
    decision,
    tasks,
    results,
    perStrategy,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

type LogFn = (msg: string) => void;

function printDecision(d: TriggerDecision, log: LogFn): void {
  if (d.triggered) {
    log(styleText('green', `✓ TRIGGER: ${d.reason}`));
  } else {
    log(styleText('yellow', `✗ SKIP: ${d.reason} (blockedBy=${d.blockedBy ?? 'n/a'})`));
  }
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
