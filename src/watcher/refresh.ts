import { writeFile, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { paths } from '../storage/paths.js';
import { proxiedFetch } from '../utils/http.js';
import { logger as rootLogger } from '../utils/logger.js';
import type { TokenInfo } from './token-source.js';

const log = rootLogger.child({ mod: 'watcher', sub: 'refresh' });

/**
 * Anthropic OAuth refresh：用 refresh_token 换新的 access_token。
 *
 * 真实端点和 client_id：Claude Code 自己也走这个流程。我们尽量保持兼容：
 *   - 默认端点 https://console.anthropic.com/v1/oauth/token（实测）
 *   - 若用户/CI 想换端点，通过 opts.endpoint 注入
 *
 * 设计：
 *   - 默认行为：仅在 401 时被动调用，不主动周期 refresh
 *   - 测试用 fetchFn 注入
 */

const REFRESH_ENDPOINT_DEFAULT = 'https://console.anthropic.com/v1/oauth/token';

/** Claude Code 公开 client_id（实测；如果端点拒绝，用户可在 config 里覆盖） */
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const RefreshResponseSchema = z.object({
  access_token: z.string().min(20),
  refresh_token: z.string().min(20).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

export class RefreshError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RefreshError';
    this.cause = cause;
  }
}

export interface RefreshOptions {
  endpoint?: string;
  clientId?: string;
  fetchFn?: typeof fetch;
  /** 写回 credentials 文件路径；不传则用 ~/.claude/.credentials.json */
  credentialsPath?: string;
  /** 失败时不写文件（测试用） */
  dryRun?: boolean;
  /** 超时 ms */
  timeoutMs?: number;
}

export interface RefreshedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  expiresIn: number;
}

/**
 * 用 refresh_token 调 oauth token 端点拿新 access_token。
 *
 * 成功后默认把新 token 写回 credentials 文件（除非 dryRun）。
 */
export async function refreshAccessToken(
  current: TokenInfo,
  opts: RefreshOptions = {},
): Promise<RefreshedToken> {
  if (!current.refreshToken) {
    throw new RefreshError('current token has no refresh_token; cannot refresh');
  }
  const endpoint = opts.endpoint ?? REFRESH_ENDPOINT_DEFAULT;
  const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
  const fetcher = opts.fetchFn ?? proxiedFetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: clientId,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new RefreshError(`network error: ${(err as Error).message}`, err);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 端点返回的 body 可能含敏感字段（旧 token 回显、内部 trace），不能直接拼到错误消息里。
    // 只提取 RFC 6749 §5.2 标准字段 error / error_description；其它丢弃。
    const safe = redactOauthError(body);
    throw new RefreshError(
      `refresh endpoint returned HTTP ${res.status}${safe ? `: ${safe}` : ''}`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new RefreshError('refresh endpoint returned malformed JSON', err);
  }
  const parsed = RefreshResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new RefreshError(
      `refresh response schema mismatch: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      parsed.error,
    );
  }
  const accessToken = parsed.data.access_token;
  const refreshToken = parsed.data.refresh_token ?? current.refreshToken;
  const expiresAt = new Date(Date.now() + parsed.data.expires_in * 1000);

  if (!opts.dryRun) {
    const credentialsPath = opts.credentialsPath ?? paths.claudeCredentials();
    await mergeIntoCredentialsFile(credentialsPath, {
      accessToken,
      refreshToken,
      expiresAt: expiresAt.getTime(),
    }).catch((err) => {
      log.warn(
        { err: (err as Error).message, credentialsPath },
        'refresh succeeded but writing credentials back failed',
      );
    });
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    expiresIn: parsed.data.expires_in,
  };
}

/**
 * RFC 6749 §5.2 错误响应解析：只允许 error / error_description 进入错误信息，
 * 其它字段（可能含 token 或服务端内部信息）丢弃。
 */
function redactOauthError(body: string): string {
  if (!body) return '';
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof j['error'] === 'string') parts.push(`error=${j['error']}`);
    if (typeof j['error_description'] === 'string') {
      parts.push(`desc=${(j['error_description'] as string).slice(0, 120)}`);
    }
    return parts.join(' ');
  } catch {
    return '(non-json body redacted)';
  }
}

/**
 * 原子写 credentials：写到 ${filePath}.tmp，再 rename。
 * 中途崩溃只会留下完整的旧文件 + .tmp 残留，不会损坏原文件。
 *
 * 注意：写的是 Claude Code 自己的 credentials 文件。AGENTS.md §3.4 说只读，
 * 这里是 refresh 流程的「documented contract exception」——只在 refresh 成功
 * 拿到新 token 后写一次，且保留所有非 token 字段。
 */
async function mergeIntoCredentialsFile(
  filePath: string,
  newFields: { accessToken: string; refreshToken: string; expiresAt: number },
): Promise<void> {
  let existing: { claudeAiOauth?: Record<string, unknown> } = {};
  try {
    const raw = await readFile(filePath, 'utf-8');
    existing = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(
        { err: (err as Error).message, filePath },
        'cannot read existing credentials; will overwrite',
      );
    }
  }
  const oauth = (existing.claudeAiOauth ?? {}) as Record<string, unknown>;
  oauth['accessToken'] = newFields.accessToken;
  oauth['refreshToken'] = newFields.refreshToken;
  oauth['expiresAt'] = newFields.expiresAt;
  existing.claudeAiOauth = oauth;

  const tmpPath = `${filePath}.idleloop.tmp`;
  const { rename } = await import('node:fs/promises');
  await writeFile(tmpPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  await rename(tmpPath, filePath);
}
