import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { refreshAccessToken, RefreshError } from '../../src/watcher/refresh.js';
import type { TokenInfo } from '../../src/watcher/token-source.js';

function token(over: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: 'old-' + 'x'.repeat(30),
    refreshToken: 'rt-' + 'y'.repeat(40),
    expiresAt: new Date(Date.now() - 60_000),
    scopes: [],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    source: 'credentials_file',
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('refreshAccessToken', () => {
  it('成功路径：调端点、解析、写回 credentials', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idleloop-refresh-'));
    const credPath = path.join(dir, '.credentials.json');
    await writeFile(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: token().accessToken,
          refreshToken: token().refreshToken,
          expiresAt: token().expiresAt.getTime(),
          scopes: [],
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      }),
    );
    try {
      const fetchFn = vi.fn().mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            access_token: 'new-token-' + 'a'.repeat(30),
            refresh_token: 'new-rt-' + 'b'.repeat(40),
            expires_in: 3600,
          }),
        ),
      );
      const r = await refreshAccessToken(token(), {
        fetchFn,
        credentialsPath: credPath,
      });
      expect(r.accessToken.startsWith('new-token-')).toBe(true);
      expect(r.refreshToken.startsWith('new-rt-')).toBe(true);
      const written = JSON.parse(await readFile(credPath, 'utf-8')) as {
        claudeAiOauth: { accessToken: string };
      };
      expect(written.claudeAiOauth.accessToken).toBe(r.accessToken);

      // 调用参数检查
      const call = fetchFn.mock.calls[0]!;
      const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
      expect(body['grant_type']).toBe('refresh_token');
      expect(body['refresh_token']).toBe(token().refreshToken);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refresh_token 缺失：抛 RefreshError', async () => {
    await expect(refreshAccessToken(token({ refreshToken: '' }))).rejects.toThrowError(
      RefreshError,
    );
  });

  it('refresh_token 字段在响应里可省略：保留原 refresh_token', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          access_token: 'new-token-' + 'a'.repeat(30),
          expires_in: 3600,
        }),
      ),
    );
    const r = await refreshAccessToken(token(), { fetchFn, dryRun: true });
    expect(r.refreshToken).toBe(token().refreshToken);
  });

  it('非 2xx 响应：RefreshError 含状态码', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('bad', { status: 401 })));
    await expect(refreshAccessToken(token(), { fetchFn, dryRun: true })).rejects.toThrowError(
      /HTTP 401/,
    );
  });

  it('响应 JSON 不匹配 schema：RefreshError', async () => {
    const fetchFn = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    await expect(refreshAccessToken(token(), { fetchFn, dryRun: true })).rejects.toThrowError(
      /schema mismatch/,
    );
  });

  it('dryRun=true 时不写 credentials 文件', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idleloop-refresh-dry-'));
    const credPath = path.join(dir, '.credentials.json');
    try {
      const fetchFn = vi.fn().mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            access_token: 'new-token-' + 'a'.repeat(30),
            expires_in: 3600,
          }),
        ),
      );
      await refreshAccessToken(token(), { fetchFn, credentialsPath: credPath, dryRun: true });
      const { stat } = await import('node:fs/promises');
      await expect(stat(credPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
