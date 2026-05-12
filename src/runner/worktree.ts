import path from 'node:path';
import simpleGit from 'simple-git';
import { ensureDir, paths, todayDateString } from '../storage/paths.js';

export interface WorktreeHandle {
  taskId: string;
  branchName: string;
  worktreePath: string;
  sourceRepoDir: string;
  baseBranch: string;
}

export interface CreateWorktreeOptions {
  taskId: string;
  sourceRepoDir: string;
  baseBranch?: string;
  date?: string;
  /** 测试可注入：work-tree 根目录；默认 paths.worktreesDir() */
  worktreeBase?: string;
}

/**
 * 在 sourceRepoDir 上创建 git worktree，分支名 `idleloop/{date}/{taskId 短 hash}`。
 * worktree 落到 ~/.idleloop/worktrees/{taskId} 下。
 *
 * 要求 sourceRepoDir 是已初始化的 git 仓库；否则 simple-git 会抛错。
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeHandle> {
  const date = opts.date ?? todayDateString();
  const shortId = opts.taskId.replace(/^task-/, '').slice(-12);
  const branchName = `idleloop/${date}/${shortId}`;
  const base = opts.worktreeBase ?? paths.worktreesDir();
  const worktreePath = path.join(base, opts.taskId);

  await ensureDir(path.dirname(worktreePath));

  const git = simpleGit({ baseDir: opts.sourceRepoDir });
  const baseBranch = opts.baseBranch ?? (await detectDefaultBranch(opts.sourceRepoDir));

  // git worktree add -b <branch> <path> <base>
  await git.raw(['worktree', 'add', '-b', branchName, worktreePath, baseBranch]);

  return {
    taskId: opts.taskId,
    branchName,
    worktreePath,
    sourceRepoDir: opts.sourceRepoDir,
    baseBranch,
  };
}

export interface RemoveWorktreeOptions {
  /** 强制删除（有未提交改动时） */
  force?: boolean;
  /** 同时删除分支 */
  deleteBranch?: boolean;
}

export async function removeWorktree(
  handle: WorktreeHandle,
  opts: RemoveWorktreeOptions = {},
): Promise<void> {
  const git = simpleGit({ baseDir: handle.sourceRepoDir });
  const args = ['worktree', 'remove', handle.worktreePath];
  if (opts.force) args.push('--force');
  await git.raw(args);

  if (opts.deleteBranch) {
    try {
      await git.raw(['branch', '-D', handle.branchName]);
    } catch {
      // 删分支失败不致命（可能已经被 prune 掉）
    }
  }
}

/**
 * 探测仓库默认分支：先看 origin/HEAD，再看 main / master。
 */
async function detectDefaultBranch(repoDir: string): Promise<string> {
  const git = simpleGit({ baseDir: repoDir });
  // 当前 HEAD 指向的分支（最常见情况）
  try {
    const current = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (current && current !== 'HEAD') return current;
  } catch {
    // ignore
  }
  for (const candidate of ['main', 'master']) {
    try {
      await git.revparse(['--verify', candidate]);
      return candidate;
    } catch {
      // ignore
    }
  }
  throw new Error(`cannot detect default branch in ${repoDir}; pass baseBranch explicitly`);
}
