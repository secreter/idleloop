import { stat } from 'node:fs/promises';
import { styleText } from 'node:util';
import simpleGit from 'simple-git';
import { listShiftDates, loadShiftsForDate } from '../../shift-log/index.js';
import { removeWorktree } from '../../runner/index.js';
import { paths } from '../../storage/paths.js';
import type { TaskResult } from '../../types/task.js';
import { logger as rootLogger } from '../../utils/logger.js';

const log = rootLogger.child({ mod: 'review' });

export type ReviewAction = 'merge' | 'discard' | 'keep' | 'diff' | 'quit';

/**
 * 一个候选项：可被 review 的成功任务（worktree 还在）。
 */
export interface ReviewCandidate {
  date: string;
  shiftId: string;
  result: TaskResult;
}

export interface RunReviewOptions {
  /** 只 review 指定日期；未传则取所有未 review 过的日期 */
  date?: string;
  /** 跑机器可读模式，不交互；用于脚本 */
  json?: boolean;
  /** 自动 merge 所有 confidence=auto_merge 的，无须 prompt */
  autoMergeOnly?: boolean;
  /** 限制最多处理 N 个 */
  limit?: number;
  /** 选 merge 后再额外确认一次（默认 true；交互式可信但 trust 友好） */
  confirmMerge?: boolean;
}

export interface RunReviewDeps {
  logsRoot?: string;
  /** prompt 实现，便于测试注入。默认用 @inquirer/prompts. */
  prompt?: (q: PromptInput) => Promise<ReviewAction>;
  /** print 实现 */
  print?: (s: string) => void;
  /** merge / discard 实现可注入便于测试不真跑 git */
  applyAction?: (action: ReviewAction, c: ReviewCandidate) => Promise<ReviewActionResult>;
  /** y/N 二次确认实现，默认走 @inquirer/prompts confirm */
  confirm?: (msg: string) => Promise<boolean>;
}

export interface PromptInput {
  candidate: ReviewCandidate;
  /** 显示给用户的摘要文本 */
  summary: string;
}

export interface ReviewActionResult {
  action: ReviewAction;
  ok: boolean;
  detail: string;
  /** 涉及 git 命令时的 stderr/stdout 摘要 */
  output?: string;
}

export interface RunReviewResult {
  candidates: ReviewCandidate[];
  applied: Array<{ candidate: ReviewCandidate; result: ReviewActionResult }>;
}

/**
 * `idleloop review [--date YYYY-MM-DD] [--auto-merge-only] [--limit N]`
 *
 * 流程：
 *   1. 找出所有可 review 候选：status=success + worktree 路径存在
 *   2. 对每个候选交互式问 merge / discard / keep / diff / quit
 *   3. merge：git -C source merge --no-ff <branch>；成功后 removeWorktree
 *   4. discard：removeWorktree(force, deleteBranch)
 *   5. keep：什么也不做
 *   6. diff：显示 diff 后回到 prompt
 */
export async function runReview(
  opts: RunReviewOptions = {},
  deps: RunReviewDeps = {},
): Promise<RunReviewResult> {
  const print = deps.print ?? ((s: string) => console.log(s));
  const logsRoot = deps.logsRoot ?? paths.logsDir();

  const candidates = await collectCandidates(opts.date, logsRoot);
  if (candidates.length === 0) {
    print(
      styleText('yellow', 'no reviewable tasks (no successful shifts with surviving worktrees)'),
    );
    return { candidates: [], applied: [] };
  }

  print(styleText('bold', `${candidates.length} task(s) waiting for review`));
  print('');

  const applied: RunReviewResult['applied'] = [];
  const limit = opts.limit ?? candidates.length;
  const promptFn = deps.prompt ?? defaultPrompt;
  const apply = deps.applyAction ?? defaultApplyAction;

  let count = 0;
  for (const c of candidates) {
    if (count >= limit) break;
    count++;

    print(
      styleText('bold', `[${count}/${candidates.length}] ${c.result.taskTitle ?? c.result.taskId}`),
    );
    print(styleText('dim', `  shift: ${c.shiftId}  date: ${c.date}`));
    print(`  branch:   ${c.result.branchName}`);
    print(`  worktree: ${c.result.worktreePath}`);
    print(`  diff:     ${c.result.diffLinesChanged} lines / ${c.result.filesChanged} files`);
    print(`  cost:     $${c.result.costUsd.toFixed(4)}`);
    if (c.result.sourceRepoDir) {
      print(`  source:   ${c.result.sourceRepoDir}`);
    }

    let action: ReviewAction;
    if (opts.autoMergeOnly) {
      if (c.result.confidence !== 'auto_merge') {
        print(styleText('dim', '  · skip (not auto_merge)'));
        applied.push({
          candidate: c,
          result: { action: 'keep', ok: true, detail: 'skipped (not auto_merge)' },
        });
        continue;
      }
      action = 'merge';
    } else {
      const summary = summarize(c);
      do {
        action = await promptFn({ candidate: c, summary });
        if (action === 'diff') {
          const diff = await showDiff(c);
          print(diff);
        }
      } while (action === 'diff');
    }

    if (action === 'quit') {
      print(styleText('yellow', 'aborted by user'));
      break;
    }

    // merge 二次确认（除非 confirmMerge=false 或 autoMergeOnly 模式）
    if (action === 'merge' && opts.confirmMerge !== false && !opts.autoMergeOnly) {
      const confirmFn = deps.confirm ?? defaultConfirm;
      const msg = `Merge ${c.result.diffLinesChanged} lines / ${c.result.filesChanged} files from \`${c.result.branchName}\` into \`${c.result.baseBranch ?? 'main'}\`?`;
      const ok = await confirmFn(msg);
      if (!ok) {
        print(styleText('dim', '  · merge canceled, kept for later'));
        applied.push({
          candidate: c,
          result: { action: 'keep', ok: true, detail: 'merge canceled by user' },
        });
        continue;
      }
    }

    const result = await apply(action, c);
    const tag =
      result.ok && result.action === 'merge'
        ? styleText('green', '  ✓ merged')
        : result.ok && result.action === 'discard'
          ? styleText('green', '  ✓ discarded')
          : result.ok && result.action === 'keep'
            ? styleText('dim', '  · kept')
            : styleText('red', `  ✗ ${result.detail}`);
    print(tag);
    print('');
    applied.push({ candidate: c, result });
  }

  return { candidates, applied };
}

