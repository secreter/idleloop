import { describe, expect, it } from 'vitest';
import { scanForSecrets, matchesForbidden } from '../../src/runner/safety-gate.js';

describe('scanForSecrets', () => {
  it('AWS access key 命中', () => {
    expect(scanForSecrets('const key = "AKIAIOSFODNN7EXAMPLE";')?.kind).toBe('aws_access_key');
  });

  it('Anthropic key (sk-ant-) 命中', () => {
    expect(scanForSecrets('ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrst')?.kind).toBe(
      'anthropic_key',
    );
  });

  it('GitHub PAT 命中', () => {
    expect(scanForSecrets('token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"')?.kind).toBe(
      'github_pat',
    );
  });

  it('Slack token 命中', () => {
    expect(scanForSecrets('SLACK_TOKEN=xoxb-1234567890-abcdefghij')?.kind).toBe('slack_bot_token');
  });

  it('Google API key 命中', () => {
    expect(scanForSecrets('apiKey: "AIzaSyAbcdefghijklmnopqrstuvwxyz0123456"')?.kind).toBe(
      'google_api_key',
    );
  });

  it('PEM 私钥块命中', () => {
    expect(
      scanForSecrets(
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0...\n-----END RSA PRIVATE KEY-----',
      )?.kind,
    ).toBe('pem_private_key');
  });

  it('内联 secret=长字符串 命中', () => {
    expect(scanForSecrets('password: "Abcdef1234567890Abcdef1234567890__longenough"')?.kind).toBe(
      'inline_secret',
    );
  });

  it('普通代码不误报', () => {
    expect(scanForSecrets('const greeting = "hello world"; // very normal code')).toBeNull();
    expect(scanForSecrets('import { foo } from "./bar"')).toBeNull();
    expect(
      scanForSecrets(
        '## TODO: add API_KEY support later\nconst x = process.env.API_KEY ?? "missing"',
      ),
    ).toBeNull();
  });
});

describe('matchesForbidden（扩展模式）', () => {
  it('扩展名通配符 *.pem', () => {
    expect(matchesForbidden('secrets/server.pem', '*.pem')).toBe(true);
    expect(matchesForbidden('cert.pem', '*.pem')).toBe(true);
    expect(matchesForbidden('cert.pem.bak', '*.pem')).toBe(false);
    expect(matchesForbidden('Pem', '*.pem')).toBe(false);
  });

  it('目录前缀 .ssh/', () => {
    expect(matchesForbidden('.ssh/id_rsa', '.ssh/')).toBe(true);
    expect(matchesForbidden('home/.ssh/known_hosts', '.ssh/')).toBe(true);
    expect(matchesForbidden('foo/.sshd', '.ssh/')).toBe(false);
  });

  it('精确文件名 .env', () => {
    expect(matchesForbidden('.env', '.env')).toBe(true);
    expect(matchesForbidden('src/.env', '.env')).toBe(true);
    expect(matchesForbidden('env.example', '.env')).toBe(false);
  });
});
