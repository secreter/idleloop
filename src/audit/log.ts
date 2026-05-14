import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, paths } from '../storage/paths.js';
import { logger as rootLogger } from '../utils/logger.js';

const log = rootLogger.child({ mod: 'audit' });

/**
 * 审计事件类型。每个有副作用 / 涉及信任决策的关键节点都打一条。
 *
 * 设计取舍：only-append JSONL，每行独立 JSON，便于 `jq` / `grep` 离线分析。
 * 出错时只 log.warn，不抛——审计写失败不能阻塞主流程。
 */
export type AuditEventKind =
  // task 生命周期
  | 'task_started'
  | 'task_finished'
  // worktree
  | 'worktree_created'
  | 'worktree_removed'
  // 安全闸门
  | 'safety_blocked'
  // merge / discard
  | 'auto_merged'
  | 'review_merged'
  | 'review_discarded'
  | 'review_kept'
  // OAuth
  | 'token_refreshed'
  // 系统级
  | 'daemon_started'
  | 'daemon_stopped';

export interface AuditEvent {
  ts: string;
  kind: AuditEventKind;
  /** 主键：通常是 taskId，但 daemon 事件用 pid */
  subject: string;
  /** 任意附加字段；不能含 secret/PII */
  detail?: Record<string, unknown>;
}

export interface AuditWriterOptions {
  /** 测试可注入路径；默认 paths.auditJsonl() */
  filePath?: string;
  /** 测试静默；默认 false（出错走 logger.warn） */
  silent?: boolean;
}

export class AuditWriter {
  constructor(private readonly opts: AuditWriterOptions = {}) {}

  async write(event: Omit<AuditEvent, 'ts'>): Promise<void> {
    const filePath = this.opts.filePath ?? paths.auditJsonl();
    const full: AuditEvent = { ts: new Date().toISOString(), ...event };
    const line = JSON.stringify(full) + '\n';
    try {
      await ensureDir(path.dirname(filePath));
      await appendFile(filePath, line, { mode: 0o600 });
    } catch (err) {
      if (!this.opts.silent) {
        log.warn({ err: (err as Error).message, kind: event.kind }, 'audit append failed');
      }
    }
  }
}

/**
 * 共享单例（生产路径）。测试请用 `new AuditWriter({ filePath })`。
 */
export const auditWriter = new AuditWriter();
