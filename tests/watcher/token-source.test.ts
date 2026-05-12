import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isTokenExpired, loadToken, TokenSourceError } from '../../src/watcher/token-source.js';

describe('token-source', () => {
  const originalHome = process.env['HOME'];
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(path.join(tmpdir(), 'idleloop-tok-'));
    process.env['HOME'] = testHome;
    delete process.env['IDLELOOP_CLAUDE_TOKEN'];
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    delete process.env['IDLELOOP_CLAUDE_TOKEN'];
    await rm(testHome, { recursive: true, force: true });
  });

  async function writeCreds(obj: unknown): Promise<string> {
    const dir = path.join(testHome, '.claude');
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, '.credentials.json');
    await writeFile(p, JSON.stringify(obj), { mode: 0o600 });
    return p;
  }

  it('成功解析合法 credentials 文件', async () => {
    await writeCreds({
      claudeAiOauth: {
        accessToken: 'a'.repeat(80),
        refreshToken: 'b'.repeat(80),
        expiresAt: Date.now() + 3600_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    });
    const tok = await loadToken();
    expect(tok.source).toBe('credentials_file');
    expect(tok.accessToken.length).toBeGreaterThan(20);
    expect(tok.subscriptionType).toBe('max');
    expect(tok.rateLimitTier).toBe('default_claude_max_20x');
    expect(tok.expiresAt).toBeInstanceOf(Date);
  });

  it('文件不存在抛 TokenSourceError 且提示 claude auth login', async () => {
    await expect(loadToken()).rejects.toThrow(TokenSourceError);
    await expect(loadToken()).rejects.toThrow(/claude auth login/);
  });

  it('非法 JSON 抛错', async () => {
    const dir = path.join(testHome, '.claude');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.credentials.json'), '{not json');
    await expect(loadToken()).rejects.toThrow(TokenSourceError);
  });

  it('schema 不匹配抛错', async () => {
    await writeCreds({ claudeAiOauth: { accessToken: 'short' } });
    await expect(loadToken()).rejects.toThrow(TokenSourceError);
  });

  it('env IDLELOOP_CLAUDE_TOKEN 覆盖凭证文件', async () => {
    await writeCreds({
      claudeAiOauth: {
        accessToken: 'a'.repeat(80),
        refreshToken: 'b'.repeat(80),
        expiresAt: Date.now() + 3600_000,
        scopes: [],
        subscriptionType: 'max',
        rateLimitTier: 'default',
      },
    });
    process.env['IDLELOOP_CLAUDE_TOKEN'] = 'env-override-token';
    const tok = await loadToken();
    expect(tok.source).toBe('env');
    expect(tok.accessToken).toBe('env-override-token');
  });

  it('显式 env 注入覆盖 process.env', async () => {
    await writeCreds({
      claudeAiOauth: {
        accessToken: 'a'.repeat(80),
        refreshToken: 'b'.repeat(80),
        expiresAt: Date.now() + 3600_000,
        scopes: [],
        subscriptionType: 'max',
        rateLimitTier: 'default',
      },
    });
    const tok = await loadToken({ env: { IDLELOOP_CLAUDE_TOKEN: 'injected' } });
    expect(tok.source).toBe('env');
    expect(tok.accessToken).toBe('injected');
  });

  describe('isTokenExpired', () => {
    function tok(expiresAt: Date) {
      return {
        accessToken: 'x',
        refreshToken: 'y',
        expiresAt,
        scopes: [],
        subscriptionType: 'max',
        rateLimitTier: 'tier',
        source: 'env' as const,
      };
    }

    it('未来 1 小时：未过期', () => {
      expect(isTokenExpired(tok(new Date(Date.now() + 3600_000)))).toBe(false);
    });

    it('已过期', () => {
      expect(isTokenExpired(tok(new Date(Date.now() - 1000)))).toBe(true);
    });

    it('5 分钟以内视为过期（默认 margin）', () => {
      expect(isTokenExpired(tok(new Date(Date.now() + 4 * 60_000)))).toBe(true);
    });

    it('自定义 margin = 0：刚好未过期', () => {
      expect(isTokenExpired(tok(new Date(Date.now() + 1000)), 0)).toBe(false);
    });
  });
});
