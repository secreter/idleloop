import { describe, expect, it, vi } from 'vitest';
import { formatHuman, formatJson, runStatus } from '../../src/cli/commands/status.js';
import { Watcher } from '../../src/watcher/index.js';
import type { QuotaSnapshot } from '../../src/watcher/types.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeSnapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  const now = new Date('2026-05-13T10:00:00Z');
  return {
    fiveHour: {
      utilizationPct: 7,
      remainingPct: 93,
      resetsAt: new Date('2026-05-13T12:00:00Z'),
    },
    sevenDay: {
      utilizationPct: 25,
      remainingPct: 75,
      resetsAt: new Date('2026-05-15T13:00:00Z'),
    },
    sevenDayOpus: null,
    sevenDaySonnet: {
      utilizationPct: 5,
      remainingPct: 95,
      resetsAt: new Date('2026-05-15T13:00:00Z'),
    },
    sevenDayCowork: null,
    extraUsage: null,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    fetchedAt: now,
    source: 'oauth',
    ...overrides,
  };
}

describe('runStatus', () => {
  it('用注入的 Watcher 返回 snapshot', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          five_hour: { utilization: 10, resets_at: '2026-05-13T12:00:00Z' },
          seven_day: { utilization: 20, resets_at: '2026-05-15T00:00:00Z' },
        }),
      ),
    );
    // 不真读凭证：用 env 注入 token
    process.env['IDLELOOP_CLAUDE_TOKEN'] = 'test-token';
    try {
      const w = new Watcher({ oauth: { fetchFn }, persistHistory: false });
      const { snapshot } = await runStatus({ watcher: w });
      expect(snapshot.fiveHour.utilizationPct).toBe(10);
      expect(snapshot.sevenDay.remainingPct).toBe(80);
    } finally {
      delete process.env['IDLELOOP_CLAUDE_TOKEN'];
    }
  });
});

describe('formatHuman', () => {
  it('包含 5h 和 7d 窗口的剩余百分比', () => {
    const out = formatHuman(fakeSnapshot(), new Date('2026-05-13T10:00:00Z'));
    expect(out).toContain('5h 窗口');
    expect(out).toContain('7d 窗口');
    expect(out).toMatch(/93/);
    expect(out).toMatch(/75/);
  });

  it('包含 reset 倒计时', () => {
    const out = formatHuman(fakeSnapshot(), new Date('2026-05-13T10:00:00Z'));
    expect(out).toContain('距 reset');
  });

  it('reset 已过显示「已 reset」', () => {
    const s = fakeSnapshot({
      fiveHour: {
        utilizationPct: 0,
        remainingPct: 100,
        resetsAt: new Date('2026-05-13T09:00:00Z'),
      },
    });
    const out = formatHuman(s, new Date('2026-05-13T10:00:00Z'));
    expect(out).toContain('已 reset');
  });

  it('resetsAt 为 null 显示「未知」', () => {
    const s = fakeSnapshot({
      fiveHour: { utilizationPct: 0, remainingPct: 100, resetsAt: null },
    });
    const out = formatHuman(s, new Date('2026-05-13T10:00:00Z'));
    expect(out).toContain('未知');
  });

  it('展示 subscription / tier', () => {
    const out = formatHuman(fakeSnapshot(), new Date('2026-05-13T10:00:00Z'));
    expect(out).toContain('max');
    expect(out).toContain('default_claude_max_20x');
  });

  it('辅助窗口存在时展示在下方', () => {
    const out = formatHuman(fakeSnapshot(), new Date('2026-05-13T10:00:00Z'));
    expect(out).toContain('sonnet');
  });
});

describe('formatJson', () => {
  it('字段 snake_case + ISO 时间戳', () => {
    const j = formatJson(fakeSnapshot());
    const parsed = JSON.parse(j) as Record<string, unknown>;
    expect(parsed['fetched_at']).toBe('2026-05-13T10:00:00.000Z');
    expect(parsed['source']).toBe('oauth');
    expect(parsed['subscription_type']).toBe('max');
    const fh = parsed['five_hour'] as Record<string, unknown>;
    expect(fh['utilization_pct']).toBe(7);
    expect(fh['remaining_pct']).toBe(93);
    expect(fh['resets_at']).toBe('2026-05-13T12:00:00.000Z');
  });

  it('null 辅助窗口序列化为 null', () => {
    const j = formatJson(fakeSnapshot({ sevenDayOpus: null }));
    expect(JSON.parse(j)['seven_day_opus']).toBeNull();
  });
});
