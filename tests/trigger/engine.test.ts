import { describe, expect, it } from 'vitest';
import { TriggerEngine } from '../../src/trigger/index.js';
import type { Config } from '../../src/storage/config.js';
import type { QuotaSnapshot } from '../../src/watcher/types.js';
import type { UserActivityCheck } from '../../src/trigger/types.js';

function defaultTriggerConfig(): Config['trigger'] {
  return {
    policies: [
      { window: 'five_hour', hours_before_reset: 1, min_remaining_pct: 30 },
      { window: 'seven_day', hours_before_reset: 12, min_remaining_pct: 40 },
    ],
    quiet_hours: { start: 8, end: 22 },
    user_activity_guard_minutes: 30,
    system_idle: { enabled: false, min_minutes: 30 },
  };
}

function snapAt(now: Date, fiveResetsInMin = 30, fiveRemaining = 50): QuotaSnapshot {
  return {
    fiveHour: {
      utilizationPct: 100 - fiveRemaining,
      remainingPct: fiveRemaining,
      resetsAt: new Date(now.getTime() + fiveResetsInMin * 60_000),
    },
    sevenDay: {
      utilizationPct: 90,
      remainingPct: 10,
      resetsAt: new Date(now.getTime() + 48 * 3600_000),
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

function fakeWatcher(snapshot: QuotaSnapshot) {
  return { snapshot: async () => snapshot };
}

function fakeActivity(check: UserActivityCheck) {
  return { check: async () => check };
}

const inactive: UserActivityCheck = { active: false, lastActivityAt: null, minutesSince: null };

describe('TriggerEngine', () => {
  it('触发：所有条件满足', async () => {
    const now = new Date(2026, 4, 13, 2, 0, 0); // 本地 02:00，避开 quiet 8-22
    const engine = new TriggerEngine({
      config: defaultTriggerConfig(),
      watcher: fakeWatcher(snapAt(now)),
      activity: fakeActivity(inactive),
      now: () => now,
    });
    const d = await engine.shouldTrigger();
    expect(d.triggered).toBe(true);
    expect(d.windowType).toBe('five_hour');
    expect(d.remainingPct).toBe(50);
    expect(d.msUntilReset).toBeGreaterThan(0);
  });

  it('被 quiet hours 拦截', async () => {
    const now = new Date(2026, 4, 13, 12, 0, 0); // 本地 12:00，在 quiet 8-22 内
    const engine = new TriggerEngine({
      config: defaultTriggerConfig(),
      watcher: fakeWatcher(snapAt(now)),
      activity: fakeActivity(inactive),
      now: () => now,
    });
    const d = await engine.shouldTrigger();
    expect(d.triggered).toBe(false);
    expect(d.blockedBy).toBe('quiet_hours');
  });

  it('被用户活跃拦截', async () => {
    const now = new Date(2026, 4, 13, 2, 0, 0);
    const engine = new TriggerEngine({
      config: defaultTriggerConfig(),
      watcher: fakeWatcher(snapAt(now)),
      activity: fakeActivity({
        active: true,
        lastActivityAt: new Date(now.getTime() - 10 * 60_000),
        minutesSince: 10,
      }),
      now: () => now,
    });
    const d = await engine.shouldTrigger();
    expect(d.triggered).toBe(false);
    expect(d.blockedBy).toBe('user_activity');
    expect(d.reason).toMatch(/10 minutes ago/);
  });

  it('没有 policy 命中', async () => {
    const now = new Date(2026, 4, 13, 2, 0, 0);
    // 5h 剩 10% (低于 30%)，7d 剩 10% (低于 40%) → 都不命中
    const engine = new TriggerEngine({
      config: defaultTriggerConfig(),
      watcher: fakeWatcher(snapAt(now, 30, 10)),
      activity: fakeActivity(inactive),
      now: () => now,
    });
    const d = await engine.shouldTrigger();
    expect(d.triggered).toBe(false);
    expect(d.blockedBy).toBe('policies_not_satisfied');
  });

  it('quiet_hours=null 时不拦', async () => {
    const now = new Date(2026, 4, 13, 12, 0, 0); // 本地 12:00，本应被 quiet 拦但 quiet=null
    const cfg = defaultTriggerConfig();
    cfg.quiet_hours = null;
    const engine = new TriggerEngine({
      config: cfg,
      watcher: fakeWatcher(snapAt(now)),
      activity: fakeActivity(inactive),
      now: () => now,
    });
    const d = await engine.shouldTrigger();
    expect(d.triggered).toBe(true);
  });

  it('Watcher 异常被吸收，决策 invalid_snapshot', async () => {
    const now = new Date(2026, 4, 13, 2, 0, 0);
    const engine = new TriggerEngine({
      config: defaultTriggerConfig(),
      watcher: {
        snapshot: async () => {
          throw new Error('network down');
        },
      },
      activity: fakeActivity(inactive),
      now: () => now,
    });
    const d = await engine.shouldTrigger();
    expect(d.triggered).toBe(false);
    expect(d.blockedBy).toBe('invalid_snapshot');
    expect(d.reason).toMatch(/network down/);
  });

  it('system_idle.enabled + afk：白天 quiet_hours 内也能触发', async () => {
    // 12pm，本来 quiet_hours 8-22 应该挡住
    const now = new Date(2026, 4, 13, 12, 0, 0);
    const cfg = defaultTriggerConfig();
    cfg.system_idle = { enabled: true, min_minutes: 30 };
    const engine = new TriggerEngine({
      config: cfg,
      watcher: fakeWatcher(snapAt(now, 30, 50)),
      activity: fakeActivity({ active: true, lastActivityAt: new Date(), minutesSince: 1 }), // 即使 active 也 bypass
      systemIdle: {
        check: async () => ({ idleMs: 45 * 60_000, source: 'xprintidle', isAfk: true }),
      },
      now: () => now,
    });
    const d = await engine.shouldTrigger();
    expect(d.triggered).toBe(true);
    expect(d.windowType).toBe('five_hour');
  });

  it('system_idle.enabled 但 isAfk=false：仍受 quiet_hours 拦截', async () => {
    const now = new Date(2026, 4, 13, 12, 0, 0);
    const cfg = defaultTriggerConfig();
    cfg.system_idle = { enabled: true, min_minutes: 30 };
    const engine = new TriggerEngine({
      config: cfg,
      watcher: fakeWatcher(snapAt(now, 30, 50)),
      activity: fakeActivity(inactive),
      systemIdle: {
        check: async () => ({ idleMs: 5 * 60_000, source: 'xprintidle', isAfk: false }),
      },
      now: () => now,
    });
    const d = await engine.shouldTrigger();
    expect(d.triggered).toBe(false);
    expect(d.blockedBy).toBe('quiet_hours');
  });

  it('system_idle.enabled=false：完全忽略 afk，走标准流程', async () => {
    const now = new Date(2026, 4, 13, 12, 0, 0);
    const cfg = defaultTriggerConfig();
    cfg.system_idle = { enabled: false, min_minutes: 30 };
    const engine = new TriggerEngine({
      config: cfg,
      watcher: fakeWatcher(snapAt(now, 30, 50)),
      activity: fakeActivity(inactive),
      // 即使探测说 afk，也不应该 bypass
      systemIdle: {
        check: async () => ({ idleMs: 60 * 60_000, source: 'xprintidle', isAfk: true }),
      },
      now: () => now,
    });
    const d = await engine.shouldTrigger();
    expect(d.triggered).toBe(false);
    expect(d.blockedBy).toBe('quiet_hours');
  });

  it('多 policy：第二个 policy 命中', async () => {
    const now = new Date(2026, 4, 13, 2, 0, 0);
    // 5h: 剩 80% 但距 reset 4 小时 (超过 1h)，不命中
    // 7d: 距 reset 6h + 剩 50%，命中
    const snapshot: QuotaSnapshot = {
      fiveHour: {
        utilizationPct: 20,
        remainingPct: 80,
        resetsAt: new Date(now.getTime() + 4 * 3600_000),
      },
      sevenDay: {
        utilizationPct: 50,
        remainingPct: 50,
        resetsAt: new Date(now.getTime() + 6 * 3600_000),
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
    const engine = new TriggerEngine({
      config: defaultTriggerConfig(),
      watcher: fakeWatcher(snapshot),
      activity: fakeActivity(inactive),
      now: () => now,
    });
    const d = await engine.shouldTrigger();
    expect(d.triggered).toBe(true);
    expect(d.windowType).toBe('seven_day');
  });
});
