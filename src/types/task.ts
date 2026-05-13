import { ulid } from 'ulid';
import { z } from 'zod';

/**
 * 任务定义。Task md 文件的 frontmatter 字段 + body（作为 prompt）。
 * 字段名 snake_case 保持和 markdown frontmatter 一致。
 */

export const TaskSchema = z.object({
  id: z
    .string()
    .min(1)
    .default(() => `task-${ulid()}`),
  source: z.enum(['T1', 'T2', 'T3', 'T4']),
  project: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  working_dir: z.string().min(1),
  cost_estimate_tokens: z.number().int().positive(),
  acceptance: z.string().default(''),
  verify_command: z.string().default('true'),
  confidence: z.enum(['auto_merge', 'review_queue', 'draft_only']).default('review_queue'),
  budget_usd: z.number().positive().default(1.0),
  safety: z
    .object({
      max_diff_lines: z.number().int().positive().default(800),
      forbidden_paths: z.array(z.string()).default(['.env', 'secrets/']),
    })
    .default({
      max_diff_lines: 800,
      forbidden_paths: ['.env', 'secrets/'],
    }),
  added_at: z.string().optional(),
});

export type Task = z.infer<typeof TaskSchema>;

/**
 * 任务执行结果。Runner 产出。
 */
export type TaskStatus =
  | 'success'
  | 'verify_failed'
  | 'aborted_oversized'
  | 'aborted_budget'
  | 'aborted_forbidden_path'
  | 'error'
  | 'dry_run';

export interface TaskResult {
  taskId: string;
  /** 任务 frontmatter title，方便 review/logs 展示比 id 友好 */
  taskTitle?: string;
  /** 源仓库目录（review 时 merge 回它的默认分支） */
  sourceRepoDir?: string;
  /** 源仓库的默认分支名（创建 worktree 时探测得到，review/auto_merge 都用它） */
  baseBranch?: string;
  /** 任务置信度（auto_merge / review_queue / draft_only），review 时决定流程 */
  confidence?: 'auto_merge' | 'review_queue' | 'draft_only';
  /** 当 confidence=auto_merge 且 verify 通过时是否真的合入了源仓库；false=保留 worktree 等手动 review */
  autoMerged?: boolean;
  status: TaskStatus;
  branchName: string;
  worktreePath: string;
  tokensSpent: number;
  costUsd: number;
  durationMs: number;
  diffLinesChanged: number;
  filesChanged: number;
  verifyOutput?: string;
  errorMessage?: string;
  startedAt: string;
  finishedAt: string;
}
