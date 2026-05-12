# idleloop 技术框架文档

## 1. 技术选型

| 维度 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript（严格模式） | 作者主技术栈；类型安全对长生命周期守护进程关键 |
| 运行时 | Node.js（>=20 LTS） | 内置 `fetch` / `worker_threads`，无需额外依赖 |
| 包管理 | npm | 与 workspace 全局约定一致 |
| CLI 框架 | `commander` | 成熟稳定，体积小 |
| 配置格式 | YAML（`yaml` 包） | 用户编辑友好，支持注释 |
| 任务定义 | Markdown + frontmatter（`gray-matter`） | 任务即文档，可直接被 Claude Code 读取 |
| 进程编排 | `execa` + `node:child_process` | 启动 `claude` CLI 子进程并捕获输出 |
| 守护进程 | systemd（Linux）/ launchd（macOS） | 复用系统级守护，不自己造 |
| 日志 | `pino`（结构化日志） | 性能好，便于后期接 OpenTelemetry |
| Git 操作 | `simple-git` | TS 友好的 Git wrapper |
| HTTP 请求 | 原生 `fetch` | Node 20+ 已内置 |
| 测试 | `vitest` | 快、TS 原生支持 |

不引入：

- 不用 Electron / Tauri（命令行工具不需要 GUI）
- 不用数据库（本地 JSON / JSONL 足够，避免依赖）
- 不用 React / 任何前端框架
- 不用 LangChain / 任何 agent 编排库（直接调 `claude` CLI 更简单可控）

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                       CLI Layer                              │
│   commander 入口  │  init / status / add / list / run /      │
│                   │  daemon / review / logs                  │
└──────────┬──────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────┐
│                      Daemon / Service                        │
│   主循环 + 调度器 + 信号处理（SIGTERM 优雅退出）              │
└──────────┬──────────────────────────────────────────────────┘
           │
   ┌───────┼───────────────────────────────┐
   │       │                               │
