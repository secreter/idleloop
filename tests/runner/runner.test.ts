import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Runner } from '../../src/runner/index.js';
import type { Task } from '../../src/types/task.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-test-001',
    source: 'T1',
    project: 'fixture',
    title: 'Test task',
    prompt: 'Add a file called hello.txt with content "hi"',
    working_dir: '/tmp/will-be-overridden',
    cost_estimate_tokens: 1000,
    acceptance: 'hello.txt exists',
    verify_command: 'test -f hello.txt',
    confidence: 'review_queue',
    budget_usd: 0.1,
    safety: { max_diff_lines: 50, forbidden_paths: ['.env', 'secrets/'] },
    ...overrides,
  };
}

async function initRepo(dir: string): Promise<void> {
  await execa('git', ['init', '-q'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@idleloop'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'test'], { cwd: dir });
  await writeFile(path.join(dir, 'seed.txt'), 'seed\n');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  try {
    await execa('git', ['branch', '-M', 'main'], { cwd: dir });
  } catch {
    // ignore
  }
}

describe('Runner', () => {
  let sourceRepo: string;
  const originalHome = process.env['HOME'];
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(path.join(tmpdir(), 'idleloop-runner-home-'));
    process.env['HOME'] = testHome;
    sourceRepo = await mkdtemp(path.join(tmpdir(), 'idleloop-runner-src-'));
    await initRepo(sourceRepo);
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await rm(sourceRepo, { recursive: true, force: true });
    await rm(testHome, { recursive: true, force: true });
  });

  it('dry-run 直接返回 dry_run，不创建 worktree、不启 claude', async () => {
    const claudeSpy = vi.fn();
    const r = new Runner({ claudeRunner: claudeSpy });
    const result = await r.execute(task(), { dry: true });
    expect(result.status).toBe('dry_run');
    expect(result.tokensSpent).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(result.branchName).toMatch(/^idleloop\/\d{4}-\d{2}-\d{2}\/test-001$/);
    expect(claudeSpy).not.toHaveBeenCalled();
  });

  it('happy path：claude 写文件 → safety pass → verify pass → success', async () => {
    const claudeRunner = vi.fn().mockImplementation(async (opts: { worktreePath: string }) => {
      // 模拟 claude 在 worktree 里写了 hello.txt
      await writeFile(path.join(opts.worktreePath, 'hello.txt'), 'hi\n');
      return {
        exitCode: 0,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalCostUsd: 0.05,
        rawLog: '',
      };
    });
    const runner = new Runner({ claudeRunner });
    const result = await runner.execute(task(), { sourceRepoDir: sourceRepo });
    expect(result.status).toBe('success');
    expect(result.tokensSpent).toBe(150);
    expect(result.costUsd).toBe(0.05);
    expect(result.filesChanged).toBe(1);
    expect(result.diffLinesChanged).toBe(1);
  });

  it('safety oversized 中止', async () => {
    const big = 'X\n'.repeat(200); // 200 行
    const claudeRunner = vi.fn().mockImplementation(async (opts: { worktreePath: string }) => {
      await writeFile(path.join(opts.worktreePath, 'big.txt'), big);
      return {
        exitCode: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        rawLog: '',
      };
    });
    const runner = new Runner({ claudeRunner });
    const result = await runner.execute(
      task({ safety: { max_diff_lines: 50, forbidden_paths: [] } }),
      { sourceRepoDir: sourceRepo },
    );
    expect(result.status).toBe('aborted_oversized');
    expect(result.errorMessage).toMatch(/max_diff_lines/);
  });

  it('forbidden path 中止', async () => {
    const claudeRunner = vi.fn().mockImplementation(async (opts: { worktreePath: string }) => {
      await writeFile(path.join(opts.worktreePath, '.env'), 'SECRET=1\n');
      return {
        exitCode: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        rawLog: '',
      };
    });
    const runner = new Runner({ claudeRunner });
    const result = await runner.execute(task(), { sourceRepoDir: sourceRepo });
    expect(result.status).toBe('aborted_forbidden_path');
    expect(result.errorMessage).toMatch(/\.env/);
  });

  it('secret leak（AWS key in diff）→ aborted_secret_leak', async () => {
    const claudeRunner = vi.fn().mockImplementation(async (opts: { worktreePath: string }) => {
      await writeFile(
        path.join(opts.worktreePath, 'hello.txt'),
        'hi\n// const k = "AKIAIOSFODNN7EXAMPLE";\n',
      );
      return {
        exitCode: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        rawLog: '',
      };
    });
    const runner = new Runner({ claudeRunner });
    const result = await runner.execute(task(), { sourceRepoDir: sourceRepo });
    expect(result.status).toBe('aborted_secret_leak');
    expect(result.errorMessage).toMatch(/secret-like|aws_access_key/);
  });

  it('hardened defaults：写 .ssh/config 被默认 forbidden 拒绝（即使 task 没显式列）', async () => {
    const claudeRunner = vi.fn().mockImplementation(async (opts: { worktreePath: string }) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(opts.worktreePath, '.ssh'), { recursive: true });
      await writeFile(path.join(opts.worktreePath, '.ssh', 'config'), 'Host *\n');
      return {
        exitCode: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        rawLog: '',
      };
    });
    const runner = new Runner({ claudeRunner });
    // task 的 forbidden_paths 是空列表，但 DEFAULT_FORBIDDEN_PATHS 应该兜底
    const taskNoForbidden = task({ safety: { max_diff_lines: 50, forbidden_paths: [] } });
    const result = await runner.execute(taskNoForbidden, { sourceRepoDir: sourceRepo });
    expect(result.status).toBe('aborted_forbidden_path');
    expect(result.errorMessage).toMatch(/\.ssh/);
  });

  it('verify 失败时 status=verify_failed', async () => {
    const claudeRunner = vi.fn().mockImplementation(async (opts: { worktreePath: string }) => {
      // claude 故意没创建 hello.txt，verify 会失败
      await writeFile(path.join(opts.worktreePath, 'other.txt'), 'nope\n');
      return {
        exitCode: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        rawLog: '',
      };
    });
    const runner = new Runner({ claudeRunner });
    const result = await runner.execute(task(), { sourceRepoDir: sourceRepo });
    expect(result.status).toBe('verify_failed');
  });

  it('claude exit !=0 时 status=error', async () => {
    const claudeRunner = vi.fn().mockResolvedValue({
      exitCode: 1,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCostUsd: 0.001,
      rawLog: 'boom',
    });
    const runner = new Runner({ claudeRunner });
    const result = await runner.execute(task(), { sourceRepoDir: sourceRepo });
    expect(result.status).toBe('error');
    expect(result.errorMessage).toMatch(/exited with code 1/);
  });

  it('confidence=auto_merge 成功后自动合入源仓库，worktree 被清理', async () => {
    const claudeRunner = vi.fn().mockImplementation(async (opts: { worktreePath: string }) => {
      await writeFile(path.join(opts.worktreePath, 'hello.txt'), 'hi\n');
      return {
        exitCode: 0,
        totalInputTokens: 50,
        totalOutputTokens: 20,
        totalCostUsd: 0.01,
        rawLog: '',
      };
    });
    const runner = new Runner({ claudeRunner });
    const result = await runner.execute(task({ confidence: 'auto_merge' }), {
      sourceRepoDir: sourceRepo,
    });
    expect(result.status).toBe('success');
    expect(result.confidence).toBe('auto_merge');

    // worktree 已被清理
    const { stat } = await import('node:fs/promises');
    await expect(stat(result.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });

    // source repo 合并历史里出现 auto-merge
    const { stdout } = await execa('git', ['log', '--oneline', '-5'], { cwd: sourceRepo });
    expect(stdout).toMatch(/idleloop auto-merge:/);
  });

  it('createWorktree 失败时 status=error，错误消息明确', async () => {
    const nonRepo = await mkdtemp(path.join(tmpdir(), 'idleloop-nonrepo-'));
    try {
      const runner = new Runner({
        claudeRunner: vi.fn(),
      });
      const result = await runner.execute(task(), { sourceRepoDir: nonRepo });
      expect(result.status).toBe('error');
      expect(result.errorMessage).toBeTruthy();
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });
});
