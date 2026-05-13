import { readFile, unlink, writeFile } from 'node:fs/promises';
import { ensureDir, paths } from '../storage/paths.js';
import path from 'node:path';

export interface PidStatus {
  pid: number | null;
  /** pid 文件指向的进程是否还在跑 */
  alive: boolean;
  /** pid 文件路径 */
  pidFile: string;
}

/**
 * 读 pid 文件，判断进程是否还活着。
 *
 * alive 判断：kill(pid, 0)。仅检查信号路径是否允许，不实际发送信号。
 */
export async function readPidStatus(opts: { pidFile?: string } = {}): Promise<PidStatus> {
  const pidFile = opts.pidFile ?? paths.daemonPid();
  let raw: string;
  try {
    raw = await readFile(pidFile, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { pid: null, alive: false, pidFile };
    }
    throw err;
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { pid: null, alive: false, pidFile };
  }
  return { pid, alive: isAlive(pid), pidFile };
}

/**
 * 写 pid 文件。
 *
 * - force=false（默认）：用 O_EXCL 排他创建（`flag: 'wx'`），消除原先「先 read 后 write」
 *   的 TOCTOU 窗口。已存在则：若对应进程仍活报错；若已死则覆盖（认为是上次崩溃残留）。
 * - force=true：直接覆盖，不做任何检查。给手动覆盖留口。
 */
export async function writePidFile(opts: {
  pid: number;
  pidFile?: string;
  force?: boolean;
}): Promise<{ pidFile: string }> {
  const pidFile = opts.pidFile ?? paths.daemonPid();
  await ensureDir(path.dirname(pidFile));
  if (opts.force) {
    await writeFile(pidFile, String(opts.pid), { mode: 0o600 });
    return { pidFile };
  }
  try {
    await writeFile(pidFile, String(opts.pid), { mode: 0o600, flag: 'wx' });
    return { pidFile };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const existing = await readPidStatus({ pidFile });
    if (existing.alive) {
      throw new Error(
        `daemon already running (pid ${existing.pid}); remove ${pidFile} to override`,
      );
    }
    await unlink(pidFile);
    await writeFile(pidFile, String(opts.pid), { mode: 0o600, flag: 'wx' });
    return { pidFile };
  }
}

export async function removePidFile(opts: { pidFile?: string } = {}): Promise<void> {
  const pidFile = opts.pidFile ?? paths.daemonPid();
  try {
    await unlink(pidFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 给指定 pid 发 SIGTERM。返回是否真的发出去了。
 */
export function signalStop(pid: number, sig: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}