┌──▼───┐ ┌─▼─────────┐               ┌─────▼──────┐
│Watch │ │ Curator   │               │  Runner    │
│      │ │  T1 书架   │               │            │
│OAuth │ │  T2 目标   │  →  Task Q  → │  worktree  │
│usage │ │  T3 嗅探   │               │  + claude  │
│poll  │ │  T4 提案   │               │  + verify  │
└──┬───┘ └────┬──────┘               └─────┬──────┘
   │          │                            │
   └──────────┴────────────────────────────┘
                       │
                       ▼
            ┌──────────────────────┐
            │     Storage          │
            │  ~/.idleloop/       │
            │   config.yml         │
            │   queue/*.md         │
            │   state.json         │
            │   logs/{date}/       │
            │   worktrees/{id}/    │
            └──────────────────────┘
```

三层职责：

- **Watcher**：单一职责，定期拉 OAuth usage 端点，写入余量状态
- **Curator**：从配置和扫描中产出候选任务列表，写入任务队列
- **Runner**：消费任务队列，在 worktree 中跑 Claude Code，执行 verify

## 3. 数据源：余量读取

### 3.1 主数据源：Claude Code OAuth usage 端点

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <oauth_access_token>
```

返回（实际结构需在实现时探测，以下为根据社区报告的预期）：

```json
{
  "five_hour": {
    "utilization": 0.42,
    "resets_at": "2026-05-13T03:00:00Z"
  },
  "seven_day": {
    "utilization": 0.31,
    "resets_at": "2026-05-19T08:00:00Z"
  }
}
```

### 3.2 OAuth token 来源

参考 CodexBar 的「复用已有 session」做法。Claude Code 把 OAuth credentials 存在本地：

- macOS：`~/Library/Application Support/Claude/` 或 Keychain
- Linux：`~/.config/claude/` 或 `~/.claude/`
- 具体路径与字段名需在实现时探测当前 Claude Code 版本的行为

读取顺序：

1. 优先：`~/.claude/` 下的 credentials 文件
2. 次选：环境变量 `CLAUDE_CODE_OAUTH_TOKEN`（用户可手动配置）
3. 兜底：CLI 提示用户手动粘贴 token

### 3.3 Fallback：CLI PTY 解析

如果 OAuth 端点失败，降级为：

- 启动一个最小 `claude --print "hi"` 调用
- 解析其错误输出或元数据中的 `usage_limit_reset` 信息（如有）
- 解析失败则假定"未知余量"，跳过本次触发（safe default）

### 3.4 防御性处理

- HTTP 401：清空缓存 token，提示用户重新登录
- HTTP 5xx：指数退避重试，最多 3 次
- 端点字段变化：用 `zod` 解析，校验失败时记录原始响应并降级

## 4. 模块设计

### 4.1 `watcher` 模块

```typescript
// src/watcher/index.ts
export interface QuotaSnapshot {
  fiveHour: { remaining: number; resetsAt: Date };
  sevenDay: { remaining: number; resetsAt: Date };
  fetchedAt: Date;
  source: 'oauth' | 'cli_fallback' | 'cached';
}

export class Watcher {
  constructor(private config: WatcherConfig);
  async snapshot(): Promise<QuotaSnapshot>;
  async startPolling(intervalMs: number, onUpdate: (s: QuotaSnapshot) => void): Promise<void>;
  stopPolling(): void;
}
```

职责：

- 单一接口暴露余量数据
- 缓存最近 N 次读数到 `~/.idleloop/state/quota.jsonl`
- 暴露 EventEmitter 让 Daemon 订阅余量变化

### 4.2 `trigger` 模块

```typescript
// src/trigger/index.ts
export interface TriggerPolicy {
  hoursBeforeReset: number;
  minRemainingPct: number;
  windowType: 'five_hour' | 'seven_day';
  quietHours?: { start: number; end: number };
  userActivityGuardMinutes: number;
}

export class TriggerEngine {
  constructor(private policies: TriggerPolicy[], private watcher: Watcher);
  async shouldTrigger(): Promise<TriggerDecision>;
}

export interface TriggerDecision {
  triggered: boolean;
  reason: string;
  budgetTokens: number;
  windowType: 'five_hour' | 'seven_day';
}
```

判定逻辑（伪代码）：

```
for policy in policies:
  if 当前时间在 quietHours: continue
  if 用户最近 N 分钟有活动: continue
  snapshot = await watcher.snapshot()
  window = snapshot[policy.windowType]
  if (window.resetsAt - now) > policy.hoursBeforeReset: continue
  if window.remaining < policy.minRemainingPct: continue
  return { triggered: true, budgetTokens: window.remaining * 0.8, ... }
return { triggered: false }
```

「用户最近活动」检测：扫 `~/.claude/projects/` 下文件的 mtime，取最近一次。

### 4.3 `curator` 模块

```typescript
// src/curator/index.ts
export interface Task {
  id: string;                // ulid
  source: 'T1' | 'T2' | 'T3' | 'T4';
  project: string;
  title: string;
  prompt: string;             // 给 Claude Code 的 prompt
  workingDir: string;
  costEstimateTokens: number;
  acceptance: string;         // 验收标准（自然语言）
  verifyCommand: string;
  confidence: 'auto_merge' | 'review_queue' | 'draft_only';
  safety: {
    maxDiffLines: number;
    forbiddenPaths: string[];  // ['.env', 'secrets/', ...]
  };
}

export interface CuratorStrategy {
  name: string;
  source: Task['source'];
  discover(ctx: ProjectContext): Promise<Task[]>;
}
```

P0 实现的 strategies：

| 名称 | 来源 | 实现 |
|---|---|---|
| `bookshelf` | T1 | 读 `~/idleloop/queue/*.md`，frontmatter 转 Task |
| `audit` | T3 | grep TODO/FIXME/HACK 注释，每条转一个 Task |
| `test` | T3 | 找无对应 `*.test.ts` 的源文件，生成"补测试"任务 |
| `book-expand` | T3 | 读 book 项目的 `chapters/*/README.md`，找"未扩写"标记 |

P1/P2 strategies：`goals`（T2）、`refactor`、`deps`、`proposal`（T4）。

### 4.4 `runner` 模块

```typescript
// src/runner/index.ts
export class Runner {
  async execute(task: Task, budgetTokens: number): Promise<TaskResult>;
}

