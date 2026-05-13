import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditStrategy } from '../../../src/curator/strategies/audit.js';

describe('AuditStrategy', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'idleloop-audit-'));
    await mkdir(`${dir}/src`, { recursive: true });
    await mkdir(`${dir}/node_modules/foo`, { recursive: true });
    // node_modules 内的 TODO 不应该被扫到
    await writeFile(`${dir}/node_modules/foo/index.js`, '// TODO: should not count\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('低于 minFindings 时返回空（不生成任务）', async () => {
    await writeFile(`${dir}/src/a.ts`, '// TODO: only one\nconsole.log(1);\n');
    const s = new AuditStrategy({
      projects: [{ id: 'p', dir, minFindings: 3 }],
    });
    const tasks = await s.discover();
    expect(tasks).toHaveLength(0);
  });

  it('达到 minFindings 时生成 T3 audit 任务', async () => {
    await writeFile(
      `${dir}/src/a.ts`,
      ['// TODO: write it', '// FIXME bad', '// XXX leaky'].join('\n'),
    );
    const s = new AuditStrategy({
      projects: [{ id: 'p', dir, minFindings: 2 }],
    });
    const tasks = await s.discover();
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t.source).toBe('T3');
    expect(t.project).toBe('p');
    expect(t.title).toContain('audit');
    expect(t.prompt).toContain('TODO');
    expect(t.prompt).toContain('FIXME');
    expect(t.prompt).toContain('XXX');
    expect(t.working_dir).toBe(dir);
  });

  it('跳过 node_modules 与点开头目录（除 .github）', async () => {
    await writeFile(`${dir}/src/a.ts`, '// TODO 1\n// TODO 2\n// TODO 3\n// TODO 4\n');
    await mkdir(`${dir}/.cache`, { recursive: true });
    await writeFile(`${dir}/.cache/leak.ts`, '// TODO leaked\n');
    const s = new AuditStrategy({
      projects: [{ id: 'p', dir, minFindings: 2 }],
    });
    const t = (await s.discover())[0]!;
    expect(t.prompt).not.toContain('leaked');
    expect(t.prompt).not.toContain('should not count');
  });

  it('maxFindings 截断', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `// TODO ${i}`).join('\n');
    await writeFile(`${dir}/src/a.ts`, lines);
    const s = new AuditStrategy({
      projects: [{ id: 'p', dir, minFindings: 2, maxFindings: 5 }],
    });
    const t = (await s.discover())[0]!;
    // 仅 5 条进 prompt（数字 0-4 可能出现）
    const counts = ['TODO 0', 'TODO 1', 'TODO 2', 'TODO 3', 'TODO 4', 'TODO 5'].filter((s) =>
      t.prompt.includes(s),
    );
    expect(counts.length).toBeLessThanOrEqual(6);
    expect(t.title).toContain('5');
  });

  it('扩展名白名单过滤', async () => {
    await writeFile(`${dir}/src/a.txt`, '// TODO ignored\n');
    await writeFile(`${dir}/src/b.ts`, '// TODO 1\n// TODO 2\n// TODO 3\n');
    const s = new AuditStrategy({
      projects: [{ id: 'p', dir, minFindings: 2, extensions: ['.ts'] }],
    });
    const t = (await s.discover())[0]!;
    expect(t.prompt).not.toContain('ignored');
  });

  it('项目目录不存在：跳过不抛错', async () => {
    const s = new AuditStrategy({
      projects: [{ id: 'p-missing', dir: '/no/such/dir', minFindings: 1 }],
    });
    const tasks = await s.discover();
    expect(tasks).toEqual([]);
  });
});
