import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BookshelfStrategy } from '../../src/curator/strategies/bookshelf.js';
import { Curator } from '../../src/curator/index.js';

describe('BookshelfStrategy', () => {
  let queueDir: string;

  beforeEach(async () => {
    queueDir = await mkdtemp(path.join(tmpdir(), 'idleloop-bookshelf-'));
  });

  afterEach(async () => {
    await rm(queueDir, { recursive: true, force: true });
  });

  async function writeTaskMd(name: string, frontmatter: Record<string, unknown>, body: string) {
    const fm = Object.entries(frontmatter)
      .map(([k, v]) =>
        typeof v === 'object' && v !== null
          ? `${k}:\n${Object.entries(v as Record<string, unknown>)
              .map(([k2, v2]) => `  ${k2}: ${JSON.stringify(v2)}`)
              .join('\n')}`
          : `${k}: ${JSON.stringify(v)}`,
      )
      .join('\n');
    await writeFile(path.join(queueDir, name), `---\n${fm}\n---\n\n${body}\n`);
  }

  it('队列空 → 返回 []', async () => {
    const s = new BookshelfStrategy({ queueDir });
    const r = await s.discover();
    expect(r).toEqual([]);
  });

  it('queueDir 不存在 → 返回 []，不抛错', async () => {
    const s = new BookshelfStrategy({ queueDir: path.join(queueDir, 'nope') });
    const r = await s.discover();
    expect(r).toEqual([]);
  });

  it('扫到合法 md 转 Task', async () => {
    await writeTaskMd(
      'a.md',
      {
        id: 't-a',
        source: 'T1',
        project: 'p',
        title: 'A',
        working_dir: '/tmp/x',
        cost_estimate_tokens: 1000,
      },
      'body a',
    );
    const s = new BookshelfStrategy({ queueDir });
    const r = await s.discover();
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('t-a');
    expect(r[0]?.prompt).toBe('body a');
  });

  it('忽略非 md 文件', async () => {
    await writeFile(path.join(queueDir, 'README.txt'), 'not a task');
    await writeTaskMd(
      'a.md',
      {
        id: 't-a',
        source: 'T1',
        project: 'p',
        title: 'A',
        working_dir: '/tmp/x',
        cost_estimate_tokens: 1000,
      },
      'body',
    );
    const r = await new BookshelfStrategy({ queueDir }).discover();
    expect(r).toHaveLength(1);
  });

  it('跳过格式错的 md 不中断流程', async () => {
    await writeFile(path.join(queueDir, 'broken.md'), '# no frontmatter just heading');
    await writeTaskMd(
      'ok.md',
      {
        id: 't-ok',
        source: 'T1',
        project: 'p',
        title: 'OK',
        working_dir: '/tmp/x',
        cost_estimate_tokens: 1000,
      },
      'body',
    );
    const r = await new BookshelfStrategy({ queueDir }).discover();
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('t-ok');
  });

  it('字典序稳定', async () => {
    for (const name of ['c.md', 'a.md', 'b.md']) {
      await writeTaskMd(
        name,
        {
          id: `t-${name.replace('.md', '')}`,
          source: 'T1',
          project: 'p',
          title: name,
          working_dir: '/tmp/x',
          cost_estimate_tokens: 100,
        },
        'b',
      );
    }
    const r = await new BookshelfStrategy({ queueDir }).discover();
    expect(r.map((t) => t.id)).toEqual(['t-a', 't-b', 't-c']);
  });
});

describe('Curator.gather', () => {
  it('合并多个 strategy 输出，去重', async () => {
    const a = {
      name: 'a',
      source: 'T1' as const,
      discover: async () => [
        {
          id: 't-1',
          source: 'T1' as const,
          project: 'p',
          title: 'one',
          prompt: 'p',
          working_dir: '/tmp/x',
          cost_estimate_tokens: 100,
          acceptance: '',
          verify_command: 'true',
          confidence: 'review_queue' as const,
          budget_usd: 1,
          safety: { max_diff_lines: 800, forbidden_paths: [] },
        },
      ],
    };
    const b = {
      name: 'b',
      source: 'T3' as const,
      discover: async () => [
        // 同 id —— 应被去重
        {
          id: 't-1',
          source: 'T3' as const,
          project: 'p',
          title: 'dup',
          prompt: 'p',
          working_dir: '/tmp/x',
          cost_estimate_tokens: 100,
          acceptance: '',
          verify_command: 'true',
          confidence: 'review_queue' as const,
          budget_usd: 1,
          safety: { max_diff_lines: 800, forbidden_paths: [] },
        },
        {
          id: 't-2',
          source: 'T3' as const,
          project: 'p',
          title: 'two',
          prompt: 'p',
          working_dir: '/tmp/x',
          cost_estimate_tokens: 100,
          acceptance: '',
          verify_command: 'true',
          confidence: 'review_queue' as const,
          budget_usd: 1,
          safety: { max_diff_lines: 800, forbidden_paths: [] },
        },
      ],
    };
    const c = new Curator({ strategies: [a, b] });
    const r = await c.gather();
    expect(r.tasks.map((t) => t.id)).toEqual(['t-1', 't-2']);
    expect(r.perStrategy).toHaveLength(2);
    expect(r.perStrategy[1]?.skipped).toBe(1);
  });

  it('strategy 抛错不阻塞其他', async () => {
    const failing = {
      name: 'fail',
      source: 'T1' as const,
      discover: async () => {
        throw new Error('boom');
      },
    };
    const working = {
      name: 'work',
      source: 'T3' as const,
      discover: async () => [
        {
          id: 't-1',
          source: 'T3' as const,
          project: 'p',
          title: 'one',
          prompt: 'p',
          working_dir: '/tmp/x',
          cost_estimate_tokens: 100,
          acceptance: '',
          verify_command: 'true',
          confidence: 'review_queue' as const,
          budget_usd: 1,
          safety: { max_diff_lines: 800, forbidden_paths: [] },
        },
      ],
    };
    const r = await new Curator({ strategies: [failing, working] }).gather();
    expect(r.tasks).toHaveLength(1);
    expect(r.perStrategy[0]?.error).toMatch(/boom/);
    expect(r.perStrategy[1]?.error).toBeUndefined();
  });
});
