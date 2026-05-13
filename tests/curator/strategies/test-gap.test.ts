import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestGapStrategy } from '../../../src/curator/strategies/test-gap.js';

describe('TestGapStrategy', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'idleloop-testgap-'));
    await mkdir(`${dir}/src`, { recursive: true });
    await mkdir(`${dir}/tests`, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('全部有测试 → 不生成任务', async () => {
    await writeFile(`${dir}/src/foo.ts`, 'export const foo = 1');
    await writeFile(`${dir}/tests/foo.test.ts`, 'test');
    const s = new TestGapStrategy({ projects: [{ id: 'p', dir, minMissing: 1 }] });
    const tasks = await s.discover();
    expect(tasks).toHaveLength(0);
  });

  it('一个源文件没有测试 → 命中阈值后生成 T3 任务', async () => {
    for (const f of ['a', 'b', 'c', 'd']) {
      await writeFile(`${dir}/src/${f}.ts`, `export const ${f} = 1`);
    }
    // 仅 b 有测试
    await writeFile(`${dir}/tests/b.test.ts`, 'test');
    const s = new TestGapStrategy({ projects: [{ id: 'p', dir, minMissing: 2 }] });
    const tasks = await s.discover();
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t.source).toBe('T3');
    expect(t.title).toContain('test-gap');
    expect(t.prompt).toMatch(/src\/(a|c|d)\.ts/);
    expect(t.verify_command).toBe('npm test');
  });

  it('排除 *.d.ts / index.ts / types.ts / *.test.ts', async () => {
    await writeFile(`${dir}/src/index.ts`, 'export const x = 1');
    await writeFile(`${dir}/src/types.ts`, 'export type T = number');
    await writeFile(`${dir}/src/api.d.ts`, 'declare const x: 1');
    await writeFile(`${dir}/src/util.ts`, 'export const u = 1');
    await writeFile(`${dir}/src/foo.test.ts`, 'test');
    // 只有 util.ts 应该被认为缺测试
    const s = new TestGapStrategy({ projects: [{ id: 'p', dir, minMissing: 1 }] });
    const t = (await s.discover())[0]!;
    expect(t.prompt).toContain('util.ts');
    expect(t.prompt).not.toContain('index.ts');
    expect(t.prompt).not.toContain('types.ts');
    expect(t.prompt).not.toContain('api.d.ts');
  });

  it('src 目录不存在：返回 null（跳过）', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'idleloop-testgap-empty-'));
    try {
      const s = new TestGapStrategy({ projects: [{ id: 'p', dir: empty, minMissing: 1 }] });
      const tasks = await s.discover();
      expect(tasks).toHaveLength(0);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('maxModules 上限：prompt 列出截断后的数量，title 也匹配', async () => {
    for (let i = 0; i < 30; i++) {
      await writeFile(`${dir}/src/m${i}.ts`, 'export const x=1');
    }
    const s = new TestGapStrategy({
      projects: [{ id: 'p', dir, minMissing: 1, maxModules: 5 }],
    });
    const t = (await s.discover())[0]!;
    expect(t.title).toContain('5 untested');
    const hits = t.prompt.match(/src\/m\d+\.ts/g) ?? [];
    expect(hits.length).toBe(5);
  });
});
