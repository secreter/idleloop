import { describe, expect, it } from 'vitest';
import { parseTaskMarkdown } from '../../src/curator/index.js';
import { EXAMPLE_TASK_MD } from '../../src/cli/commands/task-template.js';

describe('EXAMPLE_TASK_MD', () => {
  it('提供的示例可被 parseTaskMarkdown 成功解析（除 working_dir 是占位）', () => {
    // 占位的 working_dir 是 ~/path/to/your/repo，schema 只要求是非空字符串，应能过
    const task = parseTaskMarkdown(EXAMPLE_TASK_MD);
    expect(task.source).toBe('T1');
    expect(task.project).toBe('example');
    expect(task.confidence).toBe('review_queue');
    expect(task.prompt.length).toBeGreaterThan(20);
  });

  it('含使用说明 + rename 命令提示', () => {
    expect(EXAMPLE_TASK_MD).toContain('mv ~/idleloop/queue/example.md.template');
    expect(EXAMPLE_TASK_MD).toContain('idleloop run --dry');
    expect(EXAMPLE_TASK_MD).toContain('idleloop daemon unit');
  });
});
