import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReview, type ReviewAction } from '../../src/cli/commands/review.js';
import { ShiftLogWriter } from '../../src/shift-log/index.js';
import type { TaskResult } from '../../src/types/task.js';

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const git = simpleGit({ baseDir: dir });
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'tester');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(`${dir}/README.md`, '# hello\n');
  await git.add('.');
  await git.commit('initial');
  // git < 2.28 兼容：commit 之后再 rename，否则空 repo 无法 -M
  try {
    await git.raw(['branch', '-M', 'main']);
  } catch {
    // ignore：保持 master，测试需要时把 baseBranch 显式传 master
  }
}

function makeResult(over: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: 'task-A',
    taskTitle: 'demo task',
    confidence: 'review_queue',
    status: 'success',
    branchName: 'idleloop/2026-05-13/task-A',
    worktreePath: '/tmp/wt-fake',
    sourceRepoDir: '/tmp/repo-fake',
    tokensSpent: 100,
    costUsd: 0.02,
    durationMs: 1000,
    diffLinesChanged: 5,
    filesChanged: 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...over,
  };
}

describe('runReview', () => {
  let logsRoot: string;
  const out: string[] = [];
  const print = (s: string) => out.push(s);

  beforeEach(async () => {
    logsRoot = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-logs-'));
    out.length = 0;
  });

  afterEach(async () => {
    await rm(logsRoot, { recursive: true, force: true });
  });

  async function seed(results: TaskResult[], date = '2026-05-13'): Promise<void> {
    const writer = new ShiftLogWriter({ rootDir: `${logsRoot}/${date}` });
    await writer.record({
      startedAt: new Date(),
      finishedAt: new Date(),
      decision: { triggered: true, reason: 'ok' },
      snapshot: null,
      tasks: [],
      results,
      strategies: [],
    });
  }

  it('没有候选时友好提示', async () => {
    const r = await runReview({}, { logsRoot, print });
    expect(r.candidates).toHaveLength(0);
    expect(out.some((l) => /no reviewable tasks/.test(l))).toBe(true);
  });

  it('过滤掉 worktree 已经消失的 result', async () => {
    await seed([makeResult({ worktreePath: '/definitely/does/not/exist' })]);
    const r = await runReview({}, { logsRoot, print });
    expect(r.candidates).toHaveLength(0);
  });

  it('keep 动作：什么也不做，只标记 result', async () => {
    const wt = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-wt-'));
    try {
      await seed([makeResult({ worktreePath: wt })]);
      const r = await runReview(
        {},
        {
          logsRoot,
          print,
          prompt: async () => 'keep' as ReviewAction,
        },
      );
      expect(r.candidates).toHaveLength(1);
      expect(r.applied).toHaveLength(1);
      expect(r.applied[0]?.result.action).toBe('keep');
      expect(r.applied[0]?.result.ok).toBe(true);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it('quit 动作：立即停止后续候选', async () => {
    const wt1 = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-wt-'));
    const wt2 = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-wt-'));
    try {
      await seed([
        makeResult({ taskId: 'task-1', worktreePath: wt1 }),
        makeResult({ taskId: 'task-2', worktreePath: wt2 }),
      ]);
      const r = await runReview(
        {},
        {
          logsRoot,
          print,
          prompt: async () => 'quit' as ReviewAction,
        },
      );
      expect(r.candidates).toHaveLength(2);
      expect(r.applied).toHaveLength(0);
    } finally {
      await rm(wt1, { recursive: true, force: true });
      await rm(wt2, { recursive: true, force: true });
    }
  });

  it('autoMergeOnly 跳过 confidence != auto_merge 的候选', async () => {
    const wt = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-wt-'));
    try {
      await seed([makeResult({ worktreePath: wt, confidence: 'review_queue' })]);
      const r = await runReview(
        { autoMergeOnly: true },
        {
          logsRoot,
          print,
          // 不应该被调用：autoMergeOnly 模式跳过非 auto_merge
          prompt: async () => {
            throw new Error('should not prompt');
          },
        },
      );
      expect(r.applied).toHaveLength(1);
      expect(r.applied[0]?.result.action).toBe('keep');
      expect(r.applied[0]?.result.detail).toMatch(/not auto_merge/);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it('merge 走 applyAction 注入桩，记录 result', async () => {
    const wt = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-wt-'));
    try {
      await seed([makeResult({ worktreePath: wt, confidence: 'auto_merge' })]);
      const calls: string[] = [];
      const r = await runReview(
        { autoMergeOnly: true },
        {
          logsRoot,
          print,
          applyAction: async (action, c) => {
            calls.push(`${action}:${c.result.taskId}`);
            return { action, ok: true, detail: `did ${action}` };
          },
        },
      );
      expect(calls).toEqual(['merge:task-A']);
      expect(r.applied[0]?.result.ok).toBe(true);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it('limit 限制处理数量', async () => {
    const wts: string[] = [];
    for (let i = 0; i < 3; i++) {
      wts.push(await mkdtemp(path.join(tmpdir(), 'idleloop-rev-wt-')));
    }
    try {
      await seed(wts.map((wt, i) => makeResult({ taskId: `task-${i}`, worktreePath: wt })));
      const r = await runReview(
        { limit: 2 },
        {
          logsRoot,
          print,
          prompt: async () => 'keep' as ReviewAction,
        },
      );
      expect(r.candidates).toHaveLength(3);
      expect(r.applied).toHaveLength(2);
    } finally {
      for (const wt of wts) await rm(wt, { recursive: true, force: true });
    }
  });

  it('diff 动作：调用 prompt 后再次 prompt（diff 不终止循环）', async () => {
    const wt = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-wt-'));
    try {
      await seed([makeResult({ worktreePath: wt })]);
      let times = 0;
      const r = await runReview(
        {},
        {
          logsRoot,
          print,
          prompt: async () => {
            times++;
            return (times === 1 ? 'diff' : 'keep') as ReviewAction;
          },
        },
      );
      expect(times).toBe(2);
      expect(r.applied[0]?.result.action).toBe('keep');
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });
});

describe('runReview real git merge happy path', () => {
  let logsRoot: string;
  const out: string[] = [];
  const print = (s: string) => out.push(s);

  beforeEach(async () => {
    logsRoot = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-logs-'));
    out.length = 0;
  });

  afterEach(async () => {
    await rm(logsRoot, { recursive: true, force: true });
  });

  it('真实 git worktree + merge：合入后 worktree 被清理', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-repo-'));
    await initRepo(repo);
    const wtBase = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-wtbase-'));
    const wt = path.join(wtBase, 'task-A');

    const git = simpleGit({ baseDir: repo });
    await git.raw(['worktree', 'add', '-b', 'idleloop/2026-05-13/task-A', wt]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${wt}/feature.txt`, 'new feature\n');
    const wtGit = simpleGit({ baseDir: wt });
    await wtGit.add('.');
    await wtGit.commit('idleloop: feature');

    const writer = new ShiftLogWriter({ rootDir: `${logsRoot}/2026-05-13` });
    await writer.record({
      startedAt: new Date(),
      finishedAt: new Date(),
      decision: { triggered: true, reason: 'ok' },
      snapshot: null,
      tasks: [],
      results: [
        {
          taskId: 'task-A',
          taskTitle: 'feature',
          confidence: 'review_queue',
          status: 'success',
          branchName: 'idleloop/2026-05-13/task-A',
          worktreePath: wt,
          sourceRepoDir: repo,
          baseBranch: 'main',
          tokensSpent: 100,
          costUsd: 0.02,
          durationMs: 1000,
          diffLinesChanged: 1,
          filesChanged: 1,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      ],
      strategies: [],
    });

    const r = await runReview(
      {},
      {
        logsRoot,
        print,
        prompt: async () => 'merge' as ReviewAction,
        confirm: async () => true,
      },
    );
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0]?.result.ok).toBe(true);
    expect(r.applied[0]?.result.action).toBe('merge');

    const { stat } = await import('node:fs/promises');
    let worktreeStillThere = true;
    try {
      await stat(wt);
    } catch {
      worktreeStillThere = false;
    }
    expect(worktreeStillThere).toBe(false);

    const log = await simpleGit({ baseDir: repo }).log();
    expect(log.all.some((c) => /idleloop merge: feature/.test(c.message))).toBe(true);

    await rm(repo, { recursive: true, force: true });
    await rm(wtBase, { recursive: true, force: true });
  });

  it('confirmMerge=true 但用户回答 No：merge 被取消，转为 keep', async () => {
    const wt = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-wt-'));
    try {
      const writer = new ShiftLogWriter({ rootDir: `${logsRoot}/2026-05-13` });
      await writer.record({
        startedAt: new Date(),
        finishedAt: new Date(),
        decision: { triggered: true, reason: 'ok' },
        snapshot: null,
        tasks: [],
        results: [
          {
            taskId: 'task-N',
            taskTitle: 'a feature',
            confidence: 'review_queue',
            status: 'success',
            branchName: 'idleloop/2026-05-13/task-N',
            worktreePath: wt,
            sourceRepoDir: '/tmp/fake',
            baseBranch: 'main',
            tokensSpent: 0,
            costUsd: 0,
            durationMs: 0,
            diffLinesChanged: 1,
            filesChanged: 1,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          },
        ],
        strategies: [],
      });

      const applyAction = vi.fn();
      const r = await runReview(
        { confirmMerge: true },
        {
          logsRoot,
          print,
          prompt: async () => 'merge' as ReviewAction,
          confirm: async () => false,
          applyAction,
        },
      );
      expect(r.applied[0]?.result.action).toBe('keep');
      expect(r.applied[0]?.result.detail).toMatch(/canceled/);
      expect(applyAction).not.toHaveBeenCalled();
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it('源仓库有未提交改动时拒绝 merge', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-repo-'));
    await initRepo(repo);
    const wtBase = await mkdtemp(path.join(tmpdir(), 'idleloop-rev-wtbase-'));
    const wt = path.join(wtBase, 'task-D');

    const git = simpleGit({ baseDir: repo });
    await git.raw(['worktree', 'add', '-b', 'idleloop/2026-05-13/task-D', wt]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${wt}/feature.txt`, 'new\n');
    const wtGit = simpleGit({ baseDir: wt });
    await wtGit.add('.');
    await wtGit.commit('idleloop: feat');

    // 在源仓库制造未提交改动
    await writeFile(`${repo}/dirty.txt`, 'wip');

    const writer = new ShiftLogWriter({ rootDir: `${logsRoot}/2026-05-13` });
    await writer.record({
      startedAt: new Date(),
      finishedAt: new Date(),
      decision: { triggered: true, reason: 'ok' },
      snapshot: null,
      tasks: [],
      results: [
        {
          taskId: 'task-D',
          taskTitle: 'feat',
          confidence: 'review_queue',
          status: 'success',
          branchName: 'idleloop/2026-05-13/task-D',
          worktreePath: wt,
          sourceRepoDir: repo,
          baseBranch: 'main',
          tokensSpent: 0,
          costUsd: 0,
          durationMs: 0,
          diffLinesChanged: 1,
          filesChanged: 1,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      ],
      strategies: [],
    });

    const r = await runReview(
      {},
      {
        logsRoot,
        print,
        prompt: async () => 'merge' as ReviewAction,
        confirm: async () => true,
      },
    );
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0]?.result.ok).toBe(false);
    expect(r.applied[0]?.result.detail).toMatch(/uncommitted changes/);

    // 源仓库的脏改动还在（我们没动它）
    const { stat } = await import('node:fs/promises');
    await expect(stat(`${repo}/dirty.txt`)).resolves.toBeTruthy();
    // worktree 仍存在
    await expect(stat(wt)).resolves.toBeTruthy();

    await rm(repo, { recursive: true, force: true });
    await rm(wtBase, { recursive: true, force: true });
  });
});
