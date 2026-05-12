import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorktree, removeWorktree } from '../../src/runner/worktree.js';

async function initRepo(dir: string): Promise<void> {
  await execa('git', ['init', '-q'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@idleloop'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'test'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  // 提交后再 rename（git < 2.28 兼容）
  try {
    await execa('git', ['branch', '-M', 'main'], { cwd: dir });
  } catch {
    // ignore
  }
}

describe('worktree', () => {
  let sourceRepo: string;
  let worktreeBase: string;

  beforeEach(async () => {
    sourceRepo = await mkdtemp(path.join(tmpdir(), 'idleloop-wt-src-'));
    worktreeBase = await mkdtemp(path.join(tmpdir(), 'idleloop-wt-base-'));
    await initRepo(sourceRepo);
  });

  afterEach(async () => {
    await rm(sourceRepo, { recursive: true, force: true });
    await rm(worktreeBase, { recursive: true, force: true });
  });

  it('创建 worktree：分支名带 date + shortId', async () => {
    const handle = await createWorktree({
      taskId: 'task-abcdef123456',
      sourceRepoDir: sourceRepo,
      worktreeBase,
      date: '2026-05-13',
    });
    expect(handle.branchName).toBe('idleloop/2026-05-13/abcdef123456');
    expect(handle.worktreePath).toBe(path.join(worktreeBase, 'task-abcdef123456'));
    expect(handle.baseBranch).toBe('main');
    const s = await stat(handle.worktreePath);
    expect(s.isDirectory()).toBe(true);
    // worktree 里应该有 README.md
    const r = await stat(path.join(handle.worktreePath, 'README.md'));
    expect(r.isFile()).toBe(true);
  });

  it('removeWorktree 把目录删掉', async () => {
    const handle = await createWorktree({
      taskId: 'task-1',
      sourceRepoDir: sourceRepo,
      worktreeBase,
      date: '2026-05-13',
    });
    await removeWorktree(handle, { force: true, deleteBranch: true });
    await expect(stat(handle.worktreePath)).rejects.toThrow();
  });

  it('非 git 仓库抛错', async () => {
    const nonRepo = await mkdtemp(path.join(tmpdir(), 'idleloop-nonrepo-'));
    try {
      await expect(
        createWorktree({
          taskId: 'task-x',
          sourceRepoDir: nonRepo,
          worktreeBase,
          date: '2026-05-13',
        }),
      ).rejects.toThrow();
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });
});
