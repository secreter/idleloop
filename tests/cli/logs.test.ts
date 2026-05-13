import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLogs } from '../../src/cli/commands/logs.js';
import { ShiftLogWriter } from '../../src/shift-log/index.js';
import type { TaskResult } from '../../src/types/task.js';

function aResult(over: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: 'task-A',
    status: 'success',
    branchName: 'b',
    worktreePath: '/tmp/wt',
    tokensSpent: 100,
    costUsd: 0.01,
    durationMs: 1000,
    diffLinesChanged: 1,
    filesChanged: 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...over,
  };
}

describe('runLogs', () => {
  let root: string;
  const out: string[] = [];
  const print = (s: string) => out.push(s);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'idleloop-logscmd-'));
    out.length = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(date: string, shiftsCount = 1, triggered = true) {
    const writer = new ShiftLogWriter({ rootDir: `${root}/${date}` });
    for (let i = 0; i < shiftsCount; i++) {
      const startedAt = new Date(2026, 4, 13, 3 + i, 0, 0);
      await writer.record({
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 5_000),
        decision: triggered
          ? { triggered: true, reason: 'ok' }
          : { triggered: false, reason: 'blocked', blockedBy: 'quiet_hours' },
        snapshot: null,
        tasks: [],
        results: triggered ? [aResult({ taskId: `task-${date}-${i}-A` })] : [],
        strategies: [],
      });
    }
  }

  it('无任何 logs 时友好提示', async () => {
    const r = await runLogs({}, { logsRoot: root, print });
    expect(r.availableDates).toEqual([]);
    expect(out.some((l) => /no shift logs yet/.test(l))).toBe(true);
  });

  it('默认显示最近一天的 shift 列表', async () => {
    await seed('2026-05-12', 1);
    await seed('2026-05-13', 2);

    const r = await runLogs({}, { logsRoot: root, print });
    expect(r.date).toBe('2026-05-13');
    expect(r.shifts).toHaveLength(2);
    expect(out.join('\n')).toContain('Shifts on 2026-05-13');
    expect(out.join('\n')).toContain('TRIGGER');
  });

  it('--list 输出多天概览，按降序', async () => {
    await seed('2026-05-12', 1);
    await seed('2026-05-13', 2);

    const r = await runLogs({ list: true }, { logsRoot: root, print });
    expect(r.availableDates).toEqual(['2026-05-13', '2026-05-12']);
    // 表头
    expect(out[0]).toContain('date');
    const body = out.slice(1).join('\n');
    expect(body.indexOf('2026-05-13')).toBeLessThan(body.indexOf('2026-05-12'));
  });

  it('--date 指定不存在的日期 → 友好提示', async () => {
    await seed('2026-05-12', 1);
    const r = await runLogs({ date: '2025-01-01' }, { logsRoot: root, print });
    expect(r.date).toBe('2025-01-01');
    expect(r.shifts).toHaveLength(0);
    expect(out.join('\n')).toMatch(/no shift log for 2025-01-01/);
  });

  it('--raw 模式直接打印 shift.md', async () => {
    await seed('2026-05-13', 1);
    const r = await runLogs({ date: '2026-05-13', raw: true }, { logsRoot: root, print });
    expect(r.rawMd).toBeDefined();
    expect(r.rawMd).toContain('# Shift');
    expect(out.some((l) => l.includes('# Shift'))).toBe(true);
  });

  it('--json 输出 JSON 可解析', async () => {
    await seed('2026-05-13', 1);
    const r = await runLogs({ date: '2026-05-13', json: true }, { logsRoot: root, print });
    expect(r.shifts).toHaveLength(1);
    const parsed = JSON.parse(out.join('\n')) as { date: string; shifts: unknown[] };
    expect(parsed.date).toBe('2026-05-13');
    expect(parsed.shifts).toHaveLength(1);
  });

  it('--list 标注全部 blocked 的日期', async () => {
    await seed('2026-05-13', 1, false);
    const r = await runLogs({ list: true }, { logsRoot: root, print });
    expect(r.availableDates).toContain('2026-05-13');
    expect(out.join('\n')).toMatch(/all blocked/);
  });
});
