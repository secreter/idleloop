import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runConfigCheck } from '../../src/cli/commands/config-check.js';

describe('runConfigCheck', () => {
  let dir: string;
  const out: string[] = [];
  const print = (s: string) => out.push(s);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'idleloop-cfg-check-'));
    out.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('文件不存在 → ok=false 并指引 init', async () => {
    const r = await runConfigCheck({ configPath: path.join(dir, 'nope.yml'), print });
    expect(r.ok).toBe(false);
    expect(out.join('\n')).toMatch(/config not found/);
    expect(out.join('\n')).toMatch(/idleloop init/);
  });

  it('YAML 语法错误 → ok=false', async () => {
    const f = path.join(dir, 'bad.yml');
    await writeFile(f, 'version: 1\n  bad indent: yes\n  : :\n');
    const r = await runConfigCheck({ configPath: f, print });
    expect(r.ok).toBe(false);
    expect(out.join('\n')).toMatch(/invalid YAML/);
  });

  it('schema 错误 → ok=false 并列出每个 issue', async () => {
    const f = path.join(dir, 'bad-schema.yml');
    await writeFile(
      f,
      `version: 1
runner:
  max_shift_usd: "not a number"
  default_max_budget_usd: -1
`,
    );
    const r = await runConfigCheck({ configPath: f, print });
    expect(r.ok).toBe(false);
    expect(r.issues!.length).toBeGreaterThan(0);
    expect(out.join('\n')).toContain('max_shift_usd');
  });

  it('合法配置 → ok=true 并打印有效设置摘要', async () => {
    const f = path.join(dir, 'good.yml');
    await writeFile(
      f,
      `version: 1
trigger:
  quiet_hours:
    start: 8
    end: 22
  policies:
    - window: five_hour
      hours_before_reset: 1
      min_remaining_pct: 30
`,
    );
    const r = await runConfigCheck({ configPath: f, print });
    expect(r.ok).toBe(true);
    expect(r.config).toBeDefined();
    const text = out.join('\n');
    expect(text).toMatch(/is valid/);
    expect(text).toMatch(/Effective settings/);
    expect(text).toMatch(/quiet_hours/);
    expect(text).toMatch(/policies: 1 rule/);
  });

  it('zero projects 时给 yellow warning', async () => {
    const f = path.join(dir, 'noproj.yml');
    await writeFile(f, 'version: 1\nprojects: []\n');
    const r = await runConfigCheck({ configPath: f, print });
    expect(r.ok).toBe(true);
    expect(out.join('\n')).toMatch(/no auto-discovery/);
  });
});
