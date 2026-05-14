import { describe, expect, it } from 'vitest';
import { runWhy } from '../../src/cli/commands/why.js';
import { parseConfig } from '../../src/storage/config.js';
import type { QuotaSnapshot } from '../../src/watcher/types.js';

function snapshot(now: Date, fiveRem: number, fiveResetsInMin: number): QuotaSnapshot {
  return {
    fiveHour: {
      utilizationPct: 100 - fiveRem,
      remainingPct: fiveRem,
      resetsAt: new Date(now.getTime() + fiveResetsInMin * 60_000),
    },
    sevenDay: {
      utilizationPct: 0,
      remainingPct: 100,
      resetsAt: new Date(now.getTime() + 7 * 86_400_000),
    },
    sevenDayOpus: null,
    sevenDaySonnet: null,
    sevenDayCowork: null,
    extraUsage: null,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    fetchedAt: now,
    source: 'oauth',
  };
}

describe('runWhy', () => {
  it('quota fetch 失败 → blockedBy=invalid_snapshot', async () => {
    const now = new Date(2026, 4, 13, 3, 0, 0);
    const out: string[] = [];
    const r = await runWhy({
      config: parseConfig({}),
      watcher: {
        snapshot: async () => {
          throw new Error('network');
        },
      },
      print: (s) => out.push(s),
      now: () => now,
    });
    expect(r.triggered).toBe(false);
    expect(r.blockedBy).toBe('invalid_snapshot');
    expect(out.join('\n')).toMatch(/Cannot evaluate/);
  });

  it('quiet hours 内 → blockedBy=quiet_hours', async () => {
    const noon = new Date(2026, 4, 13, 12, 0, 0);
    const out: string[] = [];
    const r = await runWhy({
      config: parseConfig({}),
      watcher: { snapshot: async () => snapshot(noon, 50, 30) },
      checkActivity: async () => ({ active: false, lastActivityAt: null, minutesSince: null }),
      print: (s) => out.push(s),
      now: () => noon,
    });
    expect(r.triggered).toBe(false);
    expect(r.blockedBy).toBe('quiet_hours');
    expect(out.join('\n')).toMatch(/quiet_hours/);
  });

  it('凌晨 + 余量满足 5h policy → triggered=true', async () => {
    const night = new Date(2026, 4, 13, 3, 0, 0);
    const out: string[] = [];
    const r = await runWhy({
      config: parseConfig({}),
      watcher: { snapshot: async () => snapshot(night, 50, 30) }, // 30min 到 reset，剩 50%
      checkActivity: async () => ({ active: false, lastActivityAt: null, minutesSince: null }),
      print: (s) => out.push(s),
      now: () => night,
    });
    expect(r.triggered).toBe(true);
    expect(out.join('\n')).toMatch(/WOULD trigger/);
  });

  it('user_activity 守门内 → blockedBy=user_activity', async () => {
    const night = new Date(2026, 4, 13, 3, 0, 0);
    const out: string[] = [];
    const r = await runWhy({
      config: parseConfig({}),
      watcher: { snapshot: async () => snapshot(night, 50, 30) },
      checkActivity: async () => ({
        active: true,
        lastActivityAt: new Date(night.getTime() - 5 * 60_000),
        minutesSince: 5,
      }),
      print: (s) => out.push(s),
      now: () => night,
    });
    expect(r.triggered).toBe(false);
    expect(r.blockedBy).toBe('user_activity');
  });

  it('policies 都不满足 → blockedBy=policies_not_satisfied', async () => {
    const night = new Date(2026, 4, 13, 3, 0, 0);
    const out: string[] = [];
    // 余量很充足（80%）+ 离 reset 还远（4h），不命中 hours_before_reset=1 的 policy
    const r = await runWhy({
      config: parseConfig({}),
      watcher: { snapshot: async () => snapshot(night, 80, 4 * 60) },
      checkActivity: async () => ({ active: false, lastActivityAt: null, minutesSince: null }),
      print: (s) => out.push(s),
      now: () => night,
    });
    expect(r.triggered).toBe(false);
    expect(r.blockedBy).toBe('policies_not_satisfied');
  });

  it('system_idle 启用且 afk 时间够 → 即使在 quiet_hours 也可 trigger', async () => {
    const noon = new Date(2026, 4, 13, 12, 0, 0);
    const cfg = parseConfig({
      trigger: {
        system_idle: { enabled: true, min_minutes: 30 },
        policies: [{ window: 'five_hour', hours_before_reset: 1, min_remaining_pct: 30 }],
        quiet_hours: { start: 8, end: 22 },
        user_activity_guard_minutes: 30,
      },
    });
    const out: string[] = [];
    const r = await runWhy({
      config: cfg,
      watcher: { snapshot: async () => snapshot(noon, 50, 30) },
      checkSystemIdle: async () => ({
        idleMs: 60 * 60_000, // 60 分钟 afk
        source: 'xprintidle',
      }),
      checkActivity: async () => ({ active: false, lastActivityAt: null, minutesSince: null }),
      print: (s) => out.push(s),
      now: () => noon,
    });
    expect(r.triggered).toBe(true);
    expect(out.join('\n')).toMatch(/bypass/);
  });
});
