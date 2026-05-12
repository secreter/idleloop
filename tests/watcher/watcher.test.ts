import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatDuration, Watcher } from '../../src/watcher/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Watcher', () => {
  const originalHome = process.env['HOME'];
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(path.join(tmpdir(), 'idleloop-watcher-'));
    process.env['HOME'] = testHome;
    const claudeDir = path.join(testHome, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'a'.repeat(80),
          refreshToken: 'b'.repeat(80),
          expiresAt: Date.now() + 3600_000,
          scopes: [],
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      }),
    );
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await rm(testHome, { recursive: true, force: true });
  });

  it('snapshot 把 utilization 0-100 转成 remaining 语义', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        five_hour: { utilization: 30, resets_at: '2026-05-13T03:00:00Z' },
        seven_day: { utilization: 60, resets_at: '2026-05-15T00:00:00Z' },
      }),
    );
    const w = new Watcher({ oauth: { fetchFn }, persistHistory: false });
    const s = await w.snapshot();
    expect(s.fiveHour.utilizationPct).toBe(30);
    expect(s.fiveHour.remainingPct).toBe(70);
    expect(s.sevenDay.utilizationPct).toBe(60);
    expect(s.sevenDay.remainingPct).toBe(40);
    expect(s.fiveHour.resetsAt?.toISOString()).toBe('2026-05-13T03:00:00.000Z');
    expect(s.subscriptionType).toBe('max');
    expect(s.rateLimitTier).toBe('default_claude_max_20x');
    expect(s.source).toBe('oauth');
  });

  it('辅助窗口 null 时 snapshot 字段也是 null', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        five_hour: { utilization: 7, resets_at: null },
        seven_day: { utilization: 25, resets_at: null },
        seven_day_opus: null,
        seven_day_sonnet: null,
      }),
    );
    const w = new Watcher({ oauth: { fetchFn }, persistHistory: false });
    const s = await w.snapshot();
    expect(s.sevenDayOpus).toBeNull();
    expect(s.sevenDaySonnet).toBeNull();
    expect(s.fiveHour.resetsAt).toBeNull();
  });

  it('辅助窗口存在时也转换正确', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 0, resets_at: null },
        seven_day_sonnet: { utilization: 5, resets_at: '2026-05-15T00:00:00Z' },
      }),
    );
    const w = new Watcher({ oauth: { fetchFn }, persistHistory: false });
    const s = await w.snapshot();
    expect(s.sevenDaySonnet?.utilizationPct).toBe(5);
    expect(s.sevenDaySonnet?.remainingPct).toBe(95);
  });

  it('utilization 超界被 clamp', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        five_hour: { utilization: 150, resets_at: null },
        seven_day: { utilization: -10, resets_at: null },
      }),
    );
    const w = new Watcher({ oauth: { fetchFn }, persistHistory: false });
    const s = await w.snapshot();
    expect(s.fiveHour.utilizationPct).toBe(100);
    expect(s.fiveHour.remainingPct).toBe(0);
    expect(s.sevenDay.utilizationPct).toBe(0);
    expect(s.sevenDay.remainingPct).toBe(100);
  });

  it('persistHistory=true 写一行 JSONL', async () => {
    // 每次 fetch 返回新 Response 实例（body 只能被读一次）
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          five_hour: { utilization: 7, resets_at: null },
          seven_day: { utilization: 25, resets_at: null },
        }),
      ),
    );
    const quotaPath = path.join(testHome, 'q.jsonl');
    const w = new Watcher({ oauth: { fetchFn }, quotaJsonlPath: quotaPath });
    await w.snapshot();
    await w.snapshot();
    const content = await readFile(quotaPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['five_hour']).toMatchObject({ utilization_pct: 7, remaining_pct: 93 });
  });

  it('startPolling 多次 tick + stopPolling 干净停止', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 0, resets_at: null },
      }),
    );
    const w = new Watcher({ oauth: { fetchFn }, persistHistory: false });
    const updates: number[] = [];
    w.startPolling(1000, {
      onUpdate: (s) => updates.push(s.fiveHour.utilizationPct),
    });
    await new Promise((r) => setTimeout(r, 50));
    w.stopPolling();
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('startPolling 间隔 < 1000 抛错', () => {
    const w = new Watcher({ persistHistory: false });
    expect(() => w.startPolling(500, { onUpdate: () => {} })).toThrow(/>= 1000/);
  });

  it('snapshot 失败时 onError 被调用而不是抛出', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
    const w = new Watcher({
      oauth: { fetchFn, maxRetries: 1, initialBackoffMs: 1 },
      persistHistory: false,
    });
    const errors: unknown[] = [];
    w.startPolling(60_000, {
      onUpdate: () => {},
      onError: (e) => errors.push(e),
    });
    await new Promise((r) => setTimeout(r, 50));
    w.stopPolling();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('formatDuration', () => {
  it('过去时间显示「已过」', () => {
    expect(formatDuration(-1000)).toBe('已过');
    expect(formatDuration(0)).toBe('已过');
  });

  it('分钟级', () => {
    expect(formatDuration(5 * 60_000)).toBe('5 分');
  });

  it('小时 + 分钟', () => {
    expect(formatDuration(2 * 3600_000 + 13 * 60_000)).toBe('2 小时 13 分');
  });

  it('整小时', () => {
    expect(formatDuration(3 * 3600_000)).toBe('3 小时');
  });

  it('天 + 小时', () => {
    expect(formatDuration(2 * 86400_000 + 5 * 3600_000)).toBe('2 天 5 小时');
  });
});
