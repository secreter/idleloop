import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/cli/commands/doctor.js';

describe('runDoctor', () => {
  let home: string;
  const out: string[] = [];
  const print = (s: string) => out.push(s);
  const originalHome = process.env['HOME'];

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'idleloop-doc-home-'));
    process.env['HOME'] = home;
    out.length = 0;
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it('config 缺失时报告 not found', async () => {
    const r = await runDoctor({ print, skipNetwork: true });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'config.yml')?.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'config.yml')?.detail).toMatch(/idleloop init/);
  });

  it('init 后基础检查通过（除 OAuth + claude CLI 可能失败）', async () => {
    // 手动建文件，模拟 init
    await mkdir(`${home}/idleloop/queue`, { recursive: true });
    await mkdir(`${home}/.idleloop/state`, { recursive: true });
    await mkdir(`${home}/.idleloop/worktrees`, { recursive: true });
    await mkdir(`${home}/.idleloop/logs`, { recursive: true });
    await writeFile(`${home}/idleloop/config.yml`, 'version: 1\nprojects: []\n');
    const r = await runDoctor({ print, skipNetwork: true });
    expect(r.checks.find((c) => c.name === 'config.yml')?.ok).toBe(true);
    expect(r.checks.filter((c) => c.name.startsWith('dir ')).every((c) => c.ok)).toBe(true);
  });

  it('配置了不存在的 project：标记失败', async () => {
    await mkdir(`${home}/idleloop`, { recursive: true });
    await writeFile(
      `${home}/idleloop/config.yml`,
      'version: 1\nprojects:\n  - id: missing\n    dir: /nope/never\n',
    );
    const r = await runDoctor({ print, skipNetwork: true });
    const projectCheck = r.checks.find((c) => c.name === 'project missing');
    expect(projectCheck?.ok).toBe(false);
  });

  it('配置了项目但不是 git 仓库：标记失败', async () => {
    await mkdir(`${home}/idleloop`, { recursive: true });
    const proj = await mkdtemp(path.join(tmpdir(), 'idleloop-not-git-'));
    try {
      await writeFile(
        `${home}/idleloop/config.yml`,
        `version: 1\nprojects:\n  - id: bare\n    dir: ${proj}\n`,
      );
      const r = await runDoctor({ print, skipNetwork: true });
      const check = r.checks.find((c) => c.name === 'project bare');
      expect(check?.ok).toBe(false);
      expect(check?.detail).toMatch(/not a git repo/);
    } finally {
      await rm(proj, { recursive: true, force: true });
    }
  });
});
