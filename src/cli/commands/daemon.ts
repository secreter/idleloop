import { styleText } from 'node:util';
import {
  generateUnitForCurrentPlatform,
  isAlive,
  readPidStatus,
  removePidFile,
  runDaemonLoop,
  signalStop,
  writePidFile,
  type DaemonLoopResult,
} from '../../daemon/index.js';
import { loadConfig, type Config } from '../../storage/config.js';
import { logger as rootLogger } from '../../utils/logger.js';

const log = rootLogger.child({ mod: 'daemon-cli' });

export interface RunDaemonOptions {
  /** 在前台跑（不 fork），用于 systemd / launchd / 调试 */
  foreground?: boolean;
  /** 限制最多迭代次数（测试 / one-shot） */
  maxIterations?: number;
  /** 自定义 poll 间隔（毫秒） */
  intervalMs?: number;
}

export interface RunDaemonDeps {
  /** 测试注入 */
  config?: Config;
  /** 测试注入：捕获 print 输出 */
  print?: (s: string) => void;
  /** 测试注入：跳过实际写 pid 文件 */
  pidFile?: string | false;
  /** 控制信号注入（测试用） */
  signal?: AbortSignal;
  /** loop 注入 */
  loop?: typeof runDaemonLoop;
}

/**
 * `idleloop daemon start [--foreground]`
 *
 * 设计取舍：不做 double-fork。让 systemd / launchd 处理后台化。
 * 前景模式：直接 await loop；适合容器、systemd Type=simple、调试。
 */
export async function runDaemonStart(
  opts: RunDaemonOptions = {},
  deps: RunDaemonDeps = {},
): Promise<DaemonLoopResult> {
  const print = deps.print ?? ((s: string) => console.log(s));
  const config = deps.config ?? (await loadConfig());

  if (deps.pidFile !== false) {
    const pidFile = typeof deps.pidFile === 'string' ? deps.pidFile : undefined;
    await writePidFile({ pid: process.pid, ...(pidFile ? { pidFile } : {}) });
  }

  print(styleText('green', `daemon starting (pid=${process.pid})`));
  print(
    styleText(
      'dim',
      `poll every ${config.watcher.poll_interval_minutes}min · quiet hours ${
        config.trigger.quiet_hours
          ? `${config.trigger.quiet_hours.start}-${config.trigger.quiet_hours.end}`
          : 'disabled'
      }`,
    ),
  );

  const runOpts: Parameters<typeof runDaemonLoop>[0] = {
    config,
    ...(opts.intervalMs != null ? { intervalMs: opts.intervalMs } : {}),
    ...(opts.maxIterations != null ? { maxIterations: opts.maxIterations } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
  const loopFn = deps.loop ?? runDaemonLoop;
  try {
    const result = await loopFn(runOpts);
    print(
      styleText(
        'dim',
        `daemon loop ended: ${result.stoppedReason} after ${result.iterations} iteration(s)`,
      ),
    );
    return result;
  } finally {
    if (deps.pidFile !== false) {
      const pidFile = typeof deps.pidFile === 'string' ? deps.pidFile : undefined;
      await removePidFile(pidFile ? { pidFile } : {});
    }
  }
}

export interface RunDaemonStopOptions {
  /** 等待进程退出的最长时间（毫秒），默认 5000 */
  waitMs?: number;
}

export interface RunDaemonStopDeps {
  pidFile?: string;
  print?: (s: string) => void;
  killFn?: (pid: number, sig?: NodeJS.Signals) => boolean;
  /** wait 实现注入（测试加速） */
  waitForStop?: (pid: number, waitMs: number) => Promise<boolean>;
}

/**
 * `idleloop daemon stop` — 给守护进程发 SIGTERM 并等它退出。
 */
export async function runDaemonStop(
  opts: RunDaemonStopOptions = {},
  deps: RunDaemonStopDeps = {},
): Promise<{ stopped: boolean; pid: number | null; detail: string }> {
  const print = deps.print ?? ((s: string) => console.log(s));
  const pidFile = deps.pidFile ?? undefined;
  const status = await readPidStatus(pidFile ? { pidFile } : {});

  if (!status.pid) {
    print(styleText('yellow', `no pid file at ${status.pidFile}; daemon not running`));
    return { stopped: false, pid: null, detail: 'no pid file' };
  }
  if (!status.alive) {
    print(styleText('yellow', `stale pid file: pid ${status.pid} is not alive; removing`));
    await removePidFile(pidFile ? { pidFile } : {});
    return { stopped: false, pid: status.pid, detail: 'stale pid removed' };
  }

  const kill = deps.killFn ?? signalStop;
  const sent = kill(status.pid, 'SIGTERM');
  if (!sent) {
    print(styleText('yellow', `pid ${status.pid} not found when sending SIGTERM`));
    await removePidFile(pidFile ? { pidFile } : {});
    return { stopped: true, pid: status.pid, detail: 'no such process' };
  }

  const waitMs = opts.waitMs ?? 5_000;
  const waitFn = deps.waitForStop ?? defaultWaitForStop;
  const ok = await waitFn(status.pid, waitMs);
  if (ok) {
    await removePidFile(pidFile ? { pidFile } : {});
    print(styleText('green', `daemon stopped (pid ${status.pid})`));
    return { stopped: true, pid: status.pid, detail: 'graceful exit' };
  }
  log.warn({ pid: status.pid }, 'daemon did not exit within timeout; sending SIGKILL');
  kill(status.pid, 'SIGKILL');
  await removePidFile(pidFile ? { pidFile } : {});
  print(styleText('red', `daemon force-killed (pid ${status.pid})`));
  return { stopped: true, pid: status.pid, detail: 'SIGKILL after timeout' };
}

async function defaultWaitForStop(pid: number, waitMs: number): Promise<boolean> {
  const interval = 100;
  let elapsed = 0;
  while (elapsed < waitMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, interval));
    elapsed += interval;
  }
  return !isAlive(pid);
}

/**
 * `idleloop daemon status` — 输出当前是否在跑 + 配置 + 上一次 shift 概览。
 */
export async function runDaemonStatus(
  deps: RunDaemonDeps = {},
): Promise<{ running: boolean; pid: number | null }> {
  const print = deps.print ?? ((s: string) => console.log(s));
  const pidFile = typeof deps.pidFile === 'string' ? deps.pidFile : undefined;
  const status = await readPidStatus(pidFile ? { pidFile } : {});
  if (status.alive) {
    print(styleText('green', `daemon running (pid ${status.pid})`));
  } else if (status.pid != null) {
    print(styleText('yellow', `pid file exists but pid ${status.pid} is dead (stale)`));
  } else {
    print(styleText('dim', `daemon not running (no pid file at ${status.pidFile})`));
  }
  return { running: status.alive, pid: status.pid };
}

/**
 * `idleloop daemon unit` — 打印当前平台的 unit 文件内容，让用户重定向到合适位置。
 */
export function runDaemonUnit(deps: RunDaemonDeps = {}): { kind: string; installPath: string } {
  const print = deps.print ?? ((s: string) => console.log(s));
  const u = generateUnitForCurrentPlatform();
  print(u.content);
  return { kind: u.kind, installPath: u.installPath };
}
