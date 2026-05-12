import { readFile, writeFile } from 'node:fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { ensureDir, paths } from './paths.js';
import path from 'node:path';

/**
 * config.yml schema —— 对齐 docs/TECH_DESIGN.md §6.2，字段 snake_case。
 */

const TriggerPolicySchema = z.object({
  window: z.enum(['five_hour', 'seven_day']),
  hours_before_reset: z.number().nonnegative(),
  min_remaining_pct: z.number().min(0).max(100),
});

const QuietHoursSchema = z.object({
  start: z.number().int().min(0).max(23),
  end: z.number().int().min(0).max(23),
});

const ProjectStrategySchema = z.object({
  name: z.string(),
  config: z.record(z.unknown()).optional(),
  confidence: z.enum(['auto_merge', 'review_queue', 'draft_only']).default('review_queue'),
});

const ProjectSafetySchema = z.object({
  max_diff_lines: z.number().int().positive().default(800),
  forbidden_paths: z.array(z.string()).default(['.env', 'secrets/']),
});

const ProjectSchema = z.object({
  id: z.string().min(1),
  dir: z.string().min(1),
  weight: z.number().nonnegative().default(1),
  strategies: z.array(ProjectStrategySchema).default([]),
  safety: ProjectSafetySchema.default({
    max_diff_lines: 800,
    forbidden_paths: ['.env', 'secrets/'],
  }),
});

const WatcherSchema = z
  .object({
    poll_interval_minutes: z.number().int().positive().default(15),
    fallback_to_cli: z.boolean().default(true),
  })
  .default({
    poll_interval_minutes: 15,
    fallback_to_cli: true,
  });

const TriggerSchema = z
  .object({
    policies: z.array(TriggerPolicySchema).default([
      { window: 'five_hour', hours_before_reset: 1, min_remaining_pct: 30 },
      { window: 'seven_day', hours_before_reset: 12, min_remaining_pct: 40 },
    ]),
    quiet_hours: QuietHoursSchema.nullable().default({ start: 8, end: 22 }),
    user_activity_guard_minutes: z.number().int().nonnegative().default(30),
  })
  .default({
    policies: [
      { window: 'five_hour', hours_before_reset: 1, min_remaining_pct: 30 },
      { window: 'seven_day', hours_before_reset: 12, min_remaining_pct: 40 },
    ],
    quiet_hours: { start: 8, end: 22 },
    user_activity_guard_minutes: 30,
  });

const RunnerSchema = z
  .object({
    max_concurrent_tasks: z.number().int().positive().default(1),
    default_verify_command: z.string().default('npm test || tsc --noEmit'),
    worktree_base: z.string().default('~/.idleloop/worktrees'),
    claude_cli_path: z.string().default('claude'),
    default_max_budget_usd: z.number().positive().default(1.0),
    per_task_timeout_minutes: z.number().int().positive().default(45),
  })
  .default({
    max_concurrent_tasks: 1,
    default_verify_command: 'npm test || tsc --noEmit',
    worktree_base: '~/.idleloop/worktrees',
    claude_cli_path: 'claude',
    default_max_budget_usd: 1.0,
    per_task_timeout_minutes: 45,
  });

const LoggingSchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    file: z.string().default('~/.idleloop/logs/daemon.log'),
  })
  .default({
    level: 'info',
    file: '~/.idleloop/logs/daemon.log',
  });

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  watcher: WatcherSchema,
  trigger: TriggerSchema,
  runner: RunnerSchema,
  projects: z.array(ProjectSchema).default([]),
  logging: LoggingSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
export type TriggerPolicyConfig = z.infer<typeof TriggerPolicySchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;

