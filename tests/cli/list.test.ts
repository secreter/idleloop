import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatListTable, runList } from '../../src/cli/commands/list.js';
import type { Task } from '../../src/types/task.js';

describe('runList', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'idleloop-list-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('空队列 → 空数组', async () => {
    const r = await runList({ queueDir: dir });
    expect(r.tasks).toEqual([]);
  });

  it('空队列下，扫到 *.template 文件作为模板提示返回', async () => {
    await writeFile(path.join(dir, 'example.md.template'), '---\nid: t\n---\nbody');
    await writeFile(path.join(dir, 'another.md.example'), '---\nid: t\n---\nbody');
    const r = await runList({ queueDir: dir });
    expect(r.tasks).toEqual([]);
    expect(r.templates.sort()).toEqual(['another.md.example', 'example.md.template']);
    expect(r.queueDir).toBe(dir);
  });

  it('多个 md 按字典序返回', async () => {
    const writeTask = async (name: string, id: string) => {
      await writeFile(
        path.join(dir, name),
        `---
id: ${id}
source: T1
project: p
title: ${id}
working_dir: /tmp/p
cost_estimate_tokens: 1000
---

body
`,
      );
    };
    await writeTask('z.md', 'task-z');
    await writeTask('a.md', 'task-a');
    const r = await runList({ queueDir: dir });
    expect(r.tasks.map((t) => t.id)).toEqual(['task-a', 'task-z']);
  });
});

describe('formatListTable', () => {
  function t(overrides: Partial<Task> = {}): Task {
    return {
      id: 'task-1',
      source: 'T1',
      project: 'p',
      title: 'Hello',
      prompt: 'do x',
      working_dir: '/tmp/p',
      cost_estimate_tokens: 1000,
      acceptance: '',
      verify_command: 'true',
      confidence: 'review_queue',
      budget_usd: 1,
      safety: { max_diff_lines: 800, forbidden_paths: [] },
      ...overrides,
    };
  }

  it('空数组返回提示', () => {
    expect(formatListTable([])).toBe('(no tasks in queue)');
  });

  it('空 + 模板文件存在时给出 mv 指引', () => {
    const out = formatListTable({
      tasks: [],
      templates: ['example.md.template'],
      queueDir: '/q',
    });
    expect(out).toContain('(no tasks in queue)');
    expect(out).toContain('example.md.template');
    expect(out).toContain('mv ');
    expect(out).toContain('/q/example.md');
  });

  it('空 + 无模板时给出 getting-started 提示', () => {
    const out = formatListTable({ tasks: [], templates: [], queueDir: '/q' });
    expect(out).toContain('idleloop task template');
    expect(out).toContain('idleloop add');
  });

  it('含表头和数据行', () => {
    const out = formatListTable([t(), t({ id: 'task-2', title: 'Two' })]);
    expect(out).toMatch(/ID\s+SRC\s+PROJECT\s+TITLE/);
    expect(out).toContain('Hello');
    expect(out).toContain('Two');
  });

  it('截断超长 title', () => {
    const longTitle = 'This title is far longer than thirty-two characters allowed by the table';
    const out = formatListTable([t({ title: longTitle })]);
    expect(out).toContain('...');
    expect(out).not.toContain(longTitle);
  });
});
