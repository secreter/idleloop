import { execa } from 'execa';

export interface VerifyResult {
  pass: boolean;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunVerifyOptions {
  command: string;
  worktreePath: string;
  /** 默认 5 分钟 */
  timeoutMs?: number;
}

/**
 * 在 worktreePath 下用 shell 跑 verify 命令。
 *
 * 因为 verify_command 经常是 `npm test || tsc --noEmit` 这种带 shell 操作符的，
 * 必须用 shell 解释。stdout + stderr 合并到 output。
 */
export async function runVerify(opts: RunVerifyOptions): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const start = Date.now();
  const result = await execa(opts.command, [], {
    cwd: opts.worktreePath,
    shell: true,
    timeout: timeoutMs,
    reject: false,
    all: true,
    encoding: 'utf8',
  });
  return {
    pass: result.exitCode === 0,
    exitCode: result.exitCode ?? null,
    output: result.all ?? '',
    timedOut: result.timedOut === true,
    durationMs: Date.now() - start,
  };
}
