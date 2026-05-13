import type { TaskResult, TaskStatus } from '../types/task.js';
import type { ShiftRenderInput, ShiftState } from './types.js';

/**
 * 把 ShiftState 渲染成 markdown。供 ~/.idleloop/logs/{date}/shift.md 直接 cat。
 *
 * 目标读者：第二天早上的用户。所以：
 *   - 顶部一眼看到「这个 shift 干了几件事，花了多少钱」
 *   - 然后是触发上下文（quota 状态 + 为什么触发）
 *   - 再是每个 task 的详情（status / branch / verify / safety）
 *   - 最后是 review 命令提示，方便复制粘贴
 */
export function renderShiftMarkdown(input: ShiftRenderInput): string {
  const { state } = input;
  const out: string[] = [];

  out.push(`# Shift ${state.shiftId}`);
  out.push('');
  out.push(`- date: ${state.date}`);
  out.push(`- started: ${state.startedAt}`);
  out.push(`- finished: ${state.finishedAt}`);
  out.push(`- duration: ${formatDuration(state.startedAt, state.finishedAt)}`);
  out.push('');

  out.push(`## Summary`);
  out.push('');
  out.push(headline(state));
  out.push('');

  out.push(`## Trigger`);
  out.push('');
  out.push('```');
  out.push(`triggered: ${state.decision.triggered}`);
  out.push(`reason:    ${state.decision.reason}`);
  if (state.decision.blockedBy) out.push(`blockedBy: ${state.decision.blockedBy}`);
  if (state.decision.windowType) out.push(`window:    ${state.decision.windowType}`);
  if (state.decision.remainingPct != null) {
    out.push(`remaining: ${state.decision.remainingPct.toFixed(1)}%`);
  }
  if (state.decision.msUntilReset != null) {
    out.push(`reset_in:  ${formatMs(state.decision.msUntilReset)}`);
  }
  out.push('```');
  out.push('');

  if (state.snapshot) {
    out.push(`## Quota Snapshot`);
    out.push('');
    out.push('| Window | Remaining | Resets At |');
    out.push('|---|---|---|');
    out.push(
      `| 5h | ${state.snapshot.fiveHour.remainingPct.toFixed(1)}% | ${
        state.snapshot.fiveHour.resetsAt?.toISOString() ?? 'unknown'
      } |`,
    );
    out.push(
      `| 7d | ${state.snapshot.sevenDay.remainingPct.toFixed(1)}% | ${
        state.snapshot.sevenDay.resetsAt?.toISOString() ?? 'unknown'
      } |`,
    );
    out.push('');
  }

  if (state.strategies.length > 0) {
    out.push(`## Curator`);
    out.push('');
    out.push('| Strategy | Discovered | Skipped | Error |');
    out.push('|---|---|---|---|');
    for (const s of state.strategies) {
      out.push(`| ${s.name} | ${s.discovered} | ${s.skipped} | ${s.error ?? ''} |`);
    }
    out.push('');
  }

  out.push(`## Tasks`);
  out.push('');
  if (state.results.length === 0) {
    out.push('_no tasks executed in this shift._');
    out.push('');
  } else {
    for (const r of state.results) {
      out.push(renderTaskSection(r));
      out.push('');
    }
  }

  out.push(`## Review`);
  out.push('');
  const reviewable = state.results.filter((r) => r.status === 'success');
  if (reviewable.length === 0) {
    out.push('_nothing to review (no successful tasks)._');
  } else {
    out.push(`Run \`idleloop review --date ${state.date}\` to triage each branch.`);
    out.push('');
    out.push('Or inspect manually:');
    out.push('');
    out.push('```bash');
    for (const r of reviewable) {
      out.push(`# ${r.taskId}`);
      const base = r.baseBranch ?? 'main';
      out.push(`cd ${r.worktreePath} && git log -1 && git diff ${base}`);
    }
    out.push('```');
  }
  out.push('');

  return out.join('\n');
}

function headline(state: ShiftState): string {
  // 触发被拦截：让读者一眼看出「没干活是因为没该干」，而不是误以为 idleloop 挂了
  if (!state.decision.triggered && state.results.length === 0) {
    return `Blocked: ${state.blocked?.blockedBy ?? state.decision.blockedBy ?? 'unknown'} · ${state.decision.reason}`;
  }
  const buckets: Record<TaskStatus, number> = {
    success: 0,
    verify_failed: 0,
    aborted_oversized: 0,
    aborted_budget: 0,
    aborted_forbidden_path: 0,
    error: 0,
    dry_run: 0,
  };
  for (const r of state.results) buckets[r.status]++;

  const parts: string[] = [];
  parts.push(`Tasks: ${state.results.length}`);
  if (buckets.success > 0) parts.push(`success=${buckets.success}`);
  if (buckets.verify_failed > 0) parts.push(`verify_failed=${buckets.verify_failed}`);
  if (buckets.aborted_oversized + buckets.aborted_budget + buckets.aborted_forbidden_path > 0) {
    parts.push(
      `aborted=${
        buckets.aborted_oversized + buckets.aborted_budget + buckets.aborted_forbidden_path
      }`,
    );
  }
  if (buckets.error > 0) parts.push(`error=${buckets.error}`);
  if (buckets.dry_run > 0) parts.push(`dry_run=${buckets.dry_run}`);
  parts.push(`cost=$${state.totalCostUsd.toFixed(4)}`);
  parts.push(`tokens=${state.totalTokens}`);
  return parts.join(' · ');
}

function renderTaskSection(r: TaskResult): string {
  const lines: string[] = [];
  lines.push(`### ${r.taskId} — \`${r.status}\``);
  lines.push('');
  lines.push(`- branch: \`${r.branchName}\``);
  lines.push(`- worktree: \`${r.worktreePath}\``);
  lines.push(`- cost: $${r.costUsd.toFixed(4)} (${r.tokensSpent} tokens)`);
  lines.push(`- diff: ${r.diffLinesChanged} lines across ${r.filesChanged} files`);
  lines.push(`- duration: ${formatMs(r.durationMs)}`);
  if (r.errorMessage) {
    lines.push('');
    lines.push('**Error:**');
    lines.push('');
    lines.push('```');
    lines.push(r.errorMessage);
    lines.push('```');
  }
  if (r.verifyOutput && r.status !== 'success') {
    lines.push('');
    lines.push('**Verify output (tail):**');
    lines.push('');
    lines.push('```');
    lines.push(tail(r.verifyOutput, 30));
    lines.push('```');
  }
  return lines.join('\n');
}

function tail(s: string, n: number): string {
  const lines = s.split('\n');
  if (lines.length <= n) return s;
  return ['... (truncated)', ...lines.slice(-n)].join('\n');
}

function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

function formatDuration(start: string, finish: string): string {
  const ms = new Date(finish).getTime() - new Date(start).getTime();
  return formatMs(Math.max(0, ms));
}
