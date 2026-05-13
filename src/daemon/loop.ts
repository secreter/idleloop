import { setTimeout as delay } from 'node:timers/promises';
import { runRun, type RunDeps, type RunRunOptions, type RunSummary } from '../cli/commands/run.js';
import type { Config } from '../storage/config.js';
import { logger as rootLogger } from '../utils/logger.js';

const log = rootLogger.child({ mod: 'daemon-loop' });

export interface DaemonLoopOptions {
  config: Config;
  /** 每次迭代之间的最大等待间隔（毫秒）。默认走 config.watcher.poll_interval_minutes。 */
  intervalMs?: number;
  /** 单次迭代硬性上限（毫秒）。超时则中止本次 runOnce，不阻塞后续迭代。
   *  默认走 config.runner.per_task_timeout_minutes + 2min 余量。 */
  iterationTimeoutMs?: number;
  /** 最多跑几次迭代后退出。仅用于测试 / 一次性运行；undefined 表示无限循环。 */
  maxIterations?: number;
  /** signal 注入便于优雅停机 */
  signal?: AbortSignal;
  /** runRun 注入便于测试 */
  runOnce?: (opts: RunRunOptions, deps: RunDeps) => Promise<RunSummary>;
  /** runRun 的额外依赖（如自定义 watcher / activity） */
  runDeps?: RunDeps;
  /** 测试钩子：每次迭代结束后回调 */
  onIteration?: (summary: RunSummary, n: number) => void | Promise<void>;
}

export interface DaemonLoopResult {
  iterations: number;
  lastSummary?: RunSummary;
  stoppedReason: 'signal' | 'max_iterations' | 'error';
  lastError?: Error;
}

/**
 * 守护进程主循环。
 *
 * 在不阻塞 signal 的前提下，按 poll_interval 周期调用 runRun。
 * 设计哲学：保持简单 — 没有调度抖动、没有 backoff 复杂逻辑。
 * 如果某次 runRun 失败，记录并继续，不要让一次错误拖死整个守护。
 */
export async function runDaemonLoop(opts: DaemonLoopOptions): Promise<DaemonLoopResult> {
  const interval = opts.intervalMs ?? opts.config.watcher.poll_interval_minutes * 60_000;
  const runFn = opts.runOnce ?? runRun;
  const max = opts.maxIterations ?? Infinity;
  const iterTimeout =
    opts.iterationTimeoutMs ?? (opts.config.runner.per_task_timeout_minutes + 2) * 60_000;

  let iterations = 0;
  let lastSummary: RunSummary | undefined;
  let lastError: Error | undefined;

  while (iterations < max) {
    if (opts.signal?.aborted) {
      log.info({ iterations }, 'daemon loop received abort signal before iteration');
      return { iterations, ...(lastSummary ? { lastSummary } : {}), stoppedReason: 'signal' };
    }

    iterations++;
    try {
      lastSummary = await raceWithSignalAndTimeout(
        () => runFn({}, opts.runDeps ?? {}),
        opts.signal,
        iterTimeout,
      );
      log.info(
        {
          iteration: iterations,
          triggered: lastSummary.decision.triggered,
          tasks: lastSummary.results.length,
        },
        'daemon iteration done',
      );
      if (opts.onIteration) await opts.onIteration(lastSummary, iterations);
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError' && opts.signal?.aborted) {
        log.info({ iterations }, 'daemon loop aborted during iteration');
        return {
          iterations,
          ...(lastSummary ? { lastSummary } : {}),
          ...(lastError ? { lastError } : {}),
          stoppedReason: 'signal',
        };
      }
      lastError = e;
      log.error({ err: e.message, iteration: iterations }, 'daemon iteration failed');
    }

    if (iterations >= max) break;
    if (opts.signal?.aborted) {
      return {
        iterations,
        ...(lastSummary ? { lastSummary } : {}),
        ...(lastError ? { lastError } : {}),
        stoppedReason: 'signal',
      };
    }

    try {
      await delay(interval, undefined, { signal: opts.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return {
          iterations,
          ...(lastSummary ? { lastSummary } : {}),
          ...(lastError ? { lastError } : {}),
          stoppedReason: 'signal',
        };
      }
      throw err;
    }
  }

  return {
    iterations,
    ...(lastSummary ? { lastSummary } : {}),
    ...(lastError ? { lastError } : {}),
    stoppedReason: 'max_iterations',
  };
}

/**
 * 把 runOnce() 包成一个能被信号或超时打断的 promise。
 *
 * - signal 取消时：reject AbortError（loop 检查 signal.aborted 走 'signal' 出口）
 * - 超时时：reject Error('iteration timeout exceeded ...')（loop 继续下一轮）
 *
 * 注意：这不会真的杀掉子进程 / claude，runOnce 自身需要在内部响应 signal。
 * 此函数的作用是不让单个 hang 阻塞整个 daemon。
 */
async function raceWithSignalAndTimeout<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const work = fn();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (resolveValue?: T, rejectErr?: Error) => {
      if (settled) return;
      settled = true;
      if (rejectErr) reject(rejectErr);
      else resolve(resolveValue as T);
    };

    const timeoutHandle = setTimeout(() => {
      settle(
        undefined,
        Object.assign(new Error(`iteration timeout exceeded (${timeoutMs}ms)`), {
          name: 'IterationTimeoutError',
        }),
      );
    }, timeoutMs);

    const onAbort = () => {
      settle(undefined, Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    work
      .then((v) => settle(v))
      .catch((err: Error) => settle(undefined, err))
      .finally(() => {
        clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener('abort', onAbort);
      });
  });
}
