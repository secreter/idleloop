import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, paths } from '../../storage/paths.js';
import { writeDefaultConfig } from '../../storage/config.js';
import { fetchProfile, TokenInvalidError } from '../../watcher/oauth-client.js';
import { loadToken, TokenSourceError } from '../../watcher/token-source.js';
import { EXAMPLE_TASK_MD } from './task-template.js';

export interface InitOptions {
  force?: boolean;
  skipVerify?: boolean;
}

export interface InitResult {
  configCreated: boolean;
  configPath: string;
  directoriesCreated: string[];
  authenticatedAs?: string;
  warnings: string[];
  exampleTaskPath?: string;
  exampleTaskCreated?: boolean;
}

/**
 * `idleloop init` 实现：
 *   1. 建好 ~/idleloop/ 和 ~/.idleloop/ 下所有必要目录
 *   2. 如果 config.yml 不存在则写一份带注释的默认配置
 *   3. 读 OAuth token 并调 /api/oauth/profile 验证身份（除非 --skip-verify）
 *
 * 任一步失败都不会回滚已建的目录，但会把警告聚合到 warnings 数组让上层报告。
 */
export async function runInit(opts: InitOptions = {}): Promise<InitResult> {
  const warnings: string[] = [];

  const dirs = [
    paths.userDataRoot(),
    paths.queueDir(),
    paths.proposalsDir(),
    paths.stateRoot(),
    paths.stateDir(),
    paths.worktreesDir(),
    paths.logsDir(),
  ];
  const created: string[] = [];
  for (const d of dirs) {
    await ensureDir(d);
    created.push(d);
  }

  const cfg = await writeDefaultConfig({ overwrite: opts.force ?? false });

  // 写一份 example task md，让用户第一眼有可改的模板
  const examplePath = path.join(paths.queueDir(), 'example.md.template');
  let exampleCreated = false;
  try {
    const { readFile } = await import('node:fs/promises');
    await readFile(examplePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await writeFile(examplePath, EXAMPLE_TASK_MD, { mode: 0o600 });
      exampleCreated = true;
    }
  }

  let authenticatedAs: string | undefined;
  if (!opts.skipVerify) {
    try {
      const token = await loadToken();
      const profile = await fetchProfile(token.accessToken);
      authenticatedAs =
        profile.account.email ??
        profile.account.display_name ??
        profile.account.full_name ??
        profile.account.uuid;
    } catch (err) {
      if (err instanceof TokenSourceError) {
        warnings.push(
          `OAuth token unavailable: ${err.message}. ` +
            `Run \`claude auth login\` or set IDLELOOP_CLAUDE_TOKEN, then re-run init.`,
        );
      } else if (err instanceof TokenInvalidError) {
        warnings.push(
          `OAuth token rejected (HTTP 401). The token in ~/.claude/.credentials.json may be expired; ` +
            `run \`claude auth login\` to refresh.`,
        );
      } else {
        warnings.push(
          `Could not verify token via /api/oauth/profile: ${(err as Error).message}. ` +
            `init will continue anyway; \`idleloop status\` will retry.`,
        );
      }
    }
  }

  return {
    configCreated: cfg.created,
    configPath: cfg.path,
    directoriesCreated: created,
    ...(authenticatedAs !== undefined ? { authenticatedAs } : {}),
    warnings,
    exampleTaskPath: examplePath,
    exampleTaskCreated: exampleCreated,
  };
}
