import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRun } from '../../src/cli/commands/run.js';
import { parseConfig } from '../../src/storage/config.js';
import type { TriggerDecision } from '../../src/trigger/types.js';
import { Curator } from '../../src/curator/index.js';
import { Runner } from '../../src/runner/index.js';
import { ShiftLogWriter } from '../../src/shift-log/index.js';
import type { Task } from '../../src/types/task.js';
import type { QuotaSnapshot } from '../../src/watcher/types.js';
import type { ActivityChecker } from '../../src/trigger/index.js';

const idleActivity: ActivityChecker = {
  check: async () => ({ active: false, lastActivityAt: null, minutesSince: null }),
};

function fakeSnapshot(now: Date, fiveRem = 50, fiveResetsInMin = 30): QuotaSnapshot {
  return {
    fiveHour: {
      utilizationPct: 100 - fiveRem,
      remainingPct: fiveRem,
      resetsAt: new Date(now.getTime() + fiveResetsInMin * 60_000),
    },
    sevenDay: {
      utilizationPct: 0,
      remainingPct: 100,
      resetsAt: new Date(now.getTime() + 7 * 86400_000),
    },
    sevenDayOpus: null,
    sevenDaySonnet: null,
    sevenDayCowork: null,
    extraUsage: null,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    fetchedAt: now,
    source: 'oauth',
  };
}

function fakeTask(id = 'task-fake-001'): Task {
  return {
    id,
    source: 'T1',
    project: 'fixture',
    title: 'Fake task',
    prompt: 'do x',
    working_dir: '/tmp/fixture',
    cost_estimate_tokens: 1000,
    acceptance: '',
    verify_command: 'true',
    confidence: 'review_queue',
    budget_usd: 0.1,
    safety: { max_diff_lines: 100, forbidden_paths: [] },
  };
}

