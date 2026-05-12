import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  loadTaskFromFile,
  parseTaskMarkdown,
  TaskParseError,
} from '../../src/curator/task-loader.js';

const FIXTURES = path.resolve(__dirname, '../fixtures/queue');

describe('parseTaskMarkdown', () => {
  it('解析完整 frontmatter + body 含 Prompt heading', () => {
    const md = `---
id: t-1
source: T1
project: foo
title: Test
working_dir: /tmp/foo
cost_estimate_tokens: 1000
---

## Prompt

Do something useful.
`;
    const t = parseTaskMarkdown(md);
    expect(t.id).toBe('t-1');
    expect(t.source).toBe('T1');
    expect(t.title).toBe('Test');
    expect(t.prompt).toBe('Do something useful.');
    // 默认值
    expect(t.confidence).toBe('review_queue');
    expect(t.budget_usd).toBe(1.0);
    expect(t.safety.max_diff_lines).toBe(800);
  });

  it('body 不含 Prompt heading 时整体作为 prompt', () => {
    const md = `---
id: t-1
source: T1
project: foo
title: Test
working_dir: /tmp/foo
cost_estimate_tokens: 1000
---

Just plain body without a heading.
`;
    const t = parseTaskMarkdown(md);
    expect(t.prompt).toBe('Just plain body without a heading.');
  });

  it('缺 frontmatter 抛 TaskParseError', () => {
    expect(() => parseTaskMarkdown('# Just a heading\n\nbody only')).toThrow(TaskParseError);
  });

  it('空 body 抛错', () => {
    const md = `---
id: t-1
source: T1
project: foo
title: Test
working_dir: /tmp/foo
cost_estimate_tokens: 1000
---
`;
    expect(() => parseTaskMarkdown(md)).toThrow(/empty body/);
  });

  it('frontmatter 缺必填字段抛错', () => {
    const md = `---
source: T1
project: foo
---

body
`;
    expect(() => parseTaskMarkdown(md)).toThrow(TaskParseError);
  });

  it('缺 id 时自动生成 task-ULID', () => {
    const md = `---
source: T1
project: foo
title: T
working_dir: /tmp/foo
cost_estimate_tokens: 1000
---

body
`;
    const t = parseTaskMarkdown(md);
    expect(t.id).toMatch(/^task-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('支持 "## prompt" 小写 heading', () => {
    const md = `---
id: t-1
source: T1
project: foo
title: Test
working_dir: /tmp/foo
cost_estimate_tokens: 1000
---

## prompt
inner
`;
    expect(parseTaskMarkdown(md).prompt).toBe('inner');
  });

  it('支持 "## 提示" 中文 heading', () => {
    const md = `---
id: t-1
source: T1
project: foo
title: Test
working_dir: /tmp/foo
cost_estimate_tokens: 1000
---

## 提示

中文 prompt 内容
`;
    expect(parseTaskMarkdown(md).prompt).toBe('中文 prompt 内容');
  });
});

describe('loadTaskFromFile', () => {
  it('加载合法 fixture', async () => {
    const t = await loadTaskFromFile(path.join(FIXTURES, 'valid-task.md'));
    expect(t.id).toBe('task-fixture-001');
    expect(t.title).toBe('Expand ch04 RAG basics');
    expect(t.cost_estimate_tokens).toBe(40000);
    expect(t.safety.forbidden_paths).toContain('package-lock.json');
    expect(t.prompt).toContain('chapters/04-rag/README.md');
  });

  it('加载 auto-id fixture（缺 id）', async () => {
    const t = await loadTaskFromFile(path.join(FIXTURES, 'auto-id.md'));
    expect(t.id).toMatch(/^task-/);
    expect(t.project).toBe('coffeesmap');
  });

  it('加载 missing-fields fixture 抛 TaskParseError', async () => {
    await expect(loadTaskFromFile(path.join(FIXTURES, 'missing-fields.md'))).rejects.toThrow(
      TaskParseError,
    );
  });

  it('文件不存在抛 TaskParseError', async () => {
    await expect(loadTaskFromFile(path.join(FIXTURES, 'nope.md'))).rejects.toThrow(TaskParseError);
  });
});
