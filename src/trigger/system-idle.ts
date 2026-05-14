import { execa } from 'execa';
import { platform } from 'node:os';
import { logger as rootLogger } from '../utils/logger.js';

const log = rootLogger.child({ mod: 'trigger', sub: 'system-idle' });

export interface SystemIdleResult {
  /** 当前系统已闲置多少毫秒。-1 表示无法检测（未授权、无工具、不支持平台） */
  idleMs: number;
  /** 检测来源：xprintidle / loginctl / ioreg / unknown */
  source: 'xprintidle' | 'loginctl' | 'ioreg' | 'unknown';
}

export interface DetectIdleOptions {
  /** 测试注入：覆盖 platform()，便于在 Linux 上测 macOS 分支 */
  platformFn?: () => NodeJS.Platform;
  /** 测试注入：execa 替身，按命令名分发 */
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;
}

/**
 * 探测当前系统已经闲置了多久。
 *
 * 检测策略（按平台）：
 *   - Linux：优先 `xprintidle`（毫秒，X11 / Mutter），失败 fallback 到
 *     `loginctl show-session $XDG_SESSION_ID -p IdleHint -p IdleSinceHint`
 *   - macOS：`ioreg -c IOHIDSystem` 取 HIDIdleTime（纳秒）
 *   - 其它：返回 idleMs=-1
 *
 * 设计取舍：不引入额外的 C++ 原生模块。100% 走子进程 + 标准 CLI。
 * 用户没装 xprintidle 时检测失败是正常的，把这种情况当作「未知，保守不放行」。
 */
export async function detectSystemIdle(opts: DetectIdleOptions = {}): Promise<SystemIdleResult> {
  const plat = (opts.platformFn ?? platform)();
  const exec = opts.exec ?? defaultExec;

  if (plat === 'darwin') {
    return tryIoreg(exec);
  }
  if (plat === 'linux') {
    const xp = await tryXprintidle(exec);
    if (xp.idleMs >= 0) return xp;
    return tryLoginctl(exec);
  }
  return { idleMs: -1, source: 'unknown' };
}

async function tryXprintidle(
  exec: NonNullable<DetectIdleOptions['exec']>,
): Promise<SystemIdleResult> {
  try {
    const { stdout, exitCode } = await exec('xprintidle', []);
    if (exitCode !== 0) return { idleMs: -1, source: 'xprintidle' };
    const ms = parseInt(stdout.trim(), 10);
    if (!Number.isFinite(ms) || ms < 0) return { idleMs: -1, source: 'xprintidle' };
    return { idleMs: ms, source: 'xprintidle' };
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'xprintidle unavailable');
    return { idleMs: -1, source: 'xprintidle' };
  }
}

async function tryLoginctl(
  exec: NonNullable<DetectIdleOptions['exec']>,
): Promise<SystemIdleResult> {
  // 思路：loginctl 不直接给「已闲置多久」，只给 IdleHint=yes/no + IdleSinceHint=unix-micro.
  // 取当前 session（XDG_SESSION_ID）下的两个属性。
  const sessionId = process.env['XDG_SESSION_ID'] ?? 'self';
  try {
    const { stdout, exitCode } = await exec('loginctl', [
      'show-session',
      sessionId,
      '-p',
      'IdleHint',
      '-p',
      'IdleSinceHint',
    ]);
    if (exitCode !== 0) return { idleMs: -1, source: 'loginctl' };
    const lines = stdout.split('\n').filter(Boolean);
    const data: Record<string, string> = {};
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      data[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (data['IdleHint'] !== 'yes') return { idleMs: 0, source: 'loginctl' };
    const sinceMicros = parseInt(data['IdleSinceHint'] ?? '0', 10);
    if (!Number.isFinite(sinceMicros) || sinceMicros <= 0) {
      return { idleMs: -1, source: 'loginctl' };
    }
    const idleMs = Math.max(0, Date.now() - Math.floor(sinceMicros / 1000));
    return { idleMs, source: 'loginctl' };
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'loginctl unavailable');
    return { idleMs: -1, source: 'loginctl' };
  }
}

async function tryIoreg(exec: NonNullable<DetectIdleOptions['exec']>): Promise<SystemIdleResult> {
  try {
    const { stdout, exitCode } = await exec('ioreg', ['-c', 'IOHIDSystem']);
    if (exitCode !== 0) return { idleMs: -1, source: 'ioreg' };
    const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
    if (!match) return { idleMs: -1, source: 'ioreg' };
    // HIDIdleTime 单位：纳秒
    const ns = BigInt(match[1] ?? '0');
    const ms = Number(ns / 1_000_000n);
    return { idleMs: ms, source: 'ioreg' };
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'ioreg unavailable');
    return { idleMs: -1, source: 'ioreg' };
  }
}

async function defaultExec(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const r = await execa(cmd, args, { timeout: 3_000 });
    return { stdout: r.stdout, exitCode: r.exitCode ?? 0 };
  } catch (err) {
    const e = err as { exitCode?: number; stdout?: string; code?: string };
    if (e.code === 'ENOENT') throw err; // 让上层 catch 当成 unavailable
    return { stdout: e.stdout ?? '', exitCode: e.exitCode ?? -1 };
  }
}
