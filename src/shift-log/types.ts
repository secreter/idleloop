import type { Task, TaskResult } from '../types/task.js';
import type { TriggerDecision } from '../trigger/types.js';
import type { QuotaSnapshot } from '../watcher/types.js';

/**
 * 一个 shift（一次 idle session）的完整状态记录。
 *
 * 一次 shift = 一次 daemon 唤醒 + 决策 + 跑完任务。
 * 多次 shift 同一天可以合并到一个 shift.md（追加），但 state.json 仍每次完整写。
 */
export interface ShiftState {
  shiftId: string;
  startedAt: string;
  finishedAt: string;
  /** ISO 日期（本地时区）yyyy-mm-dd，对齐 logs/{date}/ */
  date: string;
  decision: TriggerDecision;
  snapshot: QuotaSnapshot | null;
  /** 真正被 Runner 跑过的任务（含 dry-run、success、各种 abort 等） */
  results: TaskResult[];
  /** Curator 报告，便于回看哪些 strategy 出活 */
  strategies: Array<{
    name: string;
    discovered: number;
    skipped: number;
    error?: string;
  }>;
  /** 总成本 / token 累加，省去 review 时再算一遍 */
  totalCostUsd: number;
  totalTokens: number;
  /** 触发被拦截时（且非 dry-run）的解释 */
  blocked?: {
    blockedBy: NonNullable<TriggerDecision['blockedBy']>;
    reason: string;
  };
}

export interface ShiftRenderInput {
  state: ShiftState;
  /** Curator 返回的原始 tasks，便于在 md 里列出未被 runner 跑过的（理论上不会有，但留口） */
  tasks: Task[];
}
