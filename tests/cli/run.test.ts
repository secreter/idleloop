import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRun } from '../../src/cli/commands/run.js';
import { parseConfig } from '../../src/storage/config.js';
import type { TriggerDecision } from '../../src/trigger/types.js';
import { Curator } from '../../src/curator/index.js';
import { Runner } from '../../src/runner/index.js';
import type { Task } from '../../src/types/task.js';
import type { QuotaSnapshot } from '../../src/watcher/types.js';

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
      { config: cfg, watcher, curator, runner, silent: true },
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

    const summary = await runRun({}, { config: cfg, watcher, curator, silent: true });

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

    const summary = await runRun({ dry: true }, { config: cfg, watcher, curator, silent: true });

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
      { config: cfg, watcher, curator, runner: stubRunner, silent: true },
    );

    expect(summary.decision.triggered).toBe(false);
    expect(summary.results).toHaveLength(1);
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
      { config: cfg, watcher, curator, runner, silent: true },
    );

    expect(summary.tasks).toHaveLength(0);
    expect(runFn).not.toHaveBeenCalled();
  });

  it('watcher.snapshot 异常 → invalid_snapshot', async () => {
    const cfg = parseConfig({});
    const watcher = {
      snapshot: async () => {
        throw new Error('net down');
      },
    };
    const summary = await runRun({}, { config: cfg, watcher, silent: true });
    const d: TriggerDecision = summary.decision;
    expect(d.triggered).toBe(false);
    expect(d.blockedBy).toBe('invalid_snapshot');
  });
});
