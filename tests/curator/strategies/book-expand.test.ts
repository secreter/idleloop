import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BookExpandStrategy } from '../../../src/curator/strategies/book-expand.js';

describe('BookExpandStrategy', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'idleloop-book-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('没有 marker 命中 → 空任务列表', async () => {
    await mkdir(`${dir}/chapters/ch01`, { recursive: true });
    await writeFile(`${dir}/chapters/ch01/README.md`, '# Done chapter\n\n内容完整');
    const s = new BookExpandStrategy({ projects: [{ id: 'p', dir }] });
    const tasks = await s.discover();
    expect(tasks).toHaveLength(0);
  });

  it('命中默认 marker → 生成 T3 task，引用 chapter 路径 + 行号', async () => {
    await mkdir(`${dir}/chapters/ch01`, { recursive: true });
    await writeFile(
      `${dir}/chapters/ch01/README.md`,
      '# Title\n\n背景 \n\n<!-- TODO: expand -->\n\n更多内容',
    );
    const s = new BookExpandStrategy({ projects: [{ id: 'book', dir }] });
    const tasks = await s.discover();
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t.source).toBe('T3');
    expect(t.title).toContain('book-expand');
    expect(t.prompt).toContain('chapters/ch01/README.md');
    expect(t.prompt).toMatch(/line \d+/);
  });

  it('自定义 marker', async () => {
    await mkdir(`${dir}/chapters/ch01`, { recursive: true });
    await mkdir(`${dir}/chapters/ch02`, { recursive: true });
    await writeFile(`${dir}/chapters/ch01/README.md`, '## empty\n\n[WIP]\n');
    await writeFile(`${dir}/chapters/ch02/README.md`, '## empty\n\n[WIP]\n');
    const s = new BookExpandStrategy({
      projects: [{ id: 'p', dir, marker: '[WIP]', minHits: 2 }],
    });
    const t = (await s.discover())[0]!;
    expect(t.prompt).toContain('ch01/README.md');
    expect(t.prompt).toContain('ch02/README.md');
  });

  it('maxHits 截断', async () => {
    for (let i = 0; i < 8; i++) {
      await mkdir(`${dir}/chapters/ch${i}`, { recursive: true });
      await writeFile(`${dir}/chapters/ch${i}/README.md`, '## empty\n\n<!-- TODO: expand -->\n');
    }
    const s = new BookExpandStrategy({
      projects: [{ id: 'p', dir, minHits: 1, maxHits: 3 }],
    });
    const t = (await s.discover())[0]!;
    expect(t.title).toContain('3 章');
    const matches = t.prompt.match(/ch\d+\/README\.md/g) ?? [];
    expect(matches).toHaveLength(3);
  });

  it('扫描自动跳过 node_modules / _references', async () => {
    await mkdir(`${dir}/chapters/ch01`, { recursive: true });
    await mkdir(`${dir}/_references/some-repo`, { recursive: true });
    await mkdir(`${dir}/node_modules/foo`, { recursive: true });
    await writeFile(`${dir}/chapters/ch01/README.md`, '# x\n<!-- TODO: expand -->\n');
    await writeFile(`${dir}/_references/some-repo/README.md`, '# y\n<!-- TODO: expand -->\n');
    await writeFile(`${dir}/node_modules/foo/README.md`, '# y\n<!-- TODO: expand -->\n');
    const t = (
      await new BookExpandStrategy({ projects: [{ id: 'p', dir, minHits: 1 }] }).discover()
    )[0]!;
    expect(t.prompt).toContain('ch01');
    expect(t.prompt).not.toContain('_references');
    expect(t.prompt).not.toContain('node_modules');
  });
});
