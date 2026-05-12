import simpleGit from 'simple-git';
import { paths, todayDateString } from '../storage/paths.js';
import type { Task, TaskResult, TaskStatus } from '../types/task.js';
import { logger as rootLogger } from '../utils/logger.js';
import { runClaude } from './claude-process.js';
import { checkSafety, type SafetyCheckResult } from './safety-gate.js';
import { runVerify, type VerifyResult } from './verify.js';
import { createWorktree, removeWorktree, type WorktreeHandle } from './worktree.js';

const log = rootLogger.child({ mod: 'runner' });

export interface RunnerOptions {
  /** 测试注入：override claude CLI 路径 */
  claudeCliPath?: string;
  /** verify 命令超时；默认 5 分钟 */
  verifyTimeoutMs?: number;
  /** 测试注入：自定义 claude 启动函数（绕过真实 spawn） */
  claudeRunner?: typeof runClaude;
}

export interface RunOptions {
  /** dry-run：跳过 worktree 和 claude，返回 status='dry_run' */
  dry?: boolean;
  /** 源仓库目录；默认 task.working_dir */
  sourceRepoDir?: string;
}

/**
 * Runner: 把 Task 落到独立 worktree 跑完。
 *
 * 流程（非 dry）：
 *   1. createWorktree(sourceRepoDir → ~/.idleloop/worktrees/{id})
 *   2. runClaude(prompt, budget) —— 在 worktree 内执行
 *   3. checkSafety —— diff lines / forbidden / lockfile
 *   4. runVerify —— task.verify_command
 *   5. 失败 → removeWorktree + 返回对应 status；成功 → 保留 worktree（让 review 看）
 *
 * dry 模式：跳过 1-5，直接返回 dry_run 结果。用于 `idleloop run --dry`。
 */
export class Runner {
  constructor(private readonly opts: RunnerOptions = {}) {}

