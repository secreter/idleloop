/**
 * 核心类型聚合出口。模块自己的类型在各自目录定义，这里只 re-export 已实现的。
 *
 * 随着 trigger / curator / runner 等模块落地，会逐步追加 export。
 */

export type { Task, TaskResult, TaskStatus } from './task.js';
export { TaskSchema } from './task.js';

export type { Config, TriggerPolicyConfig, ProjectConfig } from '../storage/config.js';
export { ConfigSchema } from '../storage/config.js';

export type {
  ExtraUsageInfo,
  QuotaSnapshot,
  QuotaSnapshotSource,
  QuotaWindow,
} from '../watcher/types.js';

export type { TriggerBlockReason, TriggerDecision, UserActivityCheck } from '../trigger/types.js';
