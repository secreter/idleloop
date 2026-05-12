import { describe, expect, it } from 'vitest';
import { isLockfile, matchesForbidden } from '../../src/runner/safety-gate.js';

describe('matchesForbidden', () => {
  it('精确文件匹配', () => {
    expect(matchesForbidden('.env', '.env')).toBe(true);
    expect(matchesForbidden('.env.production', '.env')).toBe(false);
  });

  it('basename 匹配', () => {
    expect(matchesForbidden('sub/.env', '.env')).toBe(true);
    expect(matchesForbidden('a/b/.env', '.env')).toBe(true);
  });

  it('目录前缀匹配（pattern 结尾 /）', () => {
    expect(matchesForbidden('secrets/foo', 'secrets/')).toBe(true);
    expect(matchesForbidden('secrets/sub/foo', 'secrets/')).toBe(true);
    expect(matchesForbidden('lib/secrets/foo', 'secrets/')).toBe(true);
    expect(matchesForbidden('src/foo', 'secrets/')).toBe(false);
  });

  it('不匹配相似前缀', () => {
    expect(matchesForbidden('secretly/x', 'secrets/')).toBe(false);
    expect(matchesForbidden('myenv', '.env')).toBe(false);
  });
});

describe('isLockfile', () => {
  it('package-lock.json', () => {
    expect(isLockfile('package-lock.json')).toBe(true);
    expect(isLockfile('packages/foo/package-lock.json')).toBe(true);
  });

  it('pnpm-lock.yaml', () => {
    expect(isLockfile('pnpm-lock.yaml')).toBe(true);
  });

  it('yarn.lock', () => {
    expect(isLockfile('yarn.lock')).toBe(true);
  });

  it('非 lockfile', () => {
    expect(isLockfile('package.json')).toBe(false);
    expect(isLockfile('src/lock.ts')).toBe(false);
  });
});
