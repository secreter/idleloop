import type { Task } from '../types/task.js';

/**
 * 任务发现策略。每个 strategy 对应一个任务来源类型：
 *   T1 = 用户书架（手写 md）
 *   T2 = 长期目标拆解
 *   T3 = 项目嗅探（audit/test/book-expand）
 *   T4 = AI 自主提案
 */
export interface CuratorStrategy {
  readonly name: string;
  readonly source: Task['source'];
  discover(): Promise<Task[]>;
}

/**
 * Curator.gather 的结果。任务列表 + 每个 strategy 的诊断信息。
 */
export interface CuratorReport {
  tasks: Task[];
  perStrategy: Array<{
    name: string;
    source: Task['source'];
    discovered: number;
    skipped: number;
    error?: string;
  }>;
}
