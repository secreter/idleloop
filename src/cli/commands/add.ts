import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { parseTaskMarkdown } from '../../curator/task-loader.js';
import { ensureDir, paths } from '../../storage/paths.js';

export interface AddResult {
  destPath: string;
  taskId: string;
  title: string;
}

/**
 * `idleloop add <file>`：把一个 task md 加入队列。
 *
 * 步骤：
 *   1. 读源文件，调 parseTaskMarkdown 校验（让格式错的不进队列）
 *   2. 给 frontmatter 加 added_at（ISO 时间戳）
 *   3. 写到 ~/idleloop/queue/{id}.md
 */
export async function runAdd(filePath: string): Promise<AddResult> {
  const abs = path.resolve(filePath);
  const raw = await readFile(abs, 'utf-8');
  const task = parseTaskMarkdown(raw, { filePath: abs });

  // 重写 frontmatter：加 added_at（如果没有的话），用 task.id 作为目标文件名
  const parsed = matter(raw);
  const data: Record<string, unknown> = {
    ...parsed.data,
    id: task.id, // 确保即使源文件没 id，写入的也有
  };
  if (!('added_at' in data) || !data['added_at']) {
    data['added_at'] = new Date().toISOString();
  }
  const rewritten = matter.stringify(parsed.content, data);

  const queueDir = paths.queueDir();
  await ensureDir(queueDir);
  const destName = `${task.id}.md`;
  const destPath = path.join(queueDir, destName);
  await writeFile(destPath, rewritten, { mode: 0o600 });

  return { destPath, taskId: task.id, title: task.title };
}
