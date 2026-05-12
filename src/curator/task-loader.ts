import { readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { TaskSchema, type Task } from '../types/task.js';

export class TaskParseError extends Error {
  public override readonly cause?: unknown;
  constructor(
    message: string,
    public readonly filePath?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'TaskParseError';
    this.cause = cause;
  }
}

/**
 * 解析单个 task markdown 文本。不读文件，纯函数便于测试。
 *
 * 规则：
 *   - 必须有 YAML frontmatter
 *   - body 作为 prompt；如以 `## Prompt` heading 开头则去掉这个 heading
 *   - frontmatter 的字段走 TaskSchema 校验，缺 id 时自动生成
 *   - body 空字符串当作错误
 */
export function parseTaskMarkdown(content: string, opts: { filePath?: string } = {}): Task {
  let parsed;
  try {
    parsed = matter(content);
  } catch (err) {
    throw new TaskParseError(
      `failed to parse markdown: ${(err as Error).message}`,
      opts.filePath,
      err,
    );
  }

  if (!parsed.data || Object.keys(parsed.data).length === 0) {
    throw new TaskParseError('missing YAML frontmatter', opts.filePath);
  }

  const body = stripPromptHeading(parsed.content).trim();
  if (body.length === 0) {
    throw new TaskParseError('empty body (prompt is required)', opts.filePath);
  }

  const result = TaskSchema.safeParse({ ...parsed.data, prompt: body });
  if (!result.success) {
    throw new TaskParseError(
      `frontmatter invalid: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      opts.filePath,
      result.error,
    );
  }
  return result.data;
}

function stripPromptHeading(body: string): string {
  // 去掉开头的 `## Prompt` / `## prompt` / `## 提示` 等
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (i < lines.length && /^##\s+(prompt|提示词?)\s*$/i.test(lines[i]!.trim())) {
    return lines.slice(i + 1).join('\n');
  }
  return body;
}

/**
 * 从文件路径加载任务。失败抛 TaskParseError。
 */
export async function loadTaskFromFile(filePath: string): Promise<Task> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new TaskParseError(`failed to read: ${(err as Error).message}`, filePath, err);
  }
  return parseTaskMarkdown(raw, { filePath });
}

/**
 * 返回文件路径的 basename（去扩展名）。供生成 task id 时备用。
 */
export function taskFileBasename(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}
