import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUnit,
} from '../../src/cli/commands/daemon.js';
import { writePidFile } from '../../src/daemon/pidfile.js';
import { parseConfig } from '../../src/storage/config.js';

describe('runDaemonStart', () => {
  let pidFile: string;
  let dir: string;
  const out: string[] = [];
  const print = (s: string) => out.push(s);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'idleloop-daemon-'));
    pidFile = path.join(dir, 'daemon.pid');
    out.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('快速跑 1 迭代后正常退出 + pid 文件被清理', async () => {
    const cfg = parseConfig({});
    const loop = vi.fn().mockResolvedValue({
      iterations: 1,
      stoppedReason: 'max_iterations',
    });
    const r = await runDaemonStart(
      { maxIterations: 1, intervalMs: 5 },
      { config: cfg, print, pidFile, loop },
    );
    expect(r.iterations).toBe(1);
    expect(loop).toHaveBeenCalledTimes(1);
    const { stat } = await import('node:fs/promises');
    await expect(stat(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('pidFile=false 不写 pid 文件', async () => {
    const cfg = parseConfig({});
    const loop = vi.fn().mockResolvedValue({
      iterations: 1,
      stoppedReason: 'max_iterations',
    });
    await runDaemonStart({ maxIterations: 1 }, { config: cfg, print, pidFile: false, loop });
    expect(loop).toHaveBeenCalledTimes(1);
  });
});

describe('runDaemonStop', () => {
  let pidFile: string;
  let dir: string;
  const out: string[] = [];
  const print = (s: string) => out.push(s);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'idleloop-daemon-stop-'));
    pidFile = path.join(dir, 'daemon.pid');
    out.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('pidFile 不存在时返回 stopped=false', async () => {
    const r = await runDaemonStop({}, { pidFile, print });
    expect(r.stopped).toBe(false);
    expect(r.pid).toBeNull();
    expect(out.join('\n')).toMatch(/no pid file/);
  });

  it('stale pid 文件：自动清理', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(pidFile, '9999999');
    const r = await runDaemonStop({}, { pidFile, print });
    expect(r.stopped).toBe(false);
    expect(r.detail).toMatch(/stale pid removed/);
  });

  it('真实活进程：发 SIGTERM 后被 mock 标记退出', async () => {
    // 让 writePidFile 跳过 alive 校验：直接 force 写
    await writePidFile({ pid: process.pid, pidFile, force: true });
    const killFn = vi.fn().mockReturnValue(true);
    const waitForStop = vi.fn().mockResolvedValue(true);
    const r = await runDaemonStop({ waitMs: 100 }, { pidFile, print, killFn, waitForStop });
    expect(killFn).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(r.stopped).toBe(true);
    expect(r.detail).toBe('graceful exit');
  });

  it('SIGTERM 后超时：升级到 SIGKILL', async () => {
    await writePidFile({ pid: process.pid, pidFile, force: true });
    const killCalls: Array<[number, string | undefined]> = [];
    const killFn = vi.fn().mockImplementation((pid: number, sig?: NodeJS.Signals) => {
      killCalls.push([pid, sig]);
      return true;
    });
    const waitForStop = vi.fn().mockResolvedValue(false);
    const r = await runDaemonStop({ waitMs: 100 }, { pidFile, print, killFn, waitForStop });
    expect(killCalls.map((c) => c[1])).toContain('SIGTERM');
    expect(killCalls.map((c) => c[1])).toContain('SIGKILL');
    expect(r.detail).toMatch(/SIGKILL/);
  });
});

describe('runDaemonStatus + runDaemonUnit', () => {
  it('status 报告未跑', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idleloop-daemon-st-'));
    const out: string[] = [];
    try {
      const r = await runDaemonStatus({
        pidFile: `${dir}/daemon.pid`,
        print: (s) => out.push(s),
        configLoader: async () => parseConfig({}),
        loadLatestShift: async () => null,
        now: () => new Date(2026, 4, 13, 3, 0, 0),
      });
      expect(r.running).toBe(false);
      expect(out.join('\n')).toMatch(/not running/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('status 在 quiet_hours 内：gate 行显示 quiet_hours active + lifts at', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idleloop-daemon-st-'));
    const out: string[] = [];
    try {
      // 默认 quiet 8-22，中午 12 点必在区间
      const noon = new Date(2026, 4, 13, 12, 0, 0);
      await runDaemonStatus({
        pidFile: `${dir}/daemon.pid`,
        print: (s) => out.push(s),
        configLoader: async () => parseConfig({}),
        loadLatestShift: async () => null,
        now: () => noon,
      });
      expect(out.join('\n')).toMatch(/quiet_hours active/);
      expect(out.join('\n')).toMatch(/22:00/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('status 在 quiet_hours 外：gate 行显示 open', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idleloop-daemon-st-'));
    const out: string[] = [];
    try {
      const night = new Date(2026, 4, 13, 3, 0, 0);
      await runDaemonStatus({
        pidFile: `${dir}/daemon.pid`,
        print: (s) => out.push(s),
        configLoader: async () => parseConfig({}),
        loadLatestShift: async () => null,
        now: () => night,
      });
      expect(out.join('\n')).toMatch(/gate:.*open/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('status 含 last shift 概览', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idleloop-daemon-st-'));
    const out: string[] = [];
    try {
      const now = new Date(2026, 4, 13, 3, 0, 0);
      const startedAt = new Date(now.getTime() - 30 * 60_000);
      await runDaemonStatus({
        pidFile: `${dir}/daemon.pid`,
        print: (s) => out.push(s),
        configLoader: async () => parseConfig({}),
        loadLatestShift: async () => ({
          shiftId: 'shift-XYZ',
          date: '2026-05-13',
          startedAt: startedAt.toISOString(),
          finishedAt: now.toISOString(),
          decision: { triggered: true, reason: 'ok' },
          snapshot: null,
          results: [
            {
              taskId: 't1',
              status: 'success',
              branchName: 'b',
              worktreePath: '/x',
              tokensSpent: 100,
              costUsd: 0.5,
              durationMs: 1000,
              diffLinesChanged: 1,
              filesChanged: 1,
              startedAt: startedAt.toISOString(),
              finishedAt: now.toISOString(),
            },
          ],
          strategies: [],
          totalCostUsd: 0.5,
          totalTokens: 100,
        }),
        now: () => now,
      });
      const all = out.join('\n');
      expect(all).toMatch(/last shift/);
      expect(all).toMatch(/triggered/);
      expect(all).toMatch(/1 ok/);
      expect(all).toMatch(/\$0\.50/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('unit 命令输出当前平台 unit 内容', () => {
    const out: string[] = [];
    const r = runDaemonUnit({ print: (s) => out.push(s) });
    expect(['systemd', 'launchd']).toContain(r.kind);
    expect(out.join('\n').length).toBeGreaterThan(50);
  });
});
