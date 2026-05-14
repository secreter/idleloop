import { describe, expect, it, vi } from 'vitest';
import { detectSystemIdle } from '../../src/trigger/system-idle.js';

describe('detectSystemIdle', () => {
  it('linux + xprintidle 成功：返回毫秒 + source=xprintidle', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === 'xprintidle') return { stdout: '123456\n', exitCode: 0 };
      return { stdout: '', exitCode: 1 };
    });
    const r = await detectSystemIdle({ platformFn: () => 'linux', exec });
    expect(r.idleMs).toBe(123456);
    expect(r.source).toBe('xprintidle');
  });

  it('linux + xprintidle 缺失 → fallback 到 loginctl', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === 'xprintidle') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (cmd === 'loginctl') {
        return {
          stdout: `IdleHint=yes\nIdleSinceHint=${(Date.now() - 60_000) * 1000}\n`,
          exitCode: 0,
        };
      }
      return { stdout: '', exitCode: 1 };
    });
    const r = await detectSystemIdle({ platformFn: () => 'linux', exec });
    expect(r.source).toBe('loginctl');
    expect(r.idleMs).toBeGreaterThanOrEqual(60_000 - 1000);
  });

  it('linux + loginctl IdleHint=no → idleMs=0', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === 'xprintidle') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (cmd === 'loginctl') {
        return { stdout: 'IdleHint=no\nIdleSinceHint=0\n', exitCode: 0 };
      }
      return { stdout: '', exitCode: 1 };
    });
    const r = await detectSystemIdle({ platformFn: () => 'linux', exec });
    expect(r.idleMs).toBe(0);
    expect(r.source).toBe('loginctl');
  });

  it('macOS + ioreg 解析 HIDIdleTime', async () => {
    const fakeStdout = `
      | +-o IOHIDSystem
      |   {
      |     "HIDIdleTime" = 60000000000
      |     "EvNeedLock" = No
      |   }
    `;
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === 'ioreg') return { stdout: fakeStdout, exitCode: 0 };
      return { stdout: '', exitCode: 1 };
    });
    const r = await detectSystemIdle({ platformFn: () => 'darwin', exec });
    expect(r.source).toBe('ioreg');
    // 60_000_000_000 纳秒 = 60_000 毫秒
    expect(r.idleMs).toBe(60_000);
  });

  it('macOS + ioreg 输出无 HIDIdleTime → idleMs=-1', async () => {
    const exec = vi.fn(async () => ({ stdout: 'no match here', exitCode: 0 }));
    const r = await detectSystemIdle({ platformFn: () => 'darwin', exec });
    expect(r.idleMs).toBe(-1);
  });

  it('未支持的平台 → idleMs=-1', async () => {
    const exec = vi.fn(async () => ({ stdout: '', exitCode: 0 }));
    const r = await detectSystemIdle({ platformFn: () => 'win32', exec });
    expect(r.idleMs).toBe(-1);
    expect(r.source).toBe('unknown');
  });

  it('xprintidle 输出非数字且 loginctl 不可用 → idleMs=-1', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === 'xprintidle') return { stdout: 'not-a-number\n', exitCode: 0 };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const r = await detectSystemIdle({ platformFn: () => 'linux', exec });
    expect(r.idleMs).toBe(-1);
  });
});
