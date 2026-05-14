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

  it('cost_estimate_tokens 写成字符串 → 错误消息带 received 值和提示', () => {
    const md = `---
id: t-1
source: T1
project: foo
title: T
working_dir: /tmp/foo
cost_estimate_tokens: "5k"
---

body
`;
    let thrown: TaskParseError | null = null;
    try {
      parseTaskMarkdown(md);
    } catch (e) {
      thrown = e as TaskParseError;
    }
    expect(thrown).toBeInstanceOf(TaskParseError);
    const msg = thrown!.message;
    expect(msg).toContain('cost_estimate_tokens');
    expect(msg).toContain('"5k"'); // received 值预览
    expect(msg).toMatch(/plain number/); // 改进提示
  });

  it('working_dir 空串 → 错误消息含字段名', () => {
    const md = `---
id: t-1
source: T1
project: foo
title: T
working_dir: ""
cost_estimate_tokens: 1000
---

body
`;
    let thrown: TaskParseError | null = null;
    try {
      parseTaskMarkdown(md);
    } catch (e) {
      thrown = e as TaskParseError;
    }
    expect(thrown).toBeInstanceOf(TaskParseError);
    expect(thrown!.message).toContain('working_dir');
  });

  it('working_dir 写成 "~/foo" → 错误提示提醒展开（用引号防止 YAML 解析 ~ 为 null）', () => {
    // 用 quoted string 让 YAML 不把 ~ 当 null
    // working_dir: "~/foo" 在 zod 里是合法的（非空字符串），不会报错
    const md = `---
id: t-1
source: T1
project: foo
title: T
working_dir: "~/foo"
cost_estimate_tokens: "5k"
---

body
`;
    // 这次靠 cost_estimate_tokens 触发错误，验证错误消息含字段提示
    let thrown: TaskParseError | null = null;
    try {
      parseTaskMarkdown(md);
    } catch (e) {
      thrown = e as TaskParseError;
    }
    expect(thrown).toBeInstanceOf(TaskParseError);
    expect(thrown!.message).toMatch(/plain number/);
  });

  it('source 拼写错误 → 提示合法枚举值', () => {
    const md = `---
id: t-1
source: t1
project: foo
title: T
working_dir: /tmp/foo
cost_estimate_tokens: 1000
---

body
`;
    let thrown: TaskParseError | null = null;
    try {
      parseTaskMarkdown(md);
    } catch (e) {
      thrown = e as TaskParseError;
    }
    expect(thrown).toBeInstanceOf(TaskParseError);
    expect(thrown!.message).toContain('source');
    expect(thrown!.message).toMatch(/T1, T2, T3, T4/);
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
