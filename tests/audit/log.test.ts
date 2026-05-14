import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditWriter } from '../../src/audit/index.js';

describe('AuditWriter', () => {
  let dir: string;
  let auditPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'idleloop-audit-'));
    auditPath = path.join(dir, 'audit.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('append-only：连续写多条 → 文件按行 append', async () => {
    const w = new AuditWriter({ filePath: auditPath });
    await w.write({ kind: 'task_started', subject: 'task-A' });
    await w.write({
      kind: 'task_finished',
      subject: 'task-A',
      detail: { status: 'success', costUsd: 0.1 },
    });
    const raw = await readFile(auditPath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as { kind: string; ts: string });
    expect(parsed[0]?.kind).toBe('task_started');
    expect(parsed[1]?.kind).toBe('task_finished');
    expect(typeof parsed[0]?.ts).toBe('string');
  });

  it('每条记录都有 ISO 时间戳', async () => {
    const w = new AuditWriter({ filePath: auditPath });
    await w.write({ kind: 'daemon_started', subject: 'pid-123' });
    const raw = await readFile(auditPath, 'utf-8');
    const parsed = JSON.parse(raw.trim()) as { ts: string };
    expect(new Date(parsed.ts).toString()).not.toBe('Invalid Date');
  });

  it('写失败不抛错（路径含 null byte 时静默 warn）', async () => {
    // 用一个肯定写不进去的 path（含 NUL 触发 EINVAL）
    const w = new AuditWriter({ filePath: '/tmp/\0invalid\0path/audit.jsonl', silent: true });
    await expect(w.write({ kind: 'task_started', subject: 'x' })).resolves.toBeUndefined();
  });

  it('detail 字段保留', async () => {
    const w = new AuditWriter({ filePath: auditPath });
    await w.write({
      kind: 'review_merged',
      subject: 'task-X',
      detail: { branch: 'idleloop/2026-05-13/x', baseBranch: 'main' },
    });
    const parsed = JSON.parse((await readFile(auditPath, 'utf-8')).trim()) as {
      detail?: { branch: string };
    };
    expect(parsed.detail?.branch).toBe('idleloop/2026-05-13/x');
  });
});
