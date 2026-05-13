import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCurator } from '../../src/curator/index.js';
import { parseConfig } from '../../src/storage/config.js';

describe('defaultCurator(config)', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'idleloop-defcur-'));
    await mkdir(`${projectDir}/src`, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('config 不传 → 只挂 bookshelf 一个 strategy', async () => {
    const c = defaultCurator();
    const report = await c.gather();
    expect(report.perStrategy.map((s) => s.name)).toEqual(['bookshelf']);
  });

  it('config 含 project + audit strategy → 多挂 audit 一个', async () => {
    await writeFile(`${projectDir}/src/a.ts`, '// TODO 1\n// TODO 2\n// TODO 3\n');
    const cfg = parseConfig({
      projects: [
        {
          id: 'p',
          dir: projectDir,
          strategies: [{ name: 'audit', config: { minFindings: 2 } }],
        },
      ],
    });
    const c = defaultCurator(cfg);
    const report = await c.gather();
    expect(report.perStrategy.map((s) => s.name)).toContain('audit');
    expect(report.tasks.some((t) => t.project === 'p')).toBe(true);
  });

  it('config 含 test-gap → test-gap 出现在 perStrategy', async () => {
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
      await writeFile(`${projectDir}/src/${f}`, 'export const x=1');
    }
    const cfg = parseConfig({
      projects: [
        {
          id: 'p',
          dir: projectDir,
          strategies: [{ name: 'test-gap', config: { minMissing: 1 } }],
        },
      ],
    });
    const c = defaultCurator(cfg);
    const report = await c.gather();
    expect(report.perStrategy.map((s) => s.name)).toContain('test-gap');
  });

  it('config 含 book-expand → 出现在 perStrategy', async () => {
    await mkdir(`${projectDir}/chapters/ch01`, { recursive: true });
    await writeFile(`${projectDir}/chapters/ch01/README.md`, '## title\n\n<!-- TODO: expand -->\n');
    const cfg = parseConfig({
      projects: [
        {
          id: 'p',
          dir: projectDir,
          strategies: [{ name: 'book-expand', config: { minHits: 1 } }],
        },
      ],
    });
    const c = defaultCurator(cfg);
    const report = await c.gather();
    expect(report.perStrategy.map((s) => s.name)).toContain('book-expand');
  });

  it('未识别的 strategy name 被忽略，不抛错', async () => {
    const cfg = parseConfig({
      projects: [
        {
          id: 'p',
          dir: projectDir,
          strategies: [{ name: 'unknown-x' }],
        },
      ],
    });
    const c = defaultCurator(cfg);
    const report = await c.gather();
    expect(report.perStrategy.map((s) => s.name)).toEqual(['bookshelf']);
  });
});
