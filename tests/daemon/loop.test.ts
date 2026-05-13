import { describe, expect, it, vi } from 'vitest';
import { runDaemonLoop } from '../../src/daemon/loop.js';
import { parseConfig } from '../../src/storage/config.js';

describe('runDaemonLoop', () => {
  it('maxIterations=3 时跑 3 次后正常退出', async () => {
    const cfg = parseConfig({});
    const calls: number[] = [];
    const runOnce = vi.fn().mockImplementation(async () => {
      calls.push(Date.now());
      return {
        decision: { triggered: false, reason: 'x' },
        tasks: [],
        results: [],
        perStrategy: [],
        snapshot: null,
        startedAt: '',
        finishedAt: '',
      };
    });

    const result = await runDaemonLoop({
      config: cfg,
      intervalMs: 5,
      maxIterations: 3,
      runOnce,
    });

    expect(result.iterations).toBe(3);
    expect(result.stoppedReason).toBe('max_iterations');
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it('runOnce 抛错时继续，最终 stoppedReason=max_iterations 且 lastError 留底', async () => {
    const cfg = parseConfig({});
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce({
        decision: { triggered: false, reason: 'ok-1' },
        tasks: [],
        results: [],
        perStrategy: [],
        snapshot: null,
        startedAt: '',
        finishedAt: '',
      })
      .mockRejectedValueOnce(new Error('transient bug'))
      .mockResolvedValueOnce({
        decision: { triggered: false, reason: 'ok-3' },
        tasks: [],
        results: [],
        perStrategy: [],
        snapshot: null,
        startedAt: '',
        finishedAt: '',
      });

    const result = await runDaemonLoop({
      config: cfg,
      intervalMs: 5,
      maxIterations: 3,
      runOnce,
    });

    expect(result.iterations).toBe(3);
    expect(result.stoppedReason).toBe('max_iterations');
    expect(result.lastError?.message).toBe('transient bug');
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it('AbortSignal 触发：迭代中途立即停止', async () => {
    const cfg = parseConfig({});
    const controller = new AbortController();
    const runOnce = vi.fn().mockImplementation(async () => {
      controller.abort();
      return {
        decision: { triggered: false, reason: 'x' },
        tasks: [],
        results: [],
        perStrategy: [],
        snapshot: null,
        startedAt: '',
        finishedAt: '',
      };
    });

    const result = await runDaemonLoop({
      config: cfg,
      intervalMs: 200_000, // 足够长，让 abort 决定退出
      maxIterations: 5,
      signal: controller.signal,
      runOnce,
    });

    expect(result.stoppedReason).toBe('signal');
    expect(result.iterations).toBe(1);
  });

  it('iterationTimeoutMs：runOnce 卡死时本次迭代超时，循环继续', async () => {
    const cfg = parseConfig({});
    let calls = 0;
    const runOnce = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        // 第一次永远不 resolve
        return new Promise(() => {});
      }
      return {
        decision: { triggered: false, reason: 'ok' },
        tasks: [],
        results: [],
        perStrategy: [],
        snapshot: null,
        startedAt: '',
        finishedAt: '',
      };
    });

    const result = await runDaemonLoop({
      config: cfg,
      intervalMs: 1,
      maxIterations: 2,
      iterationTimeoutMs: 50,
      runOnce,
    });
    expect(result.iterations).toBe(2);
    expect(result.lastError?.name).toBe('IterationTimeoutError');
    expect(result.stoppedReason).toBe('max_iterations');
  });

  it('AbortSignal 在 runOnce 卡死时也能立刻中止', async () => {
    const cfg = parseConfig({});
    const controller = new AbortController();
    const runOnce = vi.fn().mockImplementation(() => new Promise(() => {}));
    setTimeout(() => controller.abort(), 20);
    const result = await runDaemonLoop({
      config: cfg,
      intervalMs: 200_000,
      iterationTimeoutMs: 200_000,
      maxIterations: 5,
      signal: controller.signal,
      runOnce,
    });
    expect(result.stoppedReason).toBe('signal');
    expect(result.iterations).toBe(1);
  });

  it('onIteration 钩子每次迭代被调用', async () => {
    const cfg = parseConfig({});
    const seen: Array<{ n: number; triggered: boolean }> = [];
    const runOnce = async () => ({
      decision: { triggered: true, reason: 'ok' },
      tasks: [],
      results: [],
      perStrategy: [],
      snapshot: null,
      startedAt: '',
      finishedAt: '',
    });

    await runDaemonLoop({
      config: cfg,
      intervalMs: 1,
      maxIterations: 2,
      runOnce,
      onIteration: (s, n) => {
        seen.push({ n, triggered: s.decision.triggered });
      },
    });

    expect(seen).toEqual([
      { n: 1, triggered: true },
      { n: 2, triggered: true },
    ]);
  });
});