const DEFAULT_CONFIG_YAML = `# idleloop config
# 文档：见 docs/PRD.md 和 docs/TECH_DESIGN.md
version: 1

watcher:
  poll_interval_minutes: 15      # 守护进程拉余量的间隔
  fallback_to_cli: true          # OAuth 端点失败时是否解析 claude CLI 输出兜底

trigger:
  # 满足任一 policy 即触发
  policies:
    - window: five_hour
      hours_before_reset: 1      # 距 reset 不到 1 小时
      min_remaining_pct: 30      # 还剩 >= 30% 余量

    - window: seven_day
      hours_before_reset: 12
      min_remaining_pct: 40

  # 这段时间内绝不触发（防止误打扰白天工作）
  quiet_hours:
    start: 8   # 8:00
    end: 22    # 22:00

  # 最近 N 分钟内有 Claude Code 活动则跳过本次触发
  user_activity_guard_minutes: 30

runner:
  max_concurrent_tasks: 1
  default_verify_command: "npm test || tsc --noEmit"
  worktree_base: "~/.idleloop/worktrees"
  claude_cli_path: "claude"
  default_max_budget_usd: 1.0       # 单任务硬性美元上限
  per_task_timeout_minutes: 45

# 项目列表：T3 嗅探策略会扫描这些目录
projects: []
# 示例：
# projects:
#   - id: llm-infra-book
#     dir: ~/workspace/llm-infra-book
#     weight: 3
#     strategies:
#       - name: book-expand
#         config:
#           source_glob: "chapters/*/README.md"
#           marker: "<!-- TODO: expand -->"
#         confidence: review_queue
#     safety:
#       max_diff_lines: 800
#       forbidden_paths: [".env", "secrets/"]

logging:
  level: info
  file: "~/.idleloop/logs/daemon.log"
`;

export class ConfigError extends Error {
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ConfigError';
    this.cause = cause;
  }
}

export class ConfigNotFoundError extends ConfigError {
  constructor(filePath: string) {
    super(`config not found at ${filePath}; run 'idleloop init' first`);
    this.name = 'ConfigNotFoundError';
  }
}

/**
 * 读 config.yml，校验并返回类型安全的 Config。
 *
 * @param filePath 默认 paths.configFile()，测试可注入
 * @throws ConfigNotFoundError 文件不存在
 * @throws ConfigError 解析或校验失败（带 cause）
 */
export async function loadConfig(filePath: string = paths.configFile()): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigNotFoundError(filePath);
    }
    throw new ConfigError(`failed to read ${filePath}`, err);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`invalid YAML in ${filePath}`, err);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `invalid config in ${filePath}: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      result.error,
    );
  }
  return result.data;
}

/**
 * 把传入对象当作 user config 校验（不读文件），用于测试和编程式构造。
 */
export function parseConfig(obj: unknown): Config {
  const result = ConfigSchema.safeParse(obj);
  if (!result.success) {
    throw new ConfigError(
      `invalid config: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      result.error,
    );
  }
  return result.data;
}

/**
 * 把 Config 转回 YAML 字符串。用户编辑过的注释会丢失，因此不会被 init 之外的命令调用。
 */
export function configToYaml(cfg: Config): string {
  return stringifyYaml(cfg);
}

/**
 * 写入默认 config.yml。已存在则按 overwrite flag 决定。
 * 返回写入路径。
 */
export async function writeDefaultConfig(
  opts: {
    filePath?: string;
    overwrite?: boolean;
  } = {},
): Promise<{ path: string; created: boolean }> {
  const filePath = opts.filePath ?? paths.configFile();
  const overwrite = opts.overwrite ?? false;

  await ensureDir(path.dirname(filePath));

  try {
    await readFile(filePath, 'utf-8');
    if (!overwrite) {
      return { path: filePath, created: false };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  await writeFile(filePath, DEFAULT_CONFIG_YAML, { mode: 0o600 });
  return { path: filePath, created: true };
}

/**
 * 默认配置对象（不读文件，纯内存）。用于测试或 missing-config 兜底。
 */
export function defaultConfig(): Config {
  return parseConfig({});
}

export { DEFAULT_CONFIG_YAML };