async function collectCandidates(
  date: string | undefined,
  logsRoot: string,
): Promise<ReviewCandidate[]> {
  const dates = date ? [date] : await listShiftDates({ logsRoot });
  const out: ReviewCandidate[] = [];
  for (const d of dates) {
    const shifts = await loadShiftsForDate(d, { logsRoot });
    for (const shift of shifts) {
      for (const r of shift.results) {
        if (r.status !== 'success') continue;
        if (!(await pathExists(r.worktreePath))) continue;
        out.push({ date: d, shiftId: shift.shiftId, result: r });
      }
    }
  }
  return out;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return false;
  }
}

function summarize(c: ReviewCandidate): string {
  return [
    c.result.taskTitle ?? c.result.taskId,
    `${c.result.diffLinesChanged}L diff across ${c.result.filesChanged} files`,
    `cost $${c.result.costUsd.toFixed(4)}`,
  ].join(' · ');
}

async function defaultConfirm(msg: string): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts');
  return confirm({ message: msg, default: false });
}

async function defaultPrompt(input: PromptInput): Promise<ReviewAction> {
  // 动态 import 减少冷启动开销，并且测试默认不会用到这个分支
  const { select } = await import('@inquirer/prompts');
  return (await select({
    message: `Action for ${input.summary}?`,
    choices: [
      { name: 'merge to source repo', value: 'merge' },
      { name: 'discard (remove worktree + branch)', value: 'discard' },
      { name: 'keep (decide later)', value: 'keep' },
      { name: 'show diff', value: 'diff' },
      { name: 'quit', value: 'quit' },
    ],
  })) as ReviewAction;
}

async function defaultApplyAction(
  action: ReviewAction,
  c: ReviewCandidate,
): Promise<ReviewActionResult> {
  if (action === 'keep') {
    return { action, ok: true, detail: 'kept (no changes applied)' };
  }
  const baseBranch = c.result.baseBranch ?? 'main';
  if (action === 'discard') {
    try {
      await removeWorktree(
        {
          taskId: c.result.taskId,
          branchName: c.result.branchName,
          worktreePath: c.result.worktreePath,
          sourceRepoDir: c.result.sourceRepoDir ?? '',
          baseBranch,
        },
        { force: true, deleteBranch: true },
      );
      return { action, ok: true, detail: 'worktree removed and branch deleted' };
    } catch (err) {
      return { action, ok: false, detail: `failed to remove worktree: ${(err as Error).message}` };
    }
  }
  if (action === 'merge') {
    if (!c.result.sourceRepoDir) {
      return { action, ok: false, detail: 'sourceRepoDir unknown; cannot merge' };
    }
    const git = simpleGit({ baseDir: c.result.sourceRepoDir });
    let restoreBranch: string | null = null;
    try {
      const status = await git.status();
      if (!status.isClean()) {
        return {
          action,
          ok: false,
          detail: `source repo ${c.result.sourceRepoDir} has uncommitted changes; commit or stash first`,
        };
      }
      const current = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      if (current !== baseBranch) {
        restoreBranch = current;
        await git.checkout(baseBranch);
      }
      const safeTitle = (c.result.taskTitle ?? c.result.taskId).slice(0, 80);
      const out = await git.raw([
        'merge',
        '--no-ff',
        '-m',
        `idleloop merge: ${safeTitle}`,
        c.result.branchName,
      ]);
      log.debug({ taskId: c.result.taskId, out }, 'merge succeeded');
      if (restoreBranch) {
        await git.checkout(restoreBranch).catch((err: Error) => {
          log.warn({ err: err.message }, 'failed to restore original branch after merge');
        });
        restoreBranch = null;
      }
      try {
        await removeWorktree(
          {
            taskId: c.result.taskId,
            branchName: c.result.branchName,
            worktreePath: c.result.worktreePath,
            sourceRepoDir: c.result.sourceRepoDir,
            baseBranch,
          },
          { force: false, deleteBranch: true },
        );
      } catch (err) {
        return {
          action,
          ok: true,
          detail: `merged but worktree cleanup failed: ${(err as Error).message}`,
        };
      }
      return { action, ok: true, detail: 'merged and worktree cleaned up' };
    } catch (err) {
      if (restoreBranch) {
        await git.checkout(restoreBranch).catch(() => {
          // log only; user must recover manually
        });
      }
      return { action, ok: false, detail: `merge failed: ${(err as Error).message}` };
    }
  }
  return { action, ok: false, detail: `unknown action ${action as string}` };
}

async function showDiff(c: ReviewCandidate): Promise<string> {
  try {
    const git = simpleGit({ baseDir: c.result.worktreePath });
    // 优先显示最近一次 commit 的 patch（worktree 在 success 时会有 1 个 commit）
    try {
      const out = await git.raw(['log', '-1', '--patch']);
      if (out.trim().length > 0) return out;
    } catch {
      // ignore
    }
    const fallback = await git.raw(['diff', 'HEAD']);
    return fallback || '(no diff)';
  } catch (err) {
    return styleText('red', `diff failed: ${(err as Error).message}`);
  }
}
