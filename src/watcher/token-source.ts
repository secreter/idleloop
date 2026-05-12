import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { paths } from '../storage/paths.js';

/**
 * 从本地读取 Claude Code OAuth token。
 *
 * 来源优先级：
 * 1. 环境变量 IDLELOOP_CLAUDE_TOKEN（手动覆盖，用于测试或非常规环境）
 * 2. ~/.claude/.credentials.json 中的 claudeAiOauth.accessToken
 *
 * 第二项的字段结构来自实测（见 docs/IMPLEMENTATION_PLAN.md §2.1）。
 */

const CredentialsFileSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(20),
    refreshToken: z.string().min(20),
    expiresAt: z.number().int().positive(),
    scopes: z.array(z.string()).default([]),
    subscriptionType: z.string().default('unknown'),
    rateLimitTier: z.string().default('unknown'),
  }),
});

export type TokenSource = 'credentials_file' | 'env';

export interface TokenInfo {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
  source: TokenSource;
}

export class TokenSourceError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TokenSourceError';
    this.cause = cause;
  }
}

export interface LoadTokenOptions {
  credentialsPath?: string;
  env?: NodeJS.ProcessEnv;
}

export async function loadToken(opts: LoadTokenOptions = {}): Promise<TokenInfo> {
  const env = opts.env ?? process.env;
  const envToken = env['IDLELOOP_CLAUDE_TOKEN'];
  if (envToken && envToken.length > 0) {
    return {
      accessToken: envToken,
      refreshToken: '',
      expiresAt: new Date(Date.now() + 60 * 60_000),
      scopes: [],
      subscriptionType: 'unknown',
      rateLimitTier: 'unknown',
      source: 'env',
    };
  }

  const filePath = opts.credentialsPath ?? paths.claudeCredentials();
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TokenSourceError(
        `Claude credentials not found at ${filePath}. ` +
          `Run \`claude auth login\` first, or set IDLELOOP_CLAUDE_TOKEN.`,
      );
    }
    throw new TokenSourceError(`failed to read ${filePath}: ${(err as Error).message}`, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TokenSourceError(`malformed JSON in ${filePath}`, err);
  }

  const result = CredentialsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new TokenSourceError(
      `credentials file schema mismatch: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      result.error,
    );
  }
  const c = result.data.claudeAiOauth;
  return {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt: new Date(c.expiresAt),
    scopes: c.scopes,
    subscriptionType: c.subscriptionType,
    rateLimitTier: c.rateLimitTier,
    source: 'credentials_file',
  };
}

/**
 * 判断 token 是否快过期或已过期。
 * 默认 marginMs = 5 分钟，提前 5 分钟视为待 refresh。
 */
export function isTokenExpired(token: TokenInfo, marginMs = 5 * 60_000): boolean {
  return token.expiresAt.getTime() - Date.now() < marginMs;
}
