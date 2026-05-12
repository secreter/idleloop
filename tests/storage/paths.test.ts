import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDir, expandHome, paths, todayDateString } from '../../src/storage/paths.js';

describe('paths', () => {
  const originalHome = process.env['HOME'];
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(path.join(tmpdir(), 'idleloop-paths-'));
    process.env['HOME'] = testHome;
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await rm(testHome, { recursive: true, force: true });
  });

  it('userDataRoot 在 HOME/idleloop', () => {
    expect(paths.userDataRoot()).toBe(path.join(testHome, 'idleloop'));
  });

  it('stateRoot 在 HOME/.idleloop', () => {
    expect(paths.stateRoot()).toBe(path.join(testHome, '.idleloop'));
  });

  it('configFile 在 userDataRoot/config.yml', () => {
    expect(paths.configFile()).toBe(path.join(testHome, 'idleloop', 'config.yml'));
  });

  it('queueDir 在 userDataRoot/queue', () => {
    expect(paths.queueDir()).toBe(path.join(testHome, 'idleloop', 'queue'));
  });

  it('worktreeFor 拼出 task 专属目录', () => {
    expect(paths.worktreeFor('task-abc')).toBe(
      path.join(testHome, '.idleloop', 'worktrees', 'task-abc'),
    );
  });

  it('logsForDate 拼出 logs/{date}', () => {
    expect(paths.logsForDate('2026-05-13')).toBe(
      path.join(testHome, '.idleloop', 'logs', '2026-05-13'),
    );
  });

  it('claudeCredentials 在 HOME/.claude/.credentials.json', () => {
    expect(paths.claudeCredentials()).toBe(path.join(testHome, '.claude', '.credentials.json'));
  });

  describe('ensureDir', () => {
    it('递归创建嵌套目录', async () => {
      const target = path.join(testHome, 'a', 'b', 'c');
      await ensureDir(target);
      const s = await stat(target);
      expect(s.isDirectory()).toBe(true);
    });

    it('目录已存在不报错', async () => {
      const target = path.join(testHome, 'x');
      await ensureDir(target);
      await ensureDir(target); // 第二次应静默成功
      const s = await stat(target);
      expect(s.isDirectory()).toBe(true);
    });
  });

  describe('expandHome', () => {
    it('展开 ~/foo', () => {
      expect(expandHome('~/foo')).toBe(path.join(testHome, 'foo'));
    });

    it('展开单独的 ~', () => {
      expect(expandHome('~')).toBe(testHome);
    });

    it('不展开 ~user', () => {
      // 我们不解析 ~user，原样返回
      expect(expandHome('~bob/foo')).toBe('~bob/foo');
    });

    it('不影响绝对路径', () => {
      expect(expandHome('/abs/path')).toBe('/abs/path');
    });

    it('不影响相对路径', () => {
      expect(expandHome('rel/path')).toBe('rel/path');
    });
  });

  describe('todayDateString', () => {
    it('格式 yyyy-mm-dd', () => {
      const d = new Date(2026, 4, 13, 10, 30, 0); // 2026-05-13 本地时区
      expect(todayDateString(d)).toBe('2026-05-13');
    });

    it('1 月 1 日补零', () => {
      const d = new Date(2026, 0, 1);
      expect(todayDateString(d)).toBe('2026-01-01');
    });
  });
});
