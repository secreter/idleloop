import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runVerify } from '../../src/runner/verify.js';

describe('runVerify', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'idleloop-verify-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('成功命令：exitCode=0, pass=true', async () => {
    const r = await runVerify({ command: 'true', worktreePath: dir });
    expect(r.pass).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('失败命令：pass=false', async () => {
    const r = await runVerify({ command: 'false', worktreePath: dir });
    expect(r.pass).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it('捕获 stdout + stderr', async () => {
    const r = await runVerify({
      command: 'echo hi-stdout; echo hi-stderr 1>&2',
      worktreePath: dir,
    });
    expect(r.pass).toBe(true);
    expect(r.output).toContain('hi-stdout');
    expect(r.output).toContain('hi-stderr');
  });

  it('shell 操作符：command1 || command2', async () => {
    const r = await runVerify({ command: 'false || true', worktreePath: dir });
    expect(r.pass).toBe(true);
  });

  it('cwd 是 worktreePath', async () => {
    await writeFile(path.join(dir, 'marker.txt'), 'here');
    const r = await runVerify({ command: 'ls marker.txt', worktreePath: dir });
    expect(r.pass).toBe(true);
    expect(r.output).toContain('marker.txt');
  });

  it('超时：timedOut=true 且 pass=false', async () => {
    const r = await runVerify({
      command: 'sleep 5',
      worktreePath: dir,
      timeoutMs: 100,
    });
    expect(r.pass).toBe(false);
    expect(r.timedOut).toBe(true);
  }, 10_000);
});
