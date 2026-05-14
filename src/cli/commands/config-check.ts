import { readFile } from 'node:fs/promises';
import { styleText } from 'node:util';
import { parse as parseYaml } from 'yaml';
import {
  ConfigError,
  ConfigNotFoundError,
  ConfigSchema,
  loadConfig,
  type Config,
} from '../../storage/config.js';
import { expandHome, paths } from '../../storage/paths.js';

export interface ConfigCheckResult {
  ok: boolean;
  configPath: string;
  config?: Config;
  /** 校验失败时给出每个 issue 的 path / message / 行号（如能推断） */
  issues?: Array<{ path: string; message: string; line?: number }>;
}

export interface ConfigCheckDeps {
  print?: (s: string) => void;
  /** 测试注入：替换 config 文件路径 */
  configPath?: string;
}

/**
 * `idleloop config check` — 单独跑 zod 校验。
 *
 * 比 doctor 快（不走网络、不跑 claude --version、不 stat 一堆目录），
 * 编辑 config.yml 后回头确认语法用。
 *
 * 失败时尽量给出 YAML 里的行号，让用户能直接跳过去改。
 */
export async function runConfigCheck(deps: ConfigCheckDeps = {}): Promise<ConfigCheckResult> {
  const print = deps.print ?? ((s: string) => console.log(s));
  const configPath = deps.configPath ?? paths.configFile();

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      print(styleText('red', `✗ config not found at ${configPath}`));
      print(styleText('dim', '  Run `idleloop init` to create one.'));
      return { ok: false, configPath };
    }
    print(styleText('red', `✗ cannot read ${configPath}: ${e.message}`));
    return { ok: false, configPath };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    print(styleText('red', `✗ invalid YAML in ${configPath}`));
    print(styleText('dim', `  ${(err as Error).message}`));
    return { ok: false, configPath };
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    print(styleText('red', `✗ schema validation failed in ${configPath}`));
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      const line = guessYamlLineForPath(raw, issue.path);
      const linePart = line != null ? ` (line ~${line})` : '';
      const msg = `${path}: ${issue.message}${linePart}`;
      print(`  · ${msg}`);
      return line != null
        ? { path, message: issue.message, line }
        : { path, message: issue.message };
    });
    print('');
    print(styleText('dim', 'For a fresh template, run: `idleloop init --force` (will overwrite!)'));
    return { ok: false, configPath, issues };
  }

  // 成功：把关键字段摘出来，让用户对照"我以为我配了 X，结果生效的是 Y"。
  const cfg = result.data;
  // 也用 loadConfig 走一次正式路径，保证不漏掉编程式默认值的副作用（理论上等价，但贵不到哪里去）。
  try {
    await loadConfig(configPath);
  } catch (err) {
    if (!(err instanceof ConfigError || err instanceof ConfigNotFoundError)) throw err;
  }

  print(styleText('green', `✓ ${configPath} is valid`));
  print('');
  print(styleText('bold', 'Effective settings:'));
  printSummary(cfg, print);

  return { ok: true, configPath, config: cfg };
}

function printSummary(cfg: Config, print: (s: string) => void): void {
  print(
    `  watcher.poll_interval_minutes: ${cfg.watcher.poll_interval_minutes}min` +
      (cfg.watcher.fallback_to_cli ? '  (cli fallback ON)' : '  (cli fallback OFF)'),
  );
  if (cfg.trigger.quiet_hours) {
    const qh = cfg.trigger.quiet_hours;
    print(
      `  trigger.quiet_hours: ${String(qh.start).padStart(2, '0')}:00 → ${String(qh.end).padStart(2, '0')}:00 (local)`,
    );
  } else {
    print('  trigger.quiet_hours: (disabled — daemon may fire 24/7)');
  }
  print(`  trigger.user_activity_guard_minutes: ${cfg.trigger.user_activity_guard_minutes}min`);
  if (cfg.trigger.system_idle?.enabled) {
    print(
      styleText(
        'green',
        `  trigger.system_idle: ON (bypass after ${cfg.trigger.system_idle.min_minutes}min afk)`,
      ),
    );
  } else {
    print(styleText('dim', '  trigger.system_idle: off'));
  }
  print(`  trigger.policies: ${cfg.trigger.policies.length} rule(s)`);
  for (const p of cfg.trigger.policies) {
    print(
      styleText(
        'dim',
        `    · ${p.window}: when <${p.hours_before_reset}h to reset & ≥${p.min_remaining_pct}% remaining`,
      ),
    );
  }
  print(
    `  runner: budget cap $${cfg.runner.max_shift_usd}/shift · default $${cfg.runner.default_max_budget_usd}/task · timeout ${cfg.runner.per_task_timeout_minutes}min`,
  );
  print(
    `  runner.require_declared_project_dir: ${cfg.runner.require_declared_project_dir ? 'yes (strict)' : styleText('yellow', 'no (loose — any path allowed)')}`,
  );
  if (cfg.projects.length === 0) {
    print(
      styleText('yellow', '  projects: [] (no auto-discovery; only `idleloop add` tasks will run)'),
    );
  } else {
    print(`  projects: ${cfg.projects.length} configured`);
    for (const p of cfg.projects) {
      const stratNames = p.strategies.map((s) => s.name).join(',') || '(no strategies)';
      print(
        styleText(
          'dim',
          `    · ${p.id} @ ${expandHome(p.dir)}  weight=${p.weight}  strategies=[${stratNames}]`,
        ),
      );
    }
  }
}

/**
 * 给定 zod issue 的字段路径，尝试在 YAML 文本里粗略找它的行号。
 *
 * 不做语法解析（避免依赖额外库）：按层级 indent 匹配 `${key}:`，深度优先靠 indent。
 * 找不到返回 null，UX 没行号也无所谓。
 */
function guessYamlLineForPath(yaml: string, segs: PropertyKey[]): number | null {
  if (segs.length === 0) return null;
  const lines = yaml.split('\n');
  let cursor = 0;
  let lastIndent = -1;
  for (const seg of segs) {
    if (typeof seg !== 'string') return null; // 数组下标的行号比较脆，跳过
    const re = new RegExp(`^(\\s*)${escapeRegex(seg)}\\s*:`);
    let found = -1;
    for (let i = cursor; i < lines.length; i++) {
      const m = re.exec(lines[i]!);
      if (m && m[1]!.length > lastIndent) {
        found = i;
        lastIndent = m[1]!.length;
        break;
      }
    }
    if (found < 0) return null;
    cursor = found + 1;
  }
  return cursor; // 1-based: 最后一个 segment 的下一行起始为 cursor
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
