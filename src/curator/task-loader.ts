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
    const lines: string[] = ['frontmatter invalid:'];
    for (const issue of result.error.issues) {
      lines.push(`  · ${formatZodIssue(issue, parsed.data as Record<string, unknown>)}`);
    }
    throw new TaskParseError(lines.join('\n'), opts.filePath, result.error);
  }
  return result.data;
}

/**
 * 把 zod issue 渲染成"用户看得懂哪里错了"的字符串。
 *
 * 关键信息：字段路径、期望类型、实际收到的值预览、常见 typo 的自动建议。
 */
function formatZodIssue(
  issue: { path: PropertyKey[]; message: string; code: string; received?: unknown },
  data: Record<string, unknown>,
): string {
  const fieldPath = issue.path.join('.') || '(root)';
  const actual = issue.path.length > 0 ? getByPath(data, issue.path) : undefined;
  const actualPreview = formatValuePreview(actual);
  const extraHint = inlineHintFor(fieldPath, actual);
  const base = `${fieldPath}: ${issue.message}`;
  const withActual = actualPreview ? `${base} (got: ${actualPreview})` : base;
  return extraHint ? `${withActual}  → ${extraHint}` : withActual;
}

function getByPath(obj: unknown, p: PropertyKey[]): unknown {
  let cur: unknown = obj;
  for (const seg of p) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

function formatValuePreview(v: unknown): string {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (typeof v === 'string') {
    const s = v.length > 40 ? `${v.slice(0, 40)}…` : v;
    return `"${s}"`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v;
}

/**
 * 字段级的常见错误提示。比泛泛的 "Expected number" 更 actionable。
 *  - cost_estimate_tokens / budget_usd 写成 "5k" 这种字符串
 *  - working_dir 含 `~` 而 zod 不会展开
 *  - source 不是 T1/T2/T3/T4
 *  - confidence 拼写问题
 */
function inlineHintFor(fieldPath: string, actual: unknown): string | null {
  if (
    (fieldPath === 'cost_estimate_tokens' || fieldPath === 'budget_usd') &&
    typeof actual === 'string'
  ) {
    return `write it as a plain number, e.g. ${fieldPath === 'budget_usd' ? '0.5' : '5000'} (no quotes, no "k" suffix)`;
  }
  if (fieldPath === 'working_dir' && typeof actual === 'string' && actual.startsWith('~')) {
    return `expand "~" to an absolute path; idleloop does not expand frontmatter values`;
  }
  if (fieldPath === 'source' && typeof actual === 'string') {
    return `source must be one of T1, T2, T3, T4 (case-sensitive)`;
  }
  if (fieldPath === 'confidence' && typeof actual === 'string') {
    return `confidence must be one of auto_merge, review_queue, draft_only`;
  }
  return null;
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
