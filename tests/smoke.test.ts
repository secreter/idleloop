import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('node runs', () => {
    expect(1 + 1).toBe(2);
  });

  it('Node version is >= 20', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});
