import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../storage/paths.js';
import type { UserActivityCheck } from './types.js';

/**
 * 扫描 ~/.claude/projects/ 取最近一次活动 mtime。
 *
 * 这个目录是 Claude Code 存储 per-project session 数据的地方；
 * 用户开会话或编辑代码时，目录里的 jsonl 文件会被更新。
 *
 * 性能注意：只扫两层（project 目录 + 一层文件），不递归全部。
 * 文件数大时 readdir 仍是 O(N)，但 Claude Code 项目数通常 < 1000，可接受。
 */
export async function getMostRecentClaudeActivity(
  opts: {
    dir?: string;
    maxDepth?: number;
  } = {},
): Promise<Date | null> {
  const root = opts.dir ?? paths.claudeProjectsDir();
  const maxDepth = opts.maxDepth ?? 2;

  let maxMtimeMs = 0;
  await walk(root, 0, maxDepth, (mtimeMs) => {
    if (mtimeMs > maxMtimeMs) maxMtimeMs = mtimeMs;
  });
  return maxMtimeMs > 0 ? new Date(maxMtimeMs) : null;
}

async function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  visit: (mtimeMs: number) => void,
): Promise<void> {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EACCES') return;
    throw err;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      const st = await stat(full);
      // 只把文件 mtime 计入"最近活动"。目录 mtime 会因为新增/删除条目被刷新到 now，
      // 导致刚 mkdtemp 出来的空架子也算最新活动，把判断带偏。
      if (st.isFile()) visit(st.mtimeMs);
      if (ent.isDirectory() && depth < maxDepth) {
        await walk(full, depth + 1, maxDepth, visit);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT' || e.code === 'EACCES') continue;
      throw err;
    }
  }
}

export interface CheckUserActivityOptions {
  dir?: string;
  now?: Date;
}

/**
 * 判断在最近 thresholdMinutes 内是否有 Claude Code 活动。
 */
export async function checkUserActivity(
  thresholdMinutes: number,
  opts: CheckUserActivityOptions = {},
): Promise<UserActivityCheck> {
  const lastActivityAt = await getMostRecentClaudeActivity(
    opts.dir != null ? { dir: opts.dir } : {},
  );
  if (lastActivityAt == null) {
    return { active: false, lastActivityAt: null, minutesSince: null };
  }
  const now = opts.now ?? new Date();
  const minutesSince = (now.getTime() - lastActivityAt.getTime()) / 60_000;
  return {
    active: minutesSince < thresholdMinutes,
    lastActivityAt,
    minutesSince,
  };
}
