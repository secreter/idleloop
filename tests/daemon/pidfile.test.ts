import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isAlive,
  readPidStatus,
  removePidFile,
  signalStop,
  writePidFile,
} from '../../src/daemon/pidfile.js';

describe('pidfile', () => {
  let dir: string;
  let pidFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'idleloop-pid-'));
    pidFile = path.join(dir, 'daemon.pid');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('文件不存在时 pid=null alive=false', async () => {
    const s = await readPidStatus({ pidFile });
    expect(s.pid).toBeNull();
    expect(s.alive).toBe(false);
  });

  it('写自身 pid 后 alive=true', async () => {
    await writePidFile({ pid: process.pid, pidFile });
    const s = await readPidStatus({ pidFile });
    expect(s.pid).toBe(process.pid);
    expect(s.alive).toBe(true);
  });

  it('pid 内容非数字 → pid=null', async () => {
    await writeFile(pidFile, 'not-a-number');
    const s = await readPidStatus({ pidFile });
    expect(s.pid).toBeNull();
    expect(s.alive).toBe(false);
  });

  it('已存在且对应进程仍活时拒绝再写（除非 force）', async () => {
    await writePidFile({ pid: process.pid, pidFile });
    await expect(writePidFile({ pid: process.pid + 1, pidFile })).rejects.toThrow(
      /daemon already running/,
    );
    // force：覆盖
    await writePidFile({ pid: 999_999, pidFile, force: true });
    const raw = await readFile(pidFile, 'utf-8');
    expect(raw).toBe('999999');
  });

  it('removePidFile 不存在不抛错', async () => {
    await expect(removePidFile({ pidFile })).resolves.toBeUndefined();
  });

  it('isAlive(自身 pid) 为 true；isAlive(超大 pid) 为 false', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(9_999_999)).toBe(false);
  });

  it('signalStop 给不存在的 pid 返回 false', () => {
    expect(signalStop(9_999_999)).toBe(false);
  });

  it('并发 writePidFile：只有一个成功，另一个抛错', async () => {
    const [a, b] = await Promise.allSettled([
      writePidFile({ pid: process.pid, pidFile }),
      writePidFile({ pid: process.pid + 1, pidFile }),
    ]);
    // 一个 fulfilled 一个 rejected（rejected 是 'already running' 因为 process.pid 自己活）
    const fulfilledCount = [a, b].filter((r) => r.status === 'fulfilled').length;
    expect(fulfilledCount).toBe(1);
  });

  it('文件存在但 pid 已死：wx 失败后清掉重写', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(pidFile, '9999999');
    await writePidFile({ pid: process.pid, pidFile });
    const s = await readPidStatus({ pidFile });
    expect(s.pid).toBe(process.pid);
  });
});
