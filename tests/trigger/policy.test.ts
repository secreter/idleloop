import { describe, expect, it } from 'vitest';
import { evaluatePolicy, isInQuietHours } from '../../src/trigger/policy.js';
import type { TriggerPolicyConfig } from '../../src/storage/config.js';
import type { QuotaSnapshot } from '../../src/watcher/types.js';

function snap(opts: {
  fiveHourRemaining: number;
  fiveHourResetsInMin?: number | null;
  sevenDayRemaining: number;
  sevenDayResetsInHours?: number | null;
  now?: Date;
}): QuotaSnapshot {
  const now = opts.now ?? new Date('2026-05-13T10:00:00Z');
  return {
    fiveHour: {
      utilizationPct: 100 - opts.fiveHourRemaining,
      remainingPct: opts.fiveHourRemaining,
      resetsAt:
        opts.fiveHourResetsInMin == null
          ? null
          : new Date(now.getTime() + opts.fiveHourResetsInMin * 60_000),
    },
    sevenDay: {
      utilizationPct: 100 - opts.sevenDayRemaining,
      remainingPct: opts.sevenDayRemaining,
      resetsAt:
        opts.sevenDayResetsInHours == null
          ? null
          : new Date(now.getTime() + opts.sevenDayResetsInHours * 3600_000),
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

describe('evaluatePolicy', () => {
  const fiveHourPolicy: TriggerPolicyConfig = {
    window: 'five_hour',
    hours_before_reset: 1,
    min_remaining_pct: 30,
  };

  it('命中：距 reset 30 分钟 + 剩余 50%', () => {
    const now = new Date('2026-05-13T10:00:00Z');
    const r = evaluatePolicy(fiveHourPolicy, {
      snapshot: snap({ fiveHourRemaining: 50, fiveHourResetsInMin: 30, sevenDayRemaining: 0, now }),
      now,
    });
    expect(r.matches).toBe(true);
    expect(r.reason).toMatch(/50% remaining/);
    expect(r.window).toBeDefined();
  });

  it('未命中：距 reset 2 小时（大于阈值 1 小时）', () => {
    const now = new Date('2026-05-13T10:00:00Z');
    const r = evaluatePolicy(fiveHourPolicy, {
      snapshot: snap({
        fiveHourRemaining: 50,
        fiveHourResetsInMin: 120,
        sevenDayRemaining: 0,
        now,
      }),
      now,
    });
    expect(r.matches).toBe(false);
    expect(r.reason).toMatch(/2\.0h until reset/);
  });

  it('未命中：剩余 20% 低于阈值 30%', () => {
    const now = new Date('2026-05-13T10:00:00Z');
    const r = evaluatePolicy(fiveHourPolicy, {
      snapshot: snap({ fiveHourRemaining: 20, fiveHourResetsInMin: 30, sevenDayRemaining: 0, now }),
      now,
    });
    expect(r.matches).toBe(false);
    expect(r.reason).toMatch(/20% remaining/);
  });

  it('边界：刚好等于阈值（剩 30% + 距 reset 正好 1 小时）', () => {
    const now = new Date('2026-05-13T10:00:00Z');
    const r = evaluatePolicy(fiveHourPolicy, {
      snapshot: snap({ fiveHourRemaining: 30, fiveHourResetsInMin: 60, sevenDayRemaining: 0, now }),
      now,
    });
    expect(r.matches).toBe(true);
  });

  it('未命中：resets_at 已过', () => {
    const now = new Date('2026-05-13T10:00:00Z');
    const r = evaluatePolicy(fiveHourPolicy, {
      snapshot: snap({
        fiveHourRemaining: 50,
        fiveHourResetsInMin: -10,
        sevenDayRemaining: 0,
        now,
      }),
      now,
    });
    expect(r.matches).toBe(false);
    expect(r.reason).toMatch(/past reset/);
  });

  it('未命中：resets_at 为 null', () => {
    const now = new Date('2026-05-13T10:00:00Z');
    const r = evaluatePolicy(fiveHourPolicy, {
      snapshot: snap({
        fiveHourRemaining: 50,
        fiveHourResetsInMin: null,
        sevenDayRemaining: 0,
        now,
      }),
      now,
    });
    expect(r.matches).toBe(false);
    expect(r.reason).toMatch(/resets_at unknown/);
  });

  it('seven_day policy 路径', () => {
    const sevenDayPolicy: TriggerPolicyConfig = {
      window: 'seven_day',
      hours_before_reset: 12,
      min_remaining_pct: 40,
    };
    const now = new Date('2026-05-13T10:00:00Z');
    const r = evaluatePolicy(sevenDayPolicy, {
      snapshot: snap({
        fiveHourRemaining: 0,
        sevenDayRemaining: 50,
        sevenDayResetsInHours: 6,
        now,
      }),
      now,
    });
    expect(r.matches).toBe(true);
  });
});

describe('isInQuietHours', () => {
  function at(hour: number): Date {
    const d = new Date('2026-05-13T00:00:00Z');
    d.setHours(hour);
    return d;
  }

  it('同日窗口 8-22：12 点在内', () => {
    expect(isInQuietHours(at(12), { start: 8, end: 22 })).toBe(true);
  });

  it('同日窗口 8-22：23 点不在内', () => {
    expect(isInQuietHours(at(23), { start: 8, end: 22 })).toBe(false);
  });

  it('同日窗口 8-22：8 点在内（含 start）', () => {
    expect(isInQuietHours(at(8), { start: 8, end: 22 })).toBe(true);
  });

  it('同日窗口 8-22：22 点不在内（不含 end）', () => {
    expect(isInQuietHours(at(22), { start: 8, end: 22 })).toBe(false);
  });

  it('跨午夜窗口 22-8：23 点在内', () => {
    expect(isInQuietHours(at(23), { start: 22, end: 8 })).toBe(true);
  });

  it('跨午夜窗口 22-8：5 点在内', () => {
    expect(isInQuietHours(at(5), { start: 22, end: 8 })).toBe(true);
  });

  it('跨午夜窗口 22-8：10 点不在内', () => {
    expect(isInQuietHours(at(10), { start: 22, end: 8 })).toBe(false);
  });

  it('start == end：视为禁用', () => {
    expect(isInQuietHours(at(12), { start: 12, end: 12 })).toBe(false);
  });
});