describe('runRun', () => {
  let now: Date;

  beforeEach(() => {
    // 凌晨 2 点本地：避开 quiet 8-22
    now = new Date(2026, 4, 13, 2, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dry-run + 触发命中 + 队列有任务：返回 dry_run 结果', async () => {
    const cfg = parseConfig({});
    const watcher = { snapshot: async () => fakeSnapshot(now) };
    const curator = new Curator({
      strategies: [{ name: 'fake', source: 'T1', discover: async () => [fakeTask()] }],
    });
    const runner = new Runner();

    const summary = await runRun(
      { dry: true },
      {
        config: cfg,
        watcher,
        curator,
        runner,
        activity: idleActivity,
        silent: true,
        shiftLog: false,
      },
    );

    expect(summary.decision.triggered).toBe(true);
    expect(summary.tasks).toHaveLength(1);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]?.status).toBe('dry_run');
  });

  it('被 quiet hours 拦截：不进入 curator（且非 dry）', async () => {
    const noon = new Date(2026, 4, 13, 12, 0, 0);
    vi.setSystemTime(noon);
    const cfg = parseConfig({});
    const watcher = { snapshot: async () => fakeSnapshot(noon) };
    const curator = new Curator({
      strategies: [{ name: 'fake', source: 'T1', discover: async () => [fakeTask()] }],
    });

    const summary = await runRun(
      {},
      { config: cfg, watcher, curator, activity: idleActivity, silent: true, shiftLog: false },
    );

    expect(summary.decision.triggered).toBe(false);
    expect(summary.decision.blockedBy).toBe('quiet_hours');
    expect(summary.tasks).toHaveLength(0);
    expect(summary.results).toHaveLength(0);
  });

  it('被 quiet hours 拦截但 dry=true：仍然走 curator', async () => {
    const noon = new Date(2026, 4, 13, 12, 0, 0);
    vi.setSystemTime(noon);
    const cfg = parseConfig({});
    const watcher = { snapshot: async () => fakeSnapshot(noon) };
    const curator = new Curator({
      strategies: [{ name: 'fake', source: 'T1', discover: async () => [fakeTask()] }],
    });

    const summary = await runRun(
      { dry: true },
      { config: cfg, watcher, curator, activity: idleActivity, silent: true, shiftLog: false },
    );

    expect(summary.decision.triggered).toBe(false);
    expect(summary.tasks).toHaveLength(1);
    expect(summary.results[0]?.status).toBe('dry_run');
  });

  it('force=true 忽略触发决策', async () => {
    const noon = new Date(2026, 4, 13, 12, 0, 0);
    vi.setSystemTime(noon);
    const cfg = parseConfig({});
    const watcher = { snapshot: async () => fakeSnapshot(noon) };
    const curator = new Curator({
      strategies: [{ name: 'fake', source: 'T1', discover: async () => [fakeTask()] }],
    });
    const stubRunner = {
      execute: vi.fn().mockResolvedValue({
        taskId: 'x',
        status: 'success',
        branchName: 'b',
        worktreePath: '/tmp',
        tokensSpent: 0,
        costUsd: 0,
        durationMs: 0,
        diffLinesChanged: 0,
        filesChanged: 0,
        startedAt: noon.toISOString(),
        finishedAt: noon.toISOString(),
      }),
    } as unknown as Runner;

    const summary = await runRun(
      { force: true },
      {
        config: cfg,
        watcher,
        curator,
        runner: stubRunner,
        activity: idleActivity,
        silent: true,
        shiftLog: false,
      },
    );

    expect(summary.decision.triggered).toBe(false);
    expect(summary.results).toHaveLength(1);
  });

  it('success 结果的输出含 branch 和 worktree 路径 + review 提示', async () => {
    const cfg = parseConfig({});
    const watcher = { snapshot: async () => fakeSnapshot(now) };
    const curator = new Curator({
      strategies: [{ name: 'fake', source: 'T1', discover: async () => [fakeTask()] }],
    });
    const stubRunner = {
      execute: vi.fn().mockResolvedValue({
        taskId: 'task-fake-001',
        status: 'success',
        branchName: 'idleloop/2026-05-13/abc123',
        worktreePath: '/tmp/.idleloop/worktrees/task-fake-001',
        baseBranch: 'main',
        confidence: 'review_queue',
        autoMerged: false,
        tokensSpent: 100,
        costUsd: 0.05,
        durationMs: 1234,
        diffLinesChanged: 10,
        filesChanged: 2,
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
      }),
    } as unknown as Runner;

    const lines: string[] = [];
    await runRun(
      {},
      {
        config: cfg,
        watcher,
        curator,
        runner: stubRunner,
        activity: idleActivity,
        print: (m) => lines.push(m),
        shiftLog: false,
      },
    );

    const all = lines.join('\n');
    expect(all).toContain('idleloop/2026-05-13/abc123');
    expect(all).toContain('/tmp/.idleloop/worktrees/task-fake-001');
    expect(all).toMatch(/idleloop review/);
  });

  it('auto_merge 成功后输出含 auto-merged 标签', async () => {
    const cfg = parseConfig({});
    const watcher = { snapshot: async () => fakeSnapshot(now) };
    const curator = new Curator({
      strategies: [
        {
          name: 'fake',
          source: 'T1',
          discover: async () => [{ ...fakeTask(), confidence: 'auto_merge' as const }],
        },
      ],
    });
    const stubRunner = {
      execute: vi.fn().mockResolvedValue({
        taskId: 'task-auto-001',
        status: 'success',
        branchName: 'idleloop/2026-05-13/auto',
        worktreePath: '/tmp/.idleloop/worktrees/task-auto-001',
        baseBranch: 'main',
        confidence: 'auto_merge',
        autoMerged: true,
        tokensSpent: 100,
        costUsd: 0.02,
        durationMs: 100,
        diffLinesChanged: 1,
        filesChanged: 1,
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
      }),
    } as unknown as Runner;

    const lines: string[] = [];
    await runRun(
      {},
      {
        config: cfg,
        watcher,
        curator,
        runner: stubRunner,
        activity: idleActivity,
        print: (m) => lines.push(m),
        shiftLog: false,
      },
    );

    const all = lines.join('\n');
    expect(all).toMatch(/auto-merged into main/);
  });

  it('队列空时不调用 runner', async () => {
    const cfg = parseConfig({});
    const watcher = { snapshot: async () => fakeSnapshot(now) };
    const curator = new Curator({
      strategies: [{ name: 'empty', source: 'T1', discover: async () => [] }],
    });
    const runFn = vi.fn();
    const runner = { execute: runFn } as unknown as Runner;

    const summary = await runRun(
      { dry: true },
      {
        config: cfg,
        watcher,
        curator,
        runner,
        activity: idleActivity,
        silent: true,
        shiftLog: false,
      },
    );

    expect(summary.tasks).toHaveLength(0);
    expect(runFn).not.toHaveBeenCalled();
  });

  it('writeShiftLog=true + dry-run：写出 shift log 文件', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idleloop-run-'));
    try {
      const cfg = parseConfig({});
      const watcher = { snapshot: async () => fakeSnapshot(now) };
      const curator = new Curator({
        strategies: [{ name: 'fake', source: 'T1', discover: async () => [fakeTask()] }],
      });
      const runner = new Runner();
      const writer = new ShiftLogWriter({ rootDir: dir });

      const summary = await runRun(
        { dry: true, writeShiftLog: true },
        {
          config: cfg,
          watcher,
          curator,
          runner,
          activity: idleActivity,
          silent: true,
          shiftLog: writer,
        },
      );

      expect(summary.shift).toBeDefined();
      expect(summary.shift?.shiftMdPath.startsWith(dir)).toBe(true);
      const md = await readFile(summary.shift!.shiftMdPath, 'utf-8');
      expect(md).toContain('# Shift shift-');
      expect(md).toContain(fakeTask().id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dry-run 且 writeShiftLog 未开：不写 shift log', async () => {
    const cfg = parseConfig({});
    const watcher = { snapshot: async () => fakeSnapshot(now) };
    const curator = new Curator({
      strategies: [{ name: 'fake', source: 'T1', discover: async () => [fakeTask()] }],
    });
    const summary = await runRun(
      { dry: true },
      {
        config: cfg,
        watcher,
        curator,
        activity: idleActivity,
        silent: true,
        // shiftLog 不传：shouldWriteShiftLog dry-run 不写
      },
    );
    expect(summary.shift).toBeUndefined();
  });

  it('working_dir 不在 projects 内时跳过该任务（require_declared_project_dir=true 默认）', async () => {
    const cfg = parseConfig({
      projects: [{ id: 'allowed', dir: '/tmp/allowed-project', strategies: [] }],
      runner: { require_declared_project_dir: true },
    });
    const watcher = { snapshot: async () => fakeSnapshot(now) };
    const allowedTask: Task = { ...fakeTask('task-allowed'), working_dir: '/tmp/allowed-project' };
    const forbiddenTask: Task = { ...fakeTask('task-forbidden'), working_dir: '/etc' };
    const curator = new Curator({
      strategies: [
        { name: 'fake', source: 'T1', discover: async () => [allowedTask, forbiddenTask] },
      ],
    });
    const stubRunner = {
      execute: vi.fn().mockImplementation(async (t: Task) => ({
        taskId: t.id,
        status: 'dry_run',
        branchName: 'b',
        worktreePath: '/tmp',
        tokensSpent: 0,
        costUsd: 0,
        durationMs: 0,
        diffLinesChanged: 0,
        filesChanged: 0,
        startedAt: '',
        finishedAt: '',
      })),
    } as unknown as Runner;

    const summary = await runRun(
      { dry: true },
      {
        config: cfg,
        watcher,
        curator,
        runner: stubRunner,
        activity: idleActivity,
        silent: true,
        shiftLog: false,
      },
    );
    expect(summary.tasks.map((t) => t.id)).toEqual(['task-allowed']);
    expect(summary.results).toHaveLength(1);
  });

  it('require_declared_project_dir=false 时不过滤', async () => {
    const cfg = parseConfig({
      projects: [{ id: 'allowed', dir: '/tmp/allowed-project', strategies: [] }],
      runner: { require_declared_project_dir: false },
    });
    const watcher = { snapshot: async () => fakeSnapshot(now) };
    const out: Task = { ...fakeTask('task-outside'), working_dir: '/etc' };
    const curator = new Curator({
      strategies: [{ name: 'fake', source: 'T1', discover: async () => [out] }],
    });
    const stubRunner = {
      execute: vi.fn().mockResolvedValue({
        taskId: 'task-outside',
        status: 'dry_run',
        branchName: 'b',
        worktreePath: '/tmp',
        tokensSpent: 0,
        costUsd: 0,
        durationMs: 0,
        diffLinesChanged: 0,
        filesChanged: 0,
        startedAt: '',
        finishedAt: '',
      }),
    } as unknown as Runner;
    const summary = await runRun(
      { dry: true },
      {
        config: cfg,
        watcher,
        curator,
        runner: stubRunner,
        activity: idleActivity,
        silent: true,
        shiftLog: false,
      },
    );
    expect(summary.tasks).toHaveLength(1);
  });

  it('单次 shift 累计成本到顶后剩余任务被跳过', async () => {
    const cfg = parseConfig({
      runner: { max_shift_usd: 0.5, require_declared_project_dir: false },
    });
    const watcher = { snapshot: async () => fakeSnapshot(now) };
    const tasks: Task[] = [
      { ...fakeTask('task-1'), budget_usd: 0.3 },
      { ...fakeTask('task-2'), budget_usd: 0.3 },
      { ...fakeTask('task-3'), budget_usd: 0.3 },
    ];
    const curator = new Curator({
      strategies: [{ name: 'fake', source: 'T1', discover: async () => tasks }],
    });
    const stubRunner = {
      execute: vi.fn().mockImplementation(async (t: Task) => ({
        taskId: t.id,
        status: 'success',
        branchName: 'b',
        worktreePath: '/tmp',
        tokensSpent: 100,
        costUsd: 0.3,
        durationMs: 0,
        diffLinesChanged: 1,
        filesChanged: 1,
        startedAt: '',
        finishedAt: '',
      })),
    } as unknown as Runner;
    const summary = await runRun(
      {},
      {
        config: cfg,
        watcher,
        curator,
        runner: stubRunner,
        activity: idleActivity,
        silent: true,
        shiftLog: false,
      },
    );
    // 第一个 0.3 通过；第二个 0.3+0.3=0.6 > 0.5 不通过 → 只有 1 个结果
    expect(summary.results.map((r) => r.taskId)).toEqual(['task-1']);
  });

  it('watcher.snapshot 异常 → invalid_snapshot', async () => {
    const cfg = parseConfig({});
    const watcher = {
      snapshot: async () => {
        throw new Error('net down');
      },
    };
    const summary = await runRun(
      {},
      { config: cfg, watcher, activity: idleActivity, silent: true, shiftLog: false },
    );
    const d: TriggerDecision = summary.decision;
    expect(d.triggered).toBe(false);
    expect(d.blockedBy).toBe('invalid_snapshot');
  });
});
