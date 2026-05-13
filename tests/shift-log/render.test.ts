import { describe, expect, it } from 'vitest';
import { renderShiftMarkdown } from '../../src/shift-log/render.js';
import type { ShiftState } from '../../src/shift-log/types.js';
import type { TaskResult } from '../../src/types/task.js';
import type { QuotaSnapshot } from '../../src/watcher/types.js';

function stateBase(): ShiftState {
  const startedAt = new Date('2026-05-13T03:00:00Z');
  const finishedAt = new Date('2026-05-13T03:12:00Z');
  return {
    shiftId: 'shift-01TESTABC',
    date: '2026-05-13',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    decision: {
      triggered: true,
      reason: '5h: 50% remaining, reset in 0.5h',
      windowType: 'five_hour',
      remainingPct: 50,
      msUntilReset: 30 * 60_000,
    },
    snapshot: null,
    results: [],
    strategies: [],
    totalCostUsd: 0,
    totalTokens: 0,
  };
}

function result(over: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: 'task-A',
    status: 'success',
    branchName: 'idleloop/2026-05-13/abc',
    worktreePath: '/tmp/wt/task-A',
    tokensSpent: 1234,
    costUsd: 0.0321,
    durationMs: 8_400,
    diffLinesChanged: 22,
    filesChanged: 3,
    startedAt: '2026-05-13T03:00:00Z',
    finishedAt: '2026-05-13T03:01:24Z',
    ...over,
  };
}

describe('renderShiftMarkdown', () => {
  it('包含 shift id / date / 触发原因', () => {
    const md = renderShiftMarkdown({ state: stateBase(), tasks: [] });
    expect(md).toContain('# Shift shift-01TESTABC');
    expect(md).toContain('date: 2026-05-13');
    expect(md).toContain('5h: 50% remaining');
    expect(md).toContain('window:    five_hour');
  });

  it('quota snapshot 表格化展示 5h / 7d', () => {
    const snapshot: QuotaSnapshot = {
      fiveHour: {
        utilizationPct: 30,
        remainingPct: 70,
        resetsAt: new Date('2026-05-13T04:00:00Z'),
      },
      sevenDay: {
        utilizationPct: 10,
        remainingPct: 90,
        resetsAt: new Date('2026-05-20T03:00:00Z'),
      },
      sevenDayOpus: null,
      sevenDaySonnet: null,
      sevenDayCowork: null,
      extraUsage: null,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      fetchedAt: new Date('2026-05-13T03:00:00Z'),
      source: 'oauth',
    };
    const state = { ...stateBase(), snapshot };
    const md = renderShiftMarkdown({ state, tasks: [] });
    expect(md).toContain('## Quota Snapshot');
    expect(md).toContain('| 5h | 70.0%');
    expect(md).toContain('| 7d | 90.0%');
    expect(md).toContain('2026-05-13T04:00:00.000Z');
  });

  it('curator strategies 展示在表格里，包括 error 列', () => {
    const state: ShiftState = {
      ...stateBase(),
      strategies: [
        { name: 'bookshelf', discovered: 2, skipped: 0 },
        { name: 'audit', discovered: 0, skipped: 0, error: 'glob failed: EPERM' },
      ],
    };
    const md = renderShiftMarkdown({ state, tasks: [] });
    expect(md).toContain('## Curator');
    expect(md).toContain('| bookshelf | 2 | 0 |');
    expect(md).toContain('| audit | 0 | 0 | glob failed: EPERM |');
  });

  it('没有任务时打印 _no tasks executed_', () => {
    const md = renderShiftMarkdown({ state: stateBase(), tasks: [] });
    expect(md).toContain('_no tasks executed in this shift._');
    expect(md).toContain('_nothing to review');
  });

  it('成功的任务渲染 review section + cd worktree 命令', () => {
    const state: ShiftState = {
      ...stateBase(),
      results: [result()],
      totalCostUsd: 0.0321,
      totalTokens: 1234,
    };
    const md = renderShiftMarkdown({ state, tasks: [] });
    expect(md).toContain('### task-A — `success`');
    expect(md).toContain('idleloop review --date 2026-05-13');
    expect(md).toContain('cd /tmp/wt/task-A');
    expect(md).toContain('Tasks: 1 · success=1');
    expect(md).toContain('cost=$0.0321');
  });

  it('verify_failed 任务展示 verify 输出 tail', () => {
    const big = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const r = result({
      status: 'verify_failed',
      verifyOutput: big,
    });
    const state: ShiftState = { ...stateBase(), results: [r] };
    const md = renderShiftMarkdown({ state, tasks: [] });
    expect(md).toContain('`verify_failed`');
    expect(md).toContain('**Verify output (tail):**');
    expect(md).toContain('... (truncated)');
    expect(md).toContain('line 50');
    expect(md).not.toContain('line 1\n');
  });

  it('error 任务展示 error 信息块', () => {
    const r = result({ status: 'error', errorMessage: 'EACCES /root' });
    const state: ShiftState = { ...stateBase(), results: [r] };
    const md = renderShiftMarkdown({ state, tasks: [] });
    expect(md).toContain('`error`');
    expect(md).toContain('**Error:**');
    expect(md).toContain('EACCES /root');
  });

  it('被拦截的 shift（quiet_hours）顶部展示 blockedBy', () => {
    const state: ShiftState = {
      ...stateBase(),
      decision: {
        triggered: false,
        reason: 'in quiet hours 8-22',
        blockedBy: 'quiet_hours',
      },
      blocked: { blockedBy: 'quiet_hours', reason: 'in quiet hours 8-22' },
    };
    const md = renderShiftMarkdown({ state, tasks: [] });
    expect(md).toContain('triggered: false');
    expect(md).toContain('blockedBy: quiet_hours');
  });
});
