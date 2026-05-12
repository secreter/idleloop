import simpleGit, { type DiffResult } from 'simple-git';
import type { Task } from '../types/task.js';

export interface SafetyDiff {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{ file: string; insertions: number; deletions: number; binary: boolean }>;
}

export type SafetyFailureReason = 'oversized' | 'forbidden_path' | 'lockfile_touched';

export type SafetyCheckResult =
  | { pass: true; diff: SafetyDiff }
  | { pass: false; reason: SafetyFailureReason; detail: string; diff: SafetyDiff };

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

/**
 * 在 worktreePath 下用 git diff（包含未提交改动）评估安全性。
 *
 * 三步检查（按严格度递增）：
 *   1. 是否触及 forbidden_paths（如 .env / secrets/）
 *   2. 是否触及 lockfile（package-lock.json 等）
 *   3. 总改动行数是否超过 task.safety.max_diff_lines
 */
export async function checkSafety(opts: {
  worktreePath: string;
  task: Task;
}): Promise<SafetyCheckResult> {
  const git = simpleGit({ baseDir: opts.worktreePath });

  // 先把所有改动（含 untracked）stage 起来——worktree 是 task 专属，无副作用。
  // 不 stage 的话 git diff HEAD 看不到新文件。
  await git.add(['-A']);

  // 用 --cached vs HEAD：覆盖 staged + 上面 git add 进来的 untracked
  let raw: DiffResult;
  try {
    raw = await git.diffSummary(['--cached', 'HEAD']);
  } catch (err) {
    throw new Error(`git diffSummary failed: ${(err as Error).message}`);
  }

  const diff: SafetyDiff = {
    filesChanged: raw.files.length,
    insertions: raw.insertions,
    deletions: raw.deletions,
    files: raw.files.map((f) => ({
      file: f.file,
      insertions: 'insertions' in f ? Number(f.insertions) : 0,
      deletions: 'deletions' in f ? Number(f.deletions) : 0,
      binary: f.binary,
    })),
  };

  // 1. forbidden paths
  for (const f of diff.files) {
    for (const pattern of opts.task.safety.forbidden_paths) {
      if (matchesForbidden(f.file, pattern)) {
        return {
          pass: false,
          reason: 'forbidden_path',
          detail: `${f.file} matches forbidden pattern "${pattern}"`,
          diff,
        };
      }
    }
  }

  // 2. lockfiles（始终禁止，独立于 forbidden_paths）
  for (const f of diff.files) {
    if (isLockfile(f.file)) {
      return {
        pass: false,
        reason: 'lockfile_touched',
        detail: `${f.file} is a lockfile; idleloop will not modify dependencies`,
        diff,
      };
    }
  }

  // 3. oversized
  const totalLines = diff.insertions + diff.deletions;
  if (totalLines > opts.task.safety.max_diff_lines) {
    return {
      pass: false,
      reason: 'oversized',
      detail: `${totalLines} lines changed > max_diff_lines ${opts.task.safety.max_diff_lines}`,
      diff,
    };
  }

  return { pass: true, diff };
}

/**
 * 匹配规则（不是完整 glob）：
 *   - 以 '/' 结尾 → 目录前缀，匹配 dir/x 或 sub/dir/x
 *   - 否则 → 精确路径或文件名 basename 匹配
 */
export function matchesForbidden(filePath: string, pattern: string): boolean {
  if (pattern.endsWith('/')) {
    return (
      filePath === pattern.slice(0, -1) ||
      filePath.startsWith(pattern) ||
      filePath.includes('/' + pattern)
    );
  }
  return filePath === pattern || filePath.endsWith('/' + pattern);
}

export function isLockfile(filePath: string): boolean {
  return LOCKFILES.some((lk) => filePath === lk || filePath.endsWith('/' + lk));
}
