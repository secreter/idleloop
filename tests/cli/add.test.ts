import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { runAdd } from '../../src/cli/commands/add.js';

describe('runAdd', () => {
  const originalHome = process.env['HOME'];
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'idleloop-add-'));
    process.env['HOME'] = home;
  });
  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  async function writeSrc(
    name: string,
    fm: Record<string, unknown>,
    body: string,
  ): Promise<string> {
    const p = path.join(home, name);
    const yaml = Object.entries(fm)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');
    await writeFile(p, `---\n${yaml}\n---\n\n${body}\n`);
    return p;
  }

  it('合法 task 文件 → 拷贝到队列 + 加 added_at', async () => {
    const src = await writeSrc(
      'src-task.md',
      {
        id: 'task-add-001',
        source: 'T1',
        project: 'p',
        title: 'Add this',
        working_dir: '/tmp/p',
        cost_estimate_tokens: 1000,
      },
      'body',
    );
    const r = await runAdd(src);
    expect(r.taskId).toBe('task-add-001');
    expect(r.title).toBe('Add this');
    expect(r.destPath).toBe(path.join(home, 'idleloop', 'queue', 'task-add-001.md'));
    const written = await readFile(r.destPath, 'utf-8');
    const parsed = matter(written);
    expect(parsed.data['added_at']).toMatch(/\dT\d/);
    expect(parsed.data['id']).toBe('task-add-001');
  });

  it('非法格式抛 TaskParseError（不会写入队列）', async () => {
    const src = path.join(home, 'bad.md');
    await writeFile(src, '# no frontmatter\nbody');
    await expect(runAdd(src)).rejects.toThrow();
  });

  it('源文件已有 added_at 时不覆盖', async () => {
    const fixed = '2026-01-01T00:00:00.000Z';
    const src = await writeSrc(
      'src.md',
      {
        id: 'task-preserve',
        source: 'T1',
        project: 'p',
        title: 'T',
        working_dir: '/tmp/p',
        cost_estimate_tokens: 1000,
        added_at: fixed,
      },
      'body',
    );
    const r = await runAdd(src);
    const written = await readFile(r.destPath, 'utf-8');
    expect(matter(written).data['added_at']).toBe(fixed);
  });

  it('自动 id：写入时确保有 id', async () => {
    const src = await writeSrc(
      'src.md',
      {
        source: 'T1',
        project: 'p',
        title: 'No id',
        working_dir: '/tmp/p',
        cost_estimate_tokens: 1000,
      },
      'body',
    );
    const r = await runAdd(src);
    expect(r.taskId).toMatch(/^task-/);
    const written = await readFile(r.destPath, 'utf-8');
    expect(matter(written).data['id']).toBe(r.taskId);
  });
});
