import { readFile } from 'node:fs/promises';
import path from 'node:path';
import simpleGit, { type DiffResult } from 'simple-git';
import { DEFAULT_FORBIDDEN_PATHS } from '../types/forbidden.js';
import type { Task } from '../types/task.js';

export interface SafetyDiff {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{ file: string; insertions: number; deletions: number; binary: boolean }>;
}

export type SafetyFailureReason =
  | 'oversized'
  | 'forbidden_path'
  | 'lockfile_touched'
  | 'secret_leak';

export type SafetyCheckResult =
  | { pass: true; diff: SafetyDiff }
  | { pass: false; reason: SafetyFailureReason; detail: string; diff: SafetyDiff };

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

/**
 * 在 worktreePath 下用 git diff（包含未提交改动）评估安全性。
 *
 * 检查（按严格度递增，命中即停）：
 *   1. forbidden_paths（默认列表 ∪ task 自定义列表，无法被削弱）
 *   2. lockfile（package-lock.json 等）
 *   3. secret 扫描（diff 内容是否含 AWS / Anthropic / GitHub 等 token 模式）
 *   4. 总改动行数是否超过 task.safety.max_diff_lines
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

  // 1. forbidden paths —— 默认列表始终生效，与 task 自定义取并集
  const forbidden = unionForbidden(opts.task.safety.forbidden_paths);
  for (const f of diff.files) {
    for (const pattern of forbidden) {
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

  // 3. secret 扫描：仅扫文本文件，且只在新增行里找
  for (const f of diff.files) {
    if (f.binary) continue;
    const filePath = path.join(opts.worktreePath, f.file);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue; // 删除的文件 / 读不到的跳过
    }
    const hit = scanForSecrets(content);
    if (hit) {
      return {
        pass: false,
        reason: 'secret_leak',
        detail: `${f.file} contains secret-like string (${hit.kind}); refusing to keep this worktree`,
        diff,
      };
    }
  }

  // 4. oversized
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

function unionForbidden(userList: string[]): string[] {
  const set = new Set<string>(DEFAULT_FORBIDDEN_PATHS);
  for (const p of userList) set.add(p);
  return Array.from(set);
}

/**
 * 匹配规则：
 *   - 以 '/' 结尾 → 目录前缀，匹配 dir/x 或 sub/dir/x
 *   - 以 '*.' 开头 → 扩展名 glob，任意路径下凡是这个扩展名都命中
 *   - 否则 → 精确路径或文件 basename 匹配
 */
export function matchesForbidden(filePath: string, pattern: string): boolean {
  if (pattern.endsWith('/')) {
    return (
      filePath === pattern.slice(0, -1) ||
      filePath.startsWith(pattern) ||
      filePath.includes('/' + pattern)
    );
  }
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1); // 含开头的 '.'
    return filePath.endsWith(ext);
  }
  return filePath === pattern || filePath.endsWith('/' + pattern);
}

export function isLockfile(filePath: string): boolean {
  return LOCKFILES.some((lk) => filePath === lk || filePath.endsWith('/' + lk));
}

/**
 * Secret 模式扫描器。
 *
 * 命中策略：扫整个文件内容，不区分新旧行（保守起见——即使 claude 只改了一行，
 * 如果它修改的文件里历史就有 secret，我们也不让这个 worktree 留下，提示用户。
 * 这通常意味着 claude 之前生成的代码不小心把 secret 写进去了）。
 *
 * 返回 null = 未命中；返回对象 = 命中（kind 是粗粒度类型）。
 *
 * 已知误报：示例代码 / docs 里出现 `AKIA...` 字面值。可在 task md 里
 * 单独 forbidden_paths 不阻挡，或在 secret 配置（未来）里加白名单。
 */
const SECRET_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // AWS Access Key
  { kind: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'aws_secret_key', re: /aws_secret_access_key\s*=\s*['"][A-Za-z0-9/+=]{40}['"]/i },
  // Anthropic
  { kind: 'anthropic_key', re: /\bsk-ant-[a-zA-Z0-9_-]{20,}/ },
  // OpenAI
  { kind: 'openai_key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  // GitHub
  { kind: 'github_pat', re: /\bghp_[A-Za-z0-9]{30,}/ },
  { kind: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{50,}/ },
  // Slack
  { kind: 'slack_bot_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  // Google API
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // 通用：PEM 私钥
  { kind: 'pem_private_key', re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  // 通用：BASE64 token 写在 source 里（弱启发，需 >= 40 字符 + 上下文）
  // 关键字 'token' / 'secret' / 'password' / 'api_key' 后跟 = 和长字符串
  {
    kind: 'inline_secret',
    re: /\b(api[_-]?key|secret|password|token|auth[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{32,}['"]/i,
  },
];

export function scanForSecrets(content: string): { kind: string } | null {
  for (const { kind, re } of SECRET_PATTERNS) {
    if (re.test(content)) return { kind };
  }
  return null;
}
