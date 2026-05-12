import { z } from 'zod';
import { proxiedFetch } from '../utils/http.js';

/**
 * Anthropic OAuth 端点封装。
 *
 * 实测 schema 见 docs/IMPLEMENTATION_PLAN.md §2.1。本文件只关心 wire 格式，
 * 不做 camelCase 转换；watcher/index.ts 负责 normalize。
 */

const QuotaWindowObjectSchema = z.object({
  utilization: z.number(),
  resets_at: z.string().nullable(),
});

/** 窗口本身允许为 null（如某些 promotional 类未启用） */
const QuotaWindowSchema = QuotaWindowObjectSchema.nullable();

const ExtraUsageSchema = z.object({
  is_enabled: z.boolean(),
  monthly_limit: z.number().nullable(),
  used_credits: z.number().nullable(),
  utilization: z.number().nullable(),
  currency: z.string().nullable(),
});

export const RawUsageResponseSchema = z
  .object({
    five_hour: QuotaWindowSchema,
    seven_day: QuotaWindowSchema,
    seven_day_oauth_apps: QuotaWindowSchema.optional(),
    seven_day_opus: QuotaWindowSchema.optional(),
    seven_day_sonnet: QuotaWindowSchema.optional(),
    seven_day_cowork: QuotaWindowSchema.optional(),
    seven_day_omelette: QuotaWindowSchema.optional(),
    tangelo: QuotaWindowSchema.optional(),
    iguana_necktie: QuotaWindowSchema.optional(),
    omelette_promotional: QuotaWindowSchema.optional(),
    extra_usage: ExtraUsageSchema.nullable().optional(),
  })
  .passthrough();

export type RawUsageResponse = z.infer<typeof RawUsageResponseSchema>;

const ProfileAccountSchema = z.object({
  uuid: z.string(),
  full_name: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  has_claude_max: z.boolean().optional(),
  has_claude_pro: z.boolean().optional(),
});

const ProfileOrganizationSchema = z
  .object({
    uuid: z.string(),
    name: z.string().nullable().optional(),
    organization_type: z.string().nullable().optional(),
    rate_limit_tier: z.string().nullable().optional(),
  })
  .passthrough();

export const RawProfileResponseSchema = z
  .object({
    account: ProfileAccountSchema,
    organization: ProfileOrganizationSchema.optional(),
  })
  .passthrough();

export type RawProfileResponse = z.infer<typeof RawProfileResponseSchema>;

const DEFAULT_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const DEFAULT_PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile';

export class OAuthClientError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OAuthClientError';
    this.cause = cause;
  }
}

export class TokenInvalidError extends OAuthClientError {
  constructor(message: string) {
    super(message);
    this.name = 'TokenInvalidError';
  }
}

export interface OAuthClientOptions {
  /** 测试用：覆盖端点 URL */
  endpoint?: string;
  /** 测试用：注入 fetch 实现 */
  fetchFn?: typeof fetch;
  /** 5xx 重试次数 */
  maxRetries?: number;
  /** 重试初始退避 ms */
  initialBackoffMs?: number;
  /** 网络超时 ms */
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  endpoint: string,
  token: string,
  opts: OAuthClientOptions,
): Promise<unknown> {
  const fetcher = opts.fetchFn ?? proxiedFetch;
  const maxRetries = opts.maxRetries ?? 3;
  const initialBackoff = opts.initialBackoffMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetcher(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < maxRetries - 1) {
        await sleep(initialBackoff * 2 ** attempt);
        continue;
      }
      throw new OAuthClientError(
        `network error calling ${endpoint}: ${(err as Error).message}`,
        err,
      );
    }
    clearTimeout(timer);

    if (res.status === 401) {
      throw new TokenInvalidError(`OAuth token invalid or expired (HTTP 401)`);
    }
    if (res.status >= 500 && res.status < 600) {
      lastErr = new OAuthClientError(`HTTP ${res.status} from ${endpoint}`);
      if (attempt < maxRetries - 1) {
        await sleep(initialBackoff * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OAuthClientError(`HTTP ${res.status} from ${endpoint}: ${body.slice(0, 200)}`);
    }

    try {
      return (await res.json()) as unknown;
    } catch (err) {
      throw new OAuthClientError(`malformed JSON from ${endpoint}`, err);
    }
  }
  throw new OAuthClientError(`failed after ${maxRetries} attempts`, lastErr);
}

export async function fetchUsage(
  token: string,
  opts: OAuthClientOptions = {},
): Promise<RawUsageResponse> {
  const endpoint = opts.endpoint ?? DEFAULT_USAGE_ENDPOINT;
  const body = await fetchWithRetry(endpoint, token, opts);
  const result = RawUsageResponseSchema.safeParse(body);
  if (!result.success) {
    throw new OAuthClientError(
      `usage endpoint schema mismatch: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      result.error,
    );
  }
  return result.data;
}

export async function fetchProfile(
  token: string,
  opts: OAuthClientOptions = {},
): Promise<RawProfileResponse> {
  const endpoint = opts.endpoint ?? DEFAULT_PROFILE_ENDPOINT;
  const body = await fetchWithRetry(endpoint, token, opts);
  const result = RawProfileResponseSchema.safeParse(body);
  if (!result.success) {
    throw new OAuthClientError(
      `profile endpoint schema mismatch: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      result.error,
    );
  }
  return result.data;
}
