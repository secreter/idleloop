import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { styleText } from 'node:util';
import { execa } from 'execa';
import { loadConfig, ConfigNotFoundError } from '../../storage/config.js';
import { expandHome, paths } from '../../storage/paths.js';
import { loadToken } from '../../watcher/token-source.js';
import { fetchProfile, TokenInvalidError } from '../../watcher/oauth-client.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RunDoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
}

/**
 * `idleloop doctor` —— 检查环境完整性，离 3 点跑任务能不能跑通。
 *
 * 检查项（每条独立、相互不依赖）：
 *   1. config.yml 存在且可解析
 *   2. ~/idleloop 与 ~/.idleloop 关键子目录都存在
 *   3. ~/.claude/.credentials.json 可读（或 IDLELOOP_CLAUDE_TOKEN 设了）
 *   4. OAuth /profile 端点能通（验证 token 有效）
 *   5. claude CLI 在 PATH 上
 *   6. 每个 projects[].dir 存在 + 是 git 仓库 + HEAD 可解析
 *   7. worktree base 可写
 *
 * 所有检查都跑完，失败的红色显示但不中止后续。
 */
export async function runDoctor(
  deps: { print?: (s: string) => void; skipNetwork?: boolean } = {},
): Promise<RunDoctorResult> {
  const print = deps.print ?? ((s: string) => console.log(s));
  const checks: DoctorCheck[] = [];

  // 1. config
  let cfg: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    cfg = await loadConfig();
    checks.push({ name: 'config.yml', ok: true, detail: paths.configFile() });
  } catch (err) {
    const msg =
      err instanceof ConfigNotFoundError
        ? `not found; run \`idleloop init\``
        : (err as Error).message;
    checks.push({ name: 'config.yml', ok: false, detail: msg });
  }

  // 2. 关键目录
  const dirs = [
    paths.userDataRoot(),
    paths.queueDir(),
    paths.stateRoot(),
    paths.worktreesDir(),
    paths.logsDir(),
  ];
  for (const d of dirs) {
    try {
      await stat(d);
      checks.push({ name: `dir ${shortenHome(d)}`, ok: true, detail: 'exists' });
    } catch {
      checks.push({ name: `dir ${shortenHome(d)}`, ok: false, detail: 'missing (idleloop init)' });
    }
  }

  // 3 + 4. token + profile
  let token: Awaited<ReturnType<typeof loadToken>> | null = null;
  try {
    token = await loadToken();
    checks.push({
      name: 'OAuth token',
      ok: true,
      detail: `source=${token.source}, expires ${token.expiresAt.toISOString()}`,
    });
  } catch (err) {
    checks.push({ name: 'OAuth token', ok: false, detail: (err as Error).message });
  }
  if (token && !deps.skipNetwork) {
    try {
      const p = await fetchProfile(token.accessToken);
      const who = p.account.email ?? p.account.display_name ?? p.account.uuid;
      checks.push({ name: 'OAuth /profile', ok: true, detail: `authenticated as ${who}` });
    } catch (err) {
      const detail =
        err instanceof TokenInvalidError
          ? 'HTTP 401 — token expired or revoked'
          : (err as Error).message;
      checks.push({ name: 'OAuth /profile', ok: false, detail });
    }
  }

  // 5. claude CLI
  const cliPath = cfg?.runner.claude_cli_path ?? 'claude';
  try {
    const { stdout } = await execa(cliPath, ['--version'], { timeout: 5_000 });
    checks.push({
      name: `claude CLI (${cliPath})`,
      ok: true,
      detail: stdout.trim().split('\n')[0] ?? '',
    });
  } catch (err) {
    const e = err as Error & { code?: string };
    checks.push({
      name: `claude CLI (${cliPath})`,
      ok: false,
      detail:
        e.code === 'ENOENT'
          ? `not found on PATH; install or set runner.claude_cli_path`
          : e.message,
    });
  }

  // 6. projects
  if (cfg && cfg.projects.length > 0) {
    for (const p of cfg.projects) {
      const dir = expandHome(p.dir);
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) {
          checks.push({
            name: `project ${p.id}`,
            ok: false,
            detail: `${p.dir} is not a directory`,
          });
          continue;
        }
        const gitDir = path.join(dir, '.git');
        try {
          await stat(gitDir);
        } catch {
          checks.push({
            name: `project ${p.id}`,
            ok: false,
            detail: `${p.dir} is not a git repo (no .git/)`,
          });
          continue;
        }
        checks.push({ name: `project ${p.id}`, ok: true, detail: dir });
      } catch {
        checks.push({ name: `project ${p.id}`, ok: false, detail: `${p.dir} not found` });
      }
    }
  } else if (cfg) {
    checks.push({
      name: 'projects',
      ok: true,
      detail: 'none configured (only manual queue tasks will run)',
    });
  }

  // 7. worktree base writable
  if (cfg) {
    const wtBase = expandHome(cfg.runner.worktree_base);
    try {
      await access(wtBase, constants.W_OK);
      checks.push({ name: 'worktree base', ok: true, detail: wtBase });
    } catch {
      checks.push({ name: 'worktree base', ok: false, detail: `${wtBase} not writable` });
    }
  }

  for (const c of checks) {
    const mark = c.ok ? styleText('green', '✓') : styleText('red', '✗');
    print(`${mark} ${c.name.padEnd(28)} ${styleText('dim', c.detail)}`);
  }
  const ok = checks.every((c) => c.ok);
  print('');
  print(
    ok
      ? styleText('green', 'All checks passed. Ready to run.')
      : styleText(
          'yellow',
          `${checks.filter((c) => !c.ok).length} check(s) failed. Fix above and re-run \`idleloop doctor\`.`,
        ),
  );
  return { checks, ok };
}

function shortenHome(p: string): string {
  const home = process.env['HOME'];
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
