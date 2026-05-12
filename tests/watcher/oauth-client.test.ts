import { describe, expect, it, vi } from 'vitest';
import {
  fetchProfile,
  fetchUsage,
  OAuthClientError,
  RawUsageResponseSchema,
  TokenInvalidError,
} from '../../src/watcher/oauth-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe('oauth-client', () => {
  describe('RawUsageResponseSchema', () => {
    it('解析实测响应（来自真实 endpoint dump）', () => {
      const real = {
        five_hour: {
          utilization: 7.0,
          resets_at: '2026-05-12T16:10:01.061414+00:00',
        },
        seven_day: {
          utilization: 25.0,
          resets_at: '2026-05-15T13:00:00.061434+00:00',
        },
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: {
          utilization: 5.0,
          resets_at: '2026-05-15T13:00:01.061441+00:00',
        },
        seven_day_cowork: null,
        seven_day_omelette: { utilization: 0.0, resets_at: null },
        tangelo: null,
        iguana_necktie: null,
        omelette_promotional: null,
        extra_usage: {
          is_enabled: false,
          monthly_limit: null,
          used_credits: null,
          utilization: null,
          currency: null,
        },
      };
      const r = RawUsageResponseSchema.parse(real);
      expect(r.five_hour?.utilization).toBe(7.0);
      expect(r.seven_day_sonnet?.utilization).toBe(5.0);
      expect(r.seven_day_omelette?.resets_at).toBeNull();
    });

    it('未知顶层字段被允许（passthrough）', () => {
      const r = RawUsageResponseSchema.parse({
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 0, resets_at: null },
        future_field: { utilization: 12 },
      });
      expect(r.five_hour?.utilization).toBe(0);
    });

    it('错误的 utilization 类型抛错', () => {
      expect(() =>
        RawUsageResponseSchema.parse({
          five_hour: { utilization: 'half', resets_at: null },
          seven_day: null,
        }),
      ).toThrow();
    });
  });

  describe('fetchUsage', () => {
    it('200 + 合法 body 返回解析后的 raw', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          five_hour: { utilization: 7.0, resets_at: '2026-05-13T03:00:00Z' },
          seven_day: { utilization: 25.0, resets_at: '2026-05-15T00:00:00Z' },
        }),
      );
      const r = await fetchUsage('tok', { fetchFn });
      expect(r.five_hour?.utilization).toBe(7.0);
      expect(fetchFn).toHaveBeenCalledOnce();
      const call = fetchFn.mock.calls[0];
      expect(call?.[0]).toContain('/api/oauth/usage');
      expect((call?.[1] as RequestInit | undefined)?.headers).toMatchObject({
        Authorization: 'Bearer tok',
      });
    });

    it('401 抛 TokenInvalidError', async () => {
      const fetchFn = vi.fn().mockResolvedValue(textResponse('Unauthorized', 401));
      await expect(fetchUsage('tok', { fetchFn })).rejects.toThrow(TokenInvalidError);
    });

    it('5xx 重试达到上限后抛 OAuthClientError', async () => {
      const fetchFn = vi.fn().mockResolvedValue(textResponse('boom', 503));
      await expect(
        fetchUsage('tok', { fetchFn, maxRetries: 2, initialBackoffMs: 1 }),
      ).rejects.toThrow(OAuthClientError);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('5xx 后 200 算成功', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(textResponse('temporary', 503))
        .mockResolvedValueOnce(
          jsonResponse({
            five_hour: { utilization: 1, resets_at: null },
            seven_day: { utilization: 2, resets_at: null },
          }),
        );
      const r = await fetchUsage('tok', { fetchFn, maxRetries: 3, initialBackoffMs: 1 });
      expect(r.seven_day?.utilization).toBe(2);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('网络异常重试', async () => {
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(
          jsonResponse({
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 0, resets_at: null },
          }),
        );
      const r = await fetchUsage('tok', { fetchFn, maxRetries: 3, initialBackoffMs: 1 });
      expect(r.five_hour?.utilization).toBe(0);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('400/403 不重试，直接抛错', async () => {
      const fetchFn = vi.fn().mockResolvedValue(textResponse('forbidden', 403));
      await expect(
        fetchUsage('tok', { fetchFn, maxRetries: 3, initialBackoffMs: 1 }),
      ).rejects.toThrow(OAuthClientError);
      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('schema 不匹配抛 OAuthClientError', async () => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ wrong: 'shape' }));
      await expect(fetchUsage('tok', { fetchFn })).rejects.toThrow(OAuthClientError);
    });
  });

  describe('fetchProfile', () => {
    it('200 返回 account + organization', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          account: {
            uuid: 'uuid-1',
            display_name: 'Test User',
            email: 'test@example.com',
            has_claude_max: true,
          },
          organization: {
            uuid: 'org-1',
            name: 'Test Org',
            rate_limit_tier: 'default_claude_max_20x',
          },
        }),
      );
      const r = await fetchProfile('tok', { fetchFn });
      expect(r.account.uuid).toBe('uuid-1');
      expect(r.organization?.rate_limit_tier).toBe('default_claude_max_20x');
    });

    it('schema 缺 account 抛错', async () => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ organization: {} }));
      await expect(fetchProfile('tok', { fetchFn })).rejects.toThrow(OAuthClientError);
    });
  });
});
