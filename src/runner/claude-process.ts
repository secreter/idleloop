import { execa, type ResultPromise } from 'execa';
import { logger as rootLogger } from '../utils/logger.js';

const log = rootLogger.child({ mod: 'claude-process' });

export interface ClaudeRunOptions {
  cliPath?: string;
  worktreePath: string;
  prompt: string;
  budgetUsd: number;
  /** 允许的工具列表（如 'Read,Edit,Write,Bash'） */
  allowedTools?: string;
  /** 模型别名（'sonnet' / 'opus' / 'haiku'）；不传走 claude 默认 */
  model?: string;
  /** 超时 ms，默认 30 分钟 */
  timeoutMs?: number;
}

export interface ClaudeRunResult {
  exitCode: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  rawLog: string;
}

/**
 * 启动 `claude` CLI 跑一个任务。
 *
 * 命令构成（见 docs/IMPLEMENTATION_PLAN.md §2.2）：
 *   claude --print
 *          --output-format stream-json
 *          --include-partial-messages
 *          --input-format text
 *          --add-dir <worktreePath>
 *          --allowedTools Read,Edit,Write,Bash
 *          --max-budget-usd <budget>
 *          --dangerously-skip-permissions
 *          --no-session-persistence
 *          --bare
 *
 * Phase 1 starter：本函数实现了完整启动 + stream 解析逻辑，但 dry-run 模式由
 * Runner 决定是否调用本函数。真实多任务联调留到 Phase 2。
 */
export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const cli = opts.cliPath ?? 'claude';
  const allowedTools = opts.allowedTools ?? 'Read,Edit,Write,Bash';
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--input-format',
    'text',
    '--add-dir',
    opts.worktreePath,
    '--allowedTools',
    allowedTools,
    '--max-budget-usd',
    String(opts.budgetUsd),
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--bare',
  ];
  if (opts.model) args.push('--model', opts.model);

  log.info({ cli, args, cwd: opts.worktreePath }, 'launching claude');

  const subprocess: ResultPromise = execa(cli, args, {
    cwd: opts.worktreePath,
    input: opts.prompt,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 30 * 60_000,
    reject: false,
    buffer: true,
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  const logLines: string[] = [];

  const stdout = subprocess.stdout;
  if (stdout) {
    stdout.setEncoding('utf-8');
    let buf = '';
    stdout.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        logLines.push(line);
        const stats = parseStreamEvent(line);
        if (stats) {
          totalInputTokens += stats.inputTokens;
          totalOutputTokens += stats.outputTokens;
          totalCostUsd += stats.costUsd;
        }
      }
    });
  }

  const result = await subprocess;

  return {
    exitCode: result.exitCode ?? null,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    rawLog: logLines.join('\n'),
  };
}

interface StreamEventStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * 解析 stream-json 单行事件。只关心 usage 信息。
 *
 * Claude Code 的 stream-json 在不同事件类型下携带不同字段；我们只取末位的
 * `message.usage` 块累加。schema 没正式文档化，这里宽容处理：找不到字段就返 null。
 *
 * 已知字段（猜测/实测）：
 *   { type: 'assistant', message: { usage: { input_tokens, output_tokens,
 *     cache_creation_input_tokens, cache_read_input_tokens } } }
 *   { type: 'result', usage: {...}, total_cost_usd: 0.1234 }
 */
export function parseStreamEvent(line: string): StreamEventStats | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const usage = extractUsage(evt);
  if (!usage) return null;
  return usage;
}

function extractUsage(evt: Record<string, unknown>): StreamEventStats | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  const u =
    (evt['usage'] as Record<string, unknown> | undefined) ??
    extractNested(evt, ['message', 'usage']);
  if (u) {
    if (typeof u['input_tokens'] === 'number') inputTokens = u['input_tokens'];
    if (typeof u['output_tokens'] === 'number') outputTokens = u['output_tokens'];
  }
  if (typeof evt['total_cost_usd'] === 'number') costUsd = evt['total_cost_usd'];
  if (inputTokens === 0 && outputTokens === 0 && costUsd === 0) return null;
  return { inputTokens, outputTokens, costUsd };
}

function extractNested(obj: unknown, path: string[]): Record<string, unknown> | undefined {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur != null && typeof cur === 'object' ? (cur as Record<string, unknown>) : undefined;
}
