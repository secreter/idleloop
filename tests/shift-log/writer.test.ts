import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ShiftLogWriter,
  listShiftDates,
  loadLatestShiftState,
  loadShiftsForDate,
} from '../../src/shift-log/index.js';
import type { TaskResult } from '../../src/types/task.js';

function makeResult(over: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: 'task-A',
    status: 'success',
    branchName: 'idleloop/2026-05-13/abc',
    worktreePath: '/tmp/wt/task-A',
    tokensSpent: 1000,
    costUsd: 0.05,
    durationMs: 5_000,
    diffLinesChanged: 10,
    filesChanged: 1,
    startedAt: '2026-05-13T03:00:00.000Z',
    finishedAt: '2026-05-13T03:00:05.000Z',
    ...over,
  };
}

describe('ShiftLogWriter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'idleloop-shiftlog-'));
  });

  afterEach(async () => {
    // 测试 helper：mkdtemp 创建的目录不重要，留给 OS 清理也行。
    // 但显式 rm 避免 /tmp 撑爆。
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('写入 shift.md / state.json / per-shift json', async () => {
    const writer = new ShiftLogWriter({ rootDir: dir, now: () => new Date(2026, 4, 13, 3, 0, 0) });
    const startedAt = new Date(2026, 4, 13, 3, 0, 0);
    const finishedAt = new Date(2026, 4, 13, 3, 5, 0);
    const rec = await writer.record({
      startedAt,
      finishedAt,
      decision: { triggered: true, reason: 'trigger ok' },
      snapshot: null,
      tasks: [],
      results: [makeResult()],
      strategies: [{ name: 'bookshelf', discovered: 1, skipped: 0 }],
    });

    expect(rec.shiftId).toMatch(/^shift-/);
    expect(rec.date).toBe('2026-05-13');
    expect(rec.shiftMdPath.endsWith('shift.md')).toBe(true);
    expect(rec.stateJsonPath.endsWith('state.json')).toBe(true);

    const md = await readFile(rec.shiftMdPath, 'utf-8');
    expect(md).toContain('# Shift shift-');
    expect(md).toContain('task-A');

    const stateRaw = JSON.parse(await readFile(rec.stateJsonPath, 'utf-8')) as {
      shiftId: string;
      totalCostUsd: number;
      totalTokens: number;
    };
    expect(stateRaw.shiftId).toBe(rec.shiftId);
    expect(stateRaw.totalCostUsd).toBeCloseTo(0.05);
    expect(stateRaw.totalTokens).toBe(1000);

    const shiftsDir = await readdir(`${dir}/shifts`);
    expect(shiftsDir).toContain(`${rec.shiftId}.json`);
  });

  it('同一目录多次 record：shift.md 追加，state.json 覆盖最新', async () => {
    const writer = new ShiftLogWriter({ rootDir: dir });
    const t0 = new Date(2026, 4, 13, 3, 0, 0);
    const t1 = new Date(2026, 4, 13, 4, 0, 0);
    const t2 = new Date(2026, 4, 13, 5, 0, 0);
    const t3 = new Date(2026, 4, 13, 5, 5, 0);
    const rec1 = await writer.record({
      startedAt: t0,
      finishedAt: t1,
      decision: { triggered: true, reason: 'first' },
      snapshot: null,
      tasks: [],
      results: [makeResult({ taskId: 'task-A' })],
      strategies: [],
    });
    const rec2 = await writer.record({
      startedAt: t2,
      finishedAt: t3,
      decision: { triggered: true, reason: 'second' },
      snapshot: null,
      tasks: [],
      results: [makeResult({ taskId: 'task-B' })],
      strategies: [],
    });

    const md = await readFile(rec2.shiftMdPath, 'utf-8');
    expect(md).toContain('task-A');
    expect(md).toContain('task-B');
    expect(md.split('---').length).toBeGreaterThan(1);

    const stateRaw = JSON.parse(await readFile(rec2.stateJsonPath, 'utf-8')) as {
      shiftId: string;
    };
    expect(stateRaw.shiftId).toBe(rec2.shiftId);
    expect(stateRaw.shiftId).not.toBe(rec1.shiftId);
  });

  it('blockedBy 决策也能正确落盘 + state.blocked 字段', async () => {
    const writer = new ShiftLogWriter({ rootDir: dir });
    const rec = await writer.record({
      startedAt: new Date(),
      finishedAt: new Date(),
      decision: { triggered: false, reason: 'in quiet hours', blockedBy: 'quiet_hours' },
      snapshot: null,
      tasks: [],
      results: [],
      strategies: [],
    });
    const stateRaw = JSON.parse(await readFile(rec.stateJsonPath, 'utf-8')) as {
      blocked?: { blockedBy: string; reason: string };
    };
    expect(stateRaw.blocked?.blockedBy).toBe('quiet_hours');
    expect(stateRaw.blocked?.reason).toBe('in quiet hours');
  });
});

describe('listShiftDates / loadLatestShiftState / loadShiftsForDate', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'idleloop-logs-'));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  it('返回所有合法 date 目录，按降序排列', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(`${root}/2026-05-13`, { recursive: true });
    await mkdir(`${root}/2026-05-12`, { recursive: true });
    await mkdir(`${root}/2026-05-14`, { recursive: true });
    await mkdir(`${root}/not-a-date`, { recursive: true });
    // 写一个 state.json 测 load
    await writeFile(`${root}/2026-05-13/state.json`, JSON.stringify({ shiftId: 'shift-A' }));

    const dates = await listShiftDates({ logsRoot: root });
    expect(dates).toEqual(['2026-05-14', '2026-05-13', '2026-05-12']);

    const latest = await loadLatestShiftState('2026-05-13', { logsRoot: root });
    expect(latest?.shiftId).toBe('shift-A');

    const missing = await loadLatestShiftState('2026-04-01', { logsRoot: root });
    expect(missing).toBeNull();
  });

  it('logs 根目录不存在时返回空数组', async () => {
    const result = await listShiftDates({ logsRoot: `${root}/nope` });
    expect(result).toEqual([]);
  });

  it('loadShiftsForDate 读取多个 per-shift json 并按 startedAt 升序', async () => {
    const writer = new ShiftLogWriter({ rootDir: `${root}/2026-05-13` });
    const t0 = new Date(2026, 4, 13, 2, 0, 0);
    const t1 = new Date(2026, 4, 13, 3, 0, 0);
    await writer.record({
      startedAt: t1,
      finishedAt: new Date(t1.getTime() + 5_000),
      decision: { triggered: true, reason: 'later' },
      snapshot: null,
      tasks: [],
      results: [],
      strategies: [],
    });
    await writer.record({
      startedAt: t0,
      finishedAt: new Date(t0.getTime() + 5_000),
      decision: { triggered: true, reason: 'earlier' },
      snapshot: null,
      tasks: [],
      results: [],
      strategies: [],
    });

    const shifts = await loadShiftsForDate('2026-05-13', { logsRoot: root });
    expect(shifts).toHaveLength(2);
    expect(shifts[0]?.decision.reason).toBe('earlier');
    expect(shifts[1]?.decision.reason).toBe('later');
  });
});
