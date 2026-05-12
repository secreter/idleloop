import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkUserActivity, getMostRecentClaudeActivity } from '../../src/trigger/user-activity.js';

describe('user-activity', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'idleloop-ua-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function makeFile(rel: string, mtime: Date): Promise<void> {
    const p = path.join(testDir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, 'x');
    await utimes(p, mtime, mtime);
  }

  it('目录不存在返回 null', async () => {
    const r = await getMostRecentClaudeActivity({
      dir: path.join(testDir, 'does-not-exist'),
    });
    expect(r).toBeNull();
  });

  it('空目录返回 null（无文件无子项）', async () => {
    const r = await getMostRecentClaudeActivity({ dir: testDir });
    expect(r).toBeNull();
  });

  it('返回所有文件中最大的 mtime', async () => {
    await makeFile('proj-a/session-1.jsonl', new Date('2026-05-13T10:00:00Z'));
    await makeFile('proj-a/session-2.jsonl', new Date('2026-05-13T15:00:00Z'));
    await makeFile('proj-b/session.jsonl', new Date('2026-05-13T12:00:00Z'));
    const r = await getMostRecentClaudeActivity({ dir: testDir });
    expect(r?.toISOString()).toBe('2026-05-13T15:00:00.000Z');
  });

  it('maxDepth=0 只看根目录自身', async () => {
    await makeFile('proj/inner.jsonl', new Date('2030-01-01T00:00:00Z'));
    const r = await getMostRecentClaudeActivity({ dir: testDir, maxDepth: 0 });
    expect(r).toBeInstanceOf(Date);
    // 子目录里的 2030 文件不应该被看到
    expect(r!.getFullYear()).toBeLessThan(2030);
  });

  describe('checkUserActivity', () => {
    it('最近 5 分钟内活动 → active=true', async () => {
      const now = new Date('2026-05-13T10:00:00Z');
      await makeFile('p/f.jsonl', new Date(now.getTime() - 2 * 60_000));
      const r = await checkUserActivity(5, { dir: testDir, now });
      expect(r.active).toBe(true);
      expect(r.minutesSince).toBeCloseTo(2, 0);
    });

    it('最近 5 分钟外活动 → active=false', async () => {
      const now = new Date('2026-05-13T10:00:00Z');
      await makeFile('p/f.jsonl', new Date(now.getTime() - 10 * 60_000));
      const r = await checkUserActivity(5, { dir: testDir, now });
      expect(r.active).toBe(false);
      expect(r.minutesSince).toBeCloseTo(10, 0);
    });

    it('目录不存在 → active=false', async () => {
      const r = await checkUserActivity(5, { dir: path.join(testDir, 'nope') });
      expect(r.active).toBe(false);
      expect(r.lastActivityAt).toBeNull();
      expect(r.minutesSince).toBeNull();
    });

    it('刚好等于阈值不算 active（严格小于）', async () => {
      const now = new Date('2026-05-13T10:00:00Z');
      await makeFile('p/f.jsonl', new Date(now.getTime() - 5 * 60_000));
      const r = await checkUserActivity(5, { dir: testDir, now });
      expect(r.active).toBe(false);
    });
  });
});