export interface TaskResult {
  taskId: string;
  status: 'success' | 'verify_failed' | 'aborted_oversized' | 'aborted_budget' | 'error';
  branchName: string;        // idleloop/{date}/{task-id}
  tokensSpent: number;
  durationMs: number;
  diffLinesChanged: number;
  verifyOutput?: string;
  errorMessage?: string;
}
```

执行流程：

```
1. 创建 worktree：
   simple-git.raw(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'])

2. 启动 claude CLI：
   execa('claude', [
     '--print',                      // 非交互模式
     '--max-turns', '20',
     '--working-dir', worktreePath,
     '--allowed-tools', 'Read,Edit,Write,Bash',
   ], { input: task.prompt })

3. 实时监控 stdout：
   - 解析 token 计数（Claude Code 在输出末尾给出 usage 块）
   - 实时累计，超 budgetTokens 时 process.kill('SIGTERM')

4. 检查改动：
   - diff 行数 > task.safety.maxDiffLines → abort
   - 触及 forbiddenPaths → abort
   - 触及 lockfile（package-lock.json / pnpm-lock.yaml）→ abort（参考 Nightshift）

5. 跑 verify：
   - execa.shell(task.verifyCommand, { cwd: worktreePath })
   - 退出码非 0 → verify_failed

6. 写 commit：
   - 失败：simple-git.checkout('.') + worktree remove
   - 成功：simple-git.commit(`idleloop: ${task.title}`)，保留分支

7. 返回 TaskResult
```

### 4.5 `shift-log` 模块

```typescript
// src/shift-log/index.ts
export class ShiftLogger {
  startSession(triggerDecision: TriggerDecision): SessionContext;
  recordTask(session: SessionContext, result: TaskResult): void;
  finalizeSession(session: SessionContext): Promise<{ mdPath: string; jsonPath: string }>;
}
```

产出：

- `~/idleloop/logs/2026-05-13/shift.md`：模板化 markdown
- `~/idleloop/logs/2026-05-13/state.json`：结构化数据

shift.md 模板：

```markdown
# Shift 2026-05-13

## 执行摘要
- 触发原因：5h 窗口剩 42%，距 reset 58 分钟
- 预算：120k tokens
- 完成 4 项 / 失败 1 项 / 中止 0 项
- 推荐合并：2 项

## 任务详情

### ✓ T-01: 扩写 llm-infra-book/ch04 RAG 基础（推荐合并）
- 分支：idleloop/2026-05-13/llm-book-ch04
- 耗时：23 分 / 38k tokens
- 验证：markdown lint 通过
- 产出：chapters/04-rag/README.draft.md（2456 字）
- 摘要：扩写了"为什么需要 RAG"、"基础架构"两节...

### ✗ T-02: 重构 places.ts 拆分（中止）
- 中止原因：改动 187 行，超过 maxDiffLines=150
- 建议：手动接管，先做小范围抽函数
```

### 4.6 `storage` 模块

布局：

```
~/idleloop/
  config.yml                   # 用户配置
  queue/                       # T1 书架（用户手写任务）
    *.md
  goals.yml                    # T2 长期目标
  proposals/                   # T4 提案
    {date}.md
  history.jsonl                # 任务接受/拒绝历史

~/.idleloop/                  # 工具状态（用户一般不动）
  state/
    quota.jsonl                # 余量历史
    daemon.pid
  worktrees/
    {task-id}/                 # git worktree 工作目录
  logs/
    {date}/
      shift.md
      state.json
      claude-output.log        # Claude CLI 原始输出
```

### 4.7 `cli` 模块

```typescript
// src/cli/index.ts
import { Command } from 'commander';

const program = new Command();
program
  .command('init').action(initCommand)
  .command('status').action(statusCommand)
  .command('add <file>').action(addCommand)
  .command('list').action(listCommand)
  .command('run').option('--dry').action(runCommand)
  .command('daemon').addCommand(daemonStart).addCommand(daemonStop)
  .command('review').action(reviewCommand)
  .command('logs [date]').action(logsCommand);
```

`review` 交互模式用 `@inquirer/prompts`，对每个 review_queue 的任务给出 `merge / discard / keep` 三选一。

## 5. 关键流程

### 5.1 守护进程主循环

```
loop:
  await sleep(pollIntervalMs)        # 默认 15 分钟
  snapshot = await watcher.snapshot()
  decision = await trigger.shouldTrigger()
  if not decision.triggered: continue
  
  tasks = await curator.gather(decision.budgetTokens)
  if tasks.length == 0:
    logger.info('triggered but no tasks available')
    continue
  
  session = shiftLog.startSession(decision)
  for task in tasks:
    if remainingBudget < task.costEstimateTokens: break
    result = await runner.execute(task, remainingBudget)
    shiftLog.recordTask(session, result)
    remainingBudget -= result.tokensSpent
  
  await shiftLog.finalizeSession(session)
```

### 5.2 安全闸（每个任务执行前后）

执行前：

- worktree 路径在 `~/.idleloop/worktrees/` 下，不在用户项目目录
- 配置中声明 `forbiddenPaths`，启动 claude 前注入 `--disallowed-paths`（如 Claude Code 支持）或在 prompt 中明确禁止
- 任务的 budget 必须 ≤ 当前 idle session 剩余预算

执行中：

- 实时解析 token 用量，超 budget 立即 SIGTERM
- 监控 git diff，每 30 秒检查一次 maxDiffLines

执行后：

- diff 行数 / 触及文件再次校验
- verify command 必须 exit 0
- 异常情况：保留 worktree 不删除，便于排查

### 5.3 触发抢占保护

```typescript
async function isUserActive(): Promise<boolean> {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const mostRecentMtime = await getMostRecentFileMtime(claudeProjectsDir);
  const elapsedMin = (Date.now() - mostRecentMtime.getTime()) / 60_000;
  return elapsedMin < config.userActivityGuardMinutes;
}
```

如果守护进程触发时检测到 `isUserActive() === true`，立即放弃本次触发，等下个轮询周期。

## 6. 数据模型

### 6.1 `Task` 持久化（markdown frontmatter）

```markdown
---
id: task-01HXYZ123
source: T1
project: llm-infra-book
title: 扩写 ch04 RAG 基础
cost_estimate_tokens: 40000
acceptance: 产出 chapters/04-rag/README.draft.md，>=2000 字，遵循 CLAUDE.md 写作规范
confidence: review_queue
verify_command: pnpm lint:markdown chapters/04-rag/
safety:
  max_diff_lines: 800
  forbidden_paths: ['.env', 'secrets/', 'package-lock.json']
---

## Prompt

阅读 chapters/04-rag/README.md 中的大纲，扩写第 2、3 节为完整正文。
参考 chapters/01-llm-basics/README.md 的写作风格。
产出到 chapters/04-rag/README.draft.md，不修改原文件。

遵守的写作规范：
- 见 ~/workspace/CLAUDE.md 「书籍写作规范」章节
- 禁止 AI 套话清单
- 中文注释、英文标识符
```

### 6.2 `config.yml` 完整 schema

```yaml
# ~/idleloop/config.yml
version: 1

watcher:
  poll_interval_minutes: 15
  fallback_to_cli: true

trigger:
  policies:
    - window: five_hour
      hours_before_reset: 1
      min_remaining_pct: 30
    - window: seven_day
      hours_before_reset: 12
      min_remaining_pct: 40
  quiet_hours: { start: 8, end: 22 }    # 不在工作时间触发
  user_activity_guard_minutes: 30

runner:
  max_concurrent_tasks: 1
  default_verify_command: "pnpm build || npm test || tsc --noEmit"
  worktree_base: ~/.idleloop/worktrees
  claude_cli_path: claude               # 假设 PATH 中有

projects:
  - id: llm-infra-book
    dir: ~/workspace/llm-infra-book
    weight: 3                            # 多项目并行时的预算权重
    strategies:
      - name: book-expand
        config:
          source_glob: "chapters/*/README.md"
          marker: "<!-- TODO: expand -->"
          confidence: review_queue
    safety:
      max_diff_lines: 800
      forbidden_paths: ['.env', 'secrets/']

  - id: coffeesmap
    dir: ~/workspace/coffeesmap
    weight: 1
    strategies:
      - name: audit
        confidence: review_queue
      - name: test
        confidence: review_queue
    safety:
      max_diff_lines: 150

logging:
  level: info
  file: ~/.idleloop/logs/daemon.log
```

## 7. 项目结构

```
idleloop/
  package.json
  tsconfig.json
  .prettierrc
  .eslintrc.cjs
  README.md
  docs/
    PRD.md
    TECH_DESIGN.md
  src/
    cli/
      index.ts              # commander 入口
      commands/
        init.ts
        status.ts
        add.ts
        list.ts
        run.ts
        daemon.ts
        review.ts
        logs.ts
    watcher/
      index.ts
      oauth-client.ts       # /api/oauth/usage 封装
      token-source.ts       # 从本地读 OAuth token
      cli-fallback.ts
    trigger/
      index.ts
      policy.ts
      user-activity.ts
    curator/
      index.ts
      strategies/
        bookshelf.ts        # T1
        goals.ts            # T2（P1）
        audit.ts            # T3
        test-gap.ts         # T3
        book-expand.ts      # T3
        proposal.ts         # T4（P2）
    runner/
      index.ts
      worktree.ts
      claude-process.ts     # 启动并监控 claude CLI
      safety-gate.ts        # diff / forbidden paths 检查
      verify.ts
    shift-log/
      index.ts
      markdown-formatter.ts
    storage/
      index.ts
      paths.ts
      config.ts             # yaml 解析 + zod 校验
    types/
      index.ts              # Task, QuotaSnapshot 等核心类型
    utils/
      logger.ts             # pino wrapper
      ulid.ts
  tests/
    fixtures/
    unit/
    integration/
  scripts/
    build.ts
    install-daemon.ts       # 生成 systemd / launchd plist
```

## 8. 关键依赖

```json
{
  "dependencies": {
    "commander": "^12.0.0",
    "execa": "^9.0.0",
    "simple-git": "^3.25.0",
    "yaml": "^2.5.0",
    "gray-matter": "^4.0.3",
    "zod": "^3.23.0",
    "pino": "^9.5.0",
    "pino-pretty": "^11.2.0",
    "@inquirer/prompts": "^7.0.0",
    "ulid": "^2.3.0",
    "fast-glob": "^3.3.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.0.0",
    "prettier": "^3.3.0",
    "eslint": "^9.0.0"
  }
}
```

不依赖：

- 不依赖 Anthropic SDK（直接 `fetch` 调 OAuth 端点）
- 不依赖任何 agent 编排框架（直接 spawn `claude` CLI）
- 不依赖数据库

## 9. 测试策略

### 9.1 单元测试

- `watcher/oauth-client`：mock fetch，覆盖正常 / 401 / 5xx / 字段缺失
- `trigger/policy`：覆盖各种边界（刚好等于阈值 / quiet hours 边界 / 用户刚活跃过）
- `curator/strategies/*`：每个策略用 fixture 项目测试发现逻辑
- `runner/safety-gate`：mock 改动 / forbidden path 触达

### 9.2 集成测试

- 端到端：用 fixture 项目跑 dry-run 模式（不真实调 claude），验证完整流程
- 真实联调（手动触发）：MVP 阶段在我自己机器上跑 7 个连续夜晚

### 9.3 真实环境监控

- 守护进程日志结构化（pino），可以 `tail -f` 看实时状态
- 关键事件（触发、任务结束、异常）打到 stderr 便于 systemd journal 抓取

## 10. 安全与隐私

### 10.1 数据本地化

- 所有数据存本地（`~/idleloop/` 和 `~/.idleloop/`）
- OAuth token 仅从本地 Claude Code 读取，不上传到任何外部服务
- 任务 prompt 和产出不出本机

### 10.2 文件权限

- `~/.idleloop/state/` 下文件 `chmod 600`（仅 owner 读写）
- OAuth token 缓存（如有）同样 600
- daemon log 文件 600

### 10.3 worktree 隔离

- 所有 worktree 在 `~/.idleloop/worktrees/` 下，永不污染用户工作区
- 失败的 worktree 不自动删除（便于排查），但有清理命令 `idleloop cleanup --before {date}`

## 11. MVP 实施路线

| Phase | 周期 | 目标 | 验收 |
|---|---|---|---|
| 0 | 1 周 | 脚手架 + OAuth 端点 + Watcher 单元 | `idleloop status` 能打印真实余量 |
| 1 | 2 周 | Trigger + T1 书架 + Runner 基础版 | 能用 `idleloop run --dry` 跑完一个手写任务 |
| 2 | 1 周 | Shift log + Daemon + 完整 CLI | systemd 守护 + 连续跑 3 晚 |
| 3 | 2 周 | T3 嗅探（audit/test/book-expand）+ 多项目调度 | 自用 4 周稳定 |
| 4 | 待定 | T2/T4 + 偏好学习 + 周报 | 准备开源 |

## 12. 开源前的准备清单

发布到 GitHub 前需要：

- [ ] 4 周以上自用稳定，零误触发
- [ ] 完整的 README（英文 + 中文）
- [ ] 至少 3 个示例项目配置
- [ ] 单元测试覆盖率 > 70%
- [ ] 一个 demo 视频（30 秒展示从触发到 review 的完整流程）
- [ ] LICENSE（MIT）
- [ ] CHANGELOG

## 13. 未决问题（开发时需要进一步确认）

1. **OAuth 端点的真实 schema**：当前只是社区报告的字段，实现时第一步是 dump 真实响应
2. **Claude Code CLI 的 `--allowed-tools` 是否支持精确控制**：需要验证当前版本能力
3. **Claude Code CLI 输出中 token 统计的具体格式**：决定 token 实时监控的解析逻辑
4. **systemd / launchd 模板**：决定一键安装的脚本怎么写
5. **多任务并行的实际收益**：MVP 先做单任务，并行留到 P1 评估
