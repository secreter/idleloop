import { readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { ulid } from 'ulid';
import { ensureDir, paths, todayDateString } from '../storage/paths.js';
import type { Task, TaskResult } from '../types/task.js';
import type { TriggerDecision } from '../trigger/types.js';
import type { QuotaSnapshot } from '../watcher/types.js';
import { logger as rootLogger } from '../utils/logger.js';
import { renderShiftMarkdown } from './render.js';
import type { ShiftState } from './types.js';

const log = rootLogger.child({ mod: 'shift-log' });

export interface ShiftRecordInput {
  startedAt: Date;
  finishedAt: Date;
  decision: TriggerDecision;
  snapshot: QuotaSnapshot | null;
  tasks: Task[];
  results: TaskResult[];
  strategies: Array<{ name: string; discovered: number; skipped: number; error?: string }>;
}

export interface ShiftRecordResult {
  shiftId: string;
  date: string;
  shiftMdPath: string;
  stateJsonPath: string;
  state: ShiftState;
}

/**
 * 把一次 shift 的执行结果落盘。
 *
 * 副作用：
 *   - ~/.idleloop/logs/{date}/shift.md  追加（同一天多次 shift 都写在一起）
 *   - ~/.idleloop/logs/{date}/state.json 覆盖（最近一次 shift 完整状态）
 *   - ~/.idleloop/logs/{date}/shifts/{shiftId}.json 每次单独留底，便于 idleloop logs --shift
 */
export class ShiftLogWriter {
  /**
   * 测试可以注入：默认从 paths.logsForDate(date) 算路径；测试可以塞 rootDir。
   */
  constructor(
    private readonly opts: {
      rootDir?: string;
      now?: () => Date;
    } = {},
  ) {}

  async record(input: ShiftRecordInput): Promise<ShiftRecordResult> {
    const now = this.opts.now ?? (() => new Date());
    const date = todayDateString(now());
    const shiftId = `shift-${ulid()}`;

    const totalCost = input.results.reduce((acc, r) => acc + r.costUsd, 0);
    const totalTokens = input.results.reduce((acc, r) => acc + r.tokensSpent, 0);

    const state: ShiftState = {
      shiftId,
      date,
      startedAt: input.startedAt.toISOString(),
      finishedAt: input.finishedAt.toISOString(),
      decision: input.decision,
      snapshot: input.snapshot,
      results: input.results,
      strategies: input.strategies,
      totalCostUsd: totalCost,
      totalTokens,
      ...(input.decision.blockedBy != null
        ? {
            blocked: {
              blockedBy: input.decision.blockedBy,
              reason: input.decision.reason,
            },
          }
        : {}),
    };

    const dirRoot = this.opts.rootDir ?? paths.logsForDate(date);
    const shiftsDir = `${dirRoot}/shifts`;
    await ensureDir(dirRoot);
    await ensureDir(shiftsDir);

    const md = renderShiftMarkdown({ state, tasks: input.tasks });
    const shiftMdPath = `${dirRoot}/shift.md`;
    await appendMd(shiftMdPath, md);

    const stateJsonPath = `${dirRoot}/state.json`;
    await writeFile(stateJsonPath, JSON.stringify(state, null, 2));

    const perShiftPath = `${shiftsDir}/${shiftId}.json`;
    await writeFile(perShiftPath, JSON.stringify(state, null, 2));

    log.debug({ shiftId, date, shiftMdPath, stateJsonPath }, 'shift log written');

    return { shiftId, date, shiftMdPath, stateJsonPath, state };
  }
}

async function appendMd(path: string, content: string): Promise<void> {
  const sep = '\n\n---\n\n';
  try {
    const existing = await readFile(path, 'utf-8');
    if (existing.trim().length === 0) {
      await writeFile(path, content);
      return;
    }
    await appendFile(path, sep + content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await writeFile(path, content);
      return;
    }
    throw err;
  }
}

/**
 * 列出 logs/ 下所有有 shift 数据的日期，按 ISO 日期降序。
 */
export async function listShiftDates(opts: { logsRoot?: string } = {}): Promise<string[]> {
  const root = opts.logsRoot ?? paths.logsDir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

/**
 * 读取某天的最后一次 state.json。不存在返回 null。
 */
export async function loadLatestShiftState(
  date: string,
  opts: { logsRoot?: string } = {},
): Promise<ShiftState | null> {
  const root = opts.logsRoot ?? paths.logsDir();
  const statePath = `${root}/${date}/state.json`;
  try {
    const raw = await readFile(statePath, 'utf-8');
    return JSON.parse(raw) as ShiftState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 读取某天 shifts/ 子目录下所有 shift 的 state.json，按 startedAt 升序。
 */
export async function loadShiftsForDate(
  date: string,
  opts: { logsRoot?: string } = {},
): Promise<ShiftState[]> {
  const root = opts.logsRoot ?? paths.logsDir();
  const shiftsDir = `${root}/${date}/shifts`;
  let entries;
  try {
    entries = await readdir(shiftsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const states: ShiftState[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    try {
      const raw = await readFile(`${shiftsDir}/${ent.name}`, 'utf-8');
      states.push(JSON.parse(raw) as ShiftState);
    } catch {
      // 跳过坏文件
    }
  }
  return states.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