  async execute(task: Task, runOpts: RunOptions = {}): Promise<TaskResult> {
    const startedAt = new Date();
    const date = todayDateString(startedAt);
    const shortId = task.id.replace(/^task-/, '').slice(-12);
    const tentativeBranch = `idleloop/${date}/${shortId}`;
    const tentativeWorktree = paths.worktreeFor(task.id);

    if (runOpts.dry) {
      log.info({ taskId: task.id }, 'dry-run: skipping worktree + claude + verify');
      const finishedAt = new Date();
      return {
        taskId: task.id,
        status: 'dry_run',
        branchName: tentativeBranch,
        worktreePath: tentativeWorktree,
        tokensSpent: 0,
        costUsd: 0,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        diffLinesChanged: 0,
        filesChanged: 0,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      };
    }

    const sourceRepoDir = runOpts.sourceRepoDir ?? task.working_dir;

    let handle: WorktreeHandle;
    try {
      handle = await createWorktree({ taskId: task.id, sourceRepoDir, date });
    } catch (err) {
      return errorResult(task, startedAt, tentativeBranch, tentativeWorktree, err, 0, 0);
    }

    let claudeCost = 0;
    let claudeTokens = 0;
    let safety: SafetyCheckResult | undefined;
    let verify: VerifyResult | undefined;
    try {
      const runFn = this.opts.claudeRunner ?? runClaude;
      const claudeResult = await runFn({
        cliPath: this.opts.claudeCliPath ?? 'claude',
        worktreePath: handle.worktreePath,
        prompt: task.prompt,
        budgetUsd: task.budget_usd,
      });
      claudeCost = claudeResult.totalCostUsd;
      claudeTokens = claudeResult.totalInputTokens + claudeResult.totalOutputTokens;
      if (claudeResult.exitCode !== 0) {
        await removeWorktree(handle, { force: true, deleteBranch: true });
        return finalize(
          task,
          startedAt,
          handle,
          'error',
          claudeTokens,
          claudeCost,
          0,
          0,
          `claude exited with code ${claudeResult.exitCode}`,
        );
      }

      safety = await checkSafety({ worktreePath: handle.worktreePath, task });
      if (!safety.pass) {
        const status: TaskStatus =
          safety.reason === 'oversized'
            ? 'aborted_oversized'
            : safety.reason === 'forbidden_path'
              ? 'aborted_forbidden_path'
              : 'aborted_oversized'; // lockfile 也算 oversized-like
        await removeWorktree(handle, { force: true, deleteBranch: true });
        return finalize(
          task,
          startedAt,
          handle,
          status,
          claudeTokens,
          claudeCost,
          safety.diff.filesChanged,
          safety.diff.insertions + safety.diff.deletions,
          safety.detail,
        );
      }

      verify = await runVerify({
        command: task.verify_command,
        worktreePath: handle.worktreePath,
        timeoutMs: this.opts.verifyTimeoutMs ?? 5 * 60_000,
      });
      if (!verify.pass) {
        await removeWorktree(handle, { force: true, deleteBranch: true });
        return finalize(
          task,
          startedAt,
          handle,
          'verify_failed',
          claudeTokens,
          claudeCost,
          safety.diff.filesChanged,
          safety.diff.insertions + safety.diff.deletions,
          undefined,
          verify.output,
        );
      }

      // 成功：commit 改动并保留 worktree 等 review
      const git = simpleGit({ baseDir: handle.worktreePath });
      await git.add('.');
      // diffSummary 之后再检测一遍：可能 git add 了 0 个文件（claude 没改任何东西）
      const status = await git.status();
      if (status.staged.length > 0) {
        await git.commit(`idleloop: ${task.title}`, undefined, {
          '--allow-empty': null,
        });
      }
      return finalize(
        task,
        startedAt,
        handle,
        'success',
        claudeTokens,
        claudeCost,
        safety.diff.filesChanged,
        safety.diff.insertions + safety.diff.deletions,
        undefined,
        verify.output,
      );
    } catch (err) {
      try {
        await removeWorktree(handle, { force: true, deleteBranch: true });
      } catch {
        // ignore cleanup errors
      }
      return finalize(
        task,
        startedAt,
        handle,
        'error',
        claudeTokens,
        claudeCost,
        safety?.diff.filesChanged ?? 0,
        safety ? safety.diff.insertions + safety.diff.deletions : 0,
        (err as Error).message,
      );
    }
  }
}

function errorResult(
  task: Task,
  startedAt: Date,
  branch: string,
  worktreePath: string,
  err: unknown,
  tokens: number,
  cost: number,
): TaskResult {
  const finishedAt = new Date();
  return {
    taskId: task.id,
    status: 'error',
    branchName: branch,
    worktreePath,
    tokensSpent: tokens,
    costUsd: cost,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    diffLinesChanged: 0,
    filesChanged: 0,
    errorMessage: (err as Error).message,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}

function finalize(
  task: Task,
  startedAt: Date,
  handle: WorktreeHandle,
  status: TaskStatus,
  tokens: number,
  cost: number,
  filesChanged: number,
  diffLines: number,
  errorMessage?: string,
  verifyOutput?: string,
): TaskResult {
  const finishedAt = new Date();
  return {
    taskId: task.id,
    status,
    branchName: handle.branchName,
    worktreePath: handle.worktreePath,
    tokensSpent: tokens,
    costUsd: cost,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    diffLinesChanged: diffLines,
    filesChanged,
    ...(verifyOutput !== undefined ? { verifyOutput } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}

export { runClaude } from './claude-process.js';
export { checkSafety, matchesForbidden, isLockfile } from './safety-gate.js';
export { runVerify } from './verify.js';
export { createWorktree, removeWorktree } from './worktree.js';
export type { WorktreeHandle } from './worktree.js';
export type { SafetyCheckResult, SafetyFailureReason, SafetyDiff } from './safety-gate.js';
export type { VerifyResult } from './verify.js';
