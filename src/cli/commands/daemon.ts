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
import { listShiftDates, loadLatestShiftState, type ShiftState } from '../../shift-log/index.js';
import { ConfigNotFoundError, loadConfig, type Config } from '../../storage/config.js';
import { isInQuietHours } from '../../trigger/policy.js';
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

export interface RunDaemonStatusDeps extends RunDaemonDeps {
  /** 测试注入：跳过 config 读盘 */
  configLoader?: () => Promise<Config>;
  /** 测试注入：跳过 shift log 读盘 */
  loadLatestShift?: () => Promise<ShiftState | null>;
  /** 测试注入：固定 now */
  now?: () => Date;
}

/**
 * `idleloop daemon status` — 输出当前是否在跑 + 上一次 shift 概览 + 当前 gate 状态 +
 * 下次 poll 估算时刻。
 */
export async function runDaemonStatus(
  deps: RunDaemonStatusDeps = {},
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

  await printDaemonContext(print, deps);

  return { running: status.alive, pid: status.pid };
}

async function printDaemonContext(
  print: (s: string) => void,
  deps: RunDaemonStatusDeps,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();

  let config: Config | null = null;
  try {
    config = deps.configLoader ? await deps.configLoader() : await loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigNotFoundError)) {
      print(styleText('dim', `  config: failed to read (${(err as Error).message})`));
    }
    // 没 config 时其它信息也展示不出来，提前返回
    return;
  }

  const latest = deps.loadLatestShift ? await deps.loadLatestShift() : await loadMostRecentShift();
  if (latest) {
    const started = new Date(latest.startedAt);
    const ago = formatAgo(now.getTime() - started.getTime());
    const triggeredCount = latest.results.filter((r) => r.status === 'success').length;
    const tag = latest.decision.triggered
      ? styleText('green', '✓ triggered')
      : styleText('dim', `· blocked[${latest.decision.blockedBy ?? 'n/a'}]`);
    print(
      `  last shift: ${tag}  ${formatLocalTime(started)} (${ago} ago) · ` +
        `${triggeredCount} ok / ${latest.results.length} total · $${latest.totalCostUsd.toFixed(2)}`,
    );
  } else {
    print(styleText('dim', '  last shift: (none recorded yet)'));
  }

  const gateLine = describeGate(config, now);
  print(`  gate: ${gateLine}`);

  const intervalMin = config.watcher.poll_interval_minutes;
  print(
    styleText(
      'dim',
      `  poll interval: ${intervalMin}min · next poll: ~${intervalMin}min after last (no exact timer available)`,
    ),
  );
}

async function loadMostRecentShift(): Promise<ShiftState | null> {
  const dates = await listShiftDates();
  for (const date of dates) {
    const s = await loadLatestShiftState(date);
    if (s) return s;
  }
  return null;
}

function describeGate(config: Config, now: Date): string {
  if (config.trigger.quiet_hours && isInQuietHours(now, config.trigger.quiet_hours)) {
    const end = config.trigger.quiet_hours.end;
    return styleText('yellow', `quiet_hours active (lifts at ${String(end).padStart(2, '0')}:00)`);
  }
  if (config.trigger.system_idle?.enabled) {
    return styleText(
      'green',
      `open (system_idle bypass available after ${config.trigger.system_idle.min_minutes}min afk)`,
    );
  }
  return styleText('green', 'open (no quiet_hours match; pending policy + activity checks)');
}

function formatAgo(ms: number): string {
  if (ms < 0) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}min`;
  if (ms < 86_400_000) return `${(ms / 3600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function formatLocalTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${month}-${day} ${hh}:${mm}`;
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
