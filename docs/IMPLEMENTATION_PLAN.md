# idleloop 实施计划

本文档是 [`PRD.md`](PRD.md) 和 [`TECH_DESIGN.md`](TECH_DESIGN.md) 的**执行指南**。
两份上游文档定义"做什么"和"怎么设计"，本文档定义"按什么顺序做、每一步的验收
是什么、未决问题怎么落地"。

不会在这里重复 PRD/TECH_DESIGN 已经写清楚的内容，只补充实施细节。

## 1. 现状（2026-05-13）

- 项目阶段：从设计阶段进入 Phase 0 实施
- 已有：完整的 PRD、TECH_DESIGN、NAMING；空仓库 + AI Native 元信息文件
- 待建：所有源码、所有测试、CLI 入口
- 环境：Node 24.14.0、npm 11.9.0、claude CLI 2.1.131、git 2.25.1
- 凭证：`~/.claude/.credentials.json` 存在，OAuth token 有效

## 2. TECH_DESIGN §13 未决问题 — 处理结果

### 2.1 ✅ OAuth 端点真实 schema

实测 `GET https://api.anthropic.com/api/oauth/usage`（用 Bearer token），响应：

```json
{
  "five_hour": {
    "utilization": 7.0,
    "resets_at": "2026-05-12T16:10:01.061414+00:00"
  },
  "seven_day": {
    "utilization": 25.0,
    "resets_at": "2026-05-15T13:00:00.061434+00:00"
  },
  "seven_day_oauth_apps": null,
  "seven_day_opus": null,
  "seven_day_sonnet": {
    "utilization": 5.0,
    "resets_at": "2026-05-15T13:00:01.061441+00:00"
  },
  "seven_day_cowork": null,
  "seven_day_omelette": { "utilization": 0.0, "resets_at": null },
  "tangelo": null,
  "iguana_necktie": null,
  "omelette_promotional": null,
  "extra_usage": {
    "is_enabled": false,
    "monthly_limit": null,
    "used_credits": null,
    "utilization": null,
    "currency": null
  }
}
```

**关键修正**（覆盖 TECH_DESIGN §3.1 的猜测值）：

1. `utilization` 是 **0-100 的百分比**，不是 0-1。TECH_DESIGN 例子里写的 `0.42` 是错的。
   实际 `7.0` 表示用了 7%。
2. `resets_at` 是 ISO-8601 带微秒和时区（`+00:00`），不是去掉微秒的版本。
3. **核心窗口** 只有 `five_hour` 和 `seven_day` 两个非空。
4. **辅助窗口**：`seven_day_opus / seven_day_sonnet / seven_day_cowork / seven_day_omelette`
   等都可能为 null，schema 必须全部标 nullable。MVP 只用 `five_hour` 和 `seven_day`。
5. **extra usage 块**：用户开了 pay-as-you-go 才会有数据，目前是 `is_enabled: false`。
   MVP 不参与决策，但 schema 要解析进去便于将来用。
6. **辅助端点**：`GET /api/oauth/profile` 返回账户信息（subscription_type、
   rate_limit_tier、organization 等），`init` 命令首次配置时用来验证 token 有效性。

OAuth token 来源（覆盖 TECH_DESIGN §3.2）：

- 凭证文件路径在 Linux 上是 `~/.claude/.credentials.json`（注意带前导点）
- JSON 结构：

  ```json
  {
    "claudeAiOauth": {
      "accessToken": "<108 char token>",
      "refreshToken": "<108 char token>",
      "expiresAt": 1778623175218,
      "scopes": [...],
      "subscriptionType": "max",
      "rateLimitTier": "default_claude_max_20x"
    }
  }
  ```

- 字段 `expiresAt` 是毫秒时间戳；过期需要走 refresh（Phase 2 实现）

### 2.2 ✅ claude CLI 的能力

实测 `claude --help`（v2.1.131），相关 flag：

| 用途 | flag | 说明 |
|---|---|---|
| 非交互模式 | `--print, -p` | 必备 |
| 输出格式 | `--output-format stream-json` | 关键，能拿到实时 token 事件流（解决 §13.3） |
| 输入格式 | `--input-format stream-json` | 可选，需要追加输入时用 |
| 允许工具 | `--allowedTools <list>` | 支持精确模式如 `Bash(git *) Edit`（§13.2 解决）|
| 拒绝工具 | `--disallowedTools <list>` | 配合上面用 |
| 额外目录 | `--add-dir <dirs...>` | 允许 worktree 之外的目录访问 |
| 美元预算 | `--max-budget-usd <amount>` | **直接限制花费**，比统计 token 更准 |
| 跳过权限 | `--dangerously-skip-permissions` | 无人值守必须 |
| 干净环境 | `--bare` | 跳过 CLAUDE.md auto-discovery / hooks / LSP，强隔离 |
| 不存会话 | `--no-session-persistence` | runner 默认开，不污染 session 历史 |
| 内置 worktree | `--worktree [name]` | 注意：我们自己用 simple-git 管 worktree，不用这个 |
| 模型 | `--model <alias>` | 必要时指定 sonnet/opus/haiku |
| effort | `--effort <level>` | 控制思考深度 |

**runner 启动 claude 的最终命令**（覆盖 TECH_DESIGN §4.4 步骤 2）：

```typescript
execa('claude', [
  '--print',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--input-format', 'text',
  '--add-dir', worktreePath,
  '--allowedTools', 'Read,Edit,Write,Bash',
  '--max-budget-usd', String(task.budgetUsd),
  '--dangerously-skip-permissions',
  '--no-session-persistence',
  '--bare',
], {
  cwd: worktreePath,
  input: task.prompt,
  encoding: 'utf-8',
});
```

`stream-json` 输出每行是一个 JSON 事件，能解析出 `usage.input_tokens`、
`usage.output_tokens`、`usage.cache_creation_input_tokens` 等字段。runner 边读边累计，
触达硬限再 SIGTERM——但其实 `--max-budget-usd` 已经会让 claude 自己停，我们只做兜底。

### 2.3 ✅ HTTP 代理支持（新增，实施期间发现）

实施 Watcher 模块时发现一个真坑：Node 20+ 的全局 `fetch` 默认**不读** `HTTPS_PROXY` /
`HTTP_PROXY` 环境变量，而 curl / 系统级 HTTP 客户端会读。在代理环境下（如开发机
配了 SOCKS/HTTP 代理）会导致 fetch 直连失败，被远端 WAF 返回 403 Forbidden。

解决：引入 `undici` 依赖（Node 已捆绑但需显式 import），从 env 读 `HTTPS_PROXY` /
`https_proxy` / `HTTP_PROXY` / `http_proxy`，构造 `ProxyAgent` 注入 dispatcher。
封装在 `src/utils/http.ts` 的 `proxiedFetch`，作为 OAuth client 的默认 fetcher。

测试用注入的 `fetchFn` 绕过这一层，所以不受 env 影响。

### 2.4 ⏸ systemd / launchd 模板

Phase 0/1 不做，留到 Phase 2 `daemon` 命令实施时再写。原因：daemon 主循环
本身用 setInterval 跑就够，systemd unit 只是部署皮，先把核心循环跑通再说。

### 2.4 ⏸ 多任务并行

明确推迟到 P1。MVP 内单 idle session 内**串行**跑任务，简单可控。

## 3. Phase 0：能看到余量（脚手架 → status 命令）

**总目标**：`idleloop status` 能打印真实余量、reset 倒计时、订阅信息。

### 3.1 Sprint A — 项目脚手架

**产出**：

- `package.json`（私有，bin: `idleloop`，scripts: dev/build/test/lint/typecheck）
- `tsconfig.json`（strict + ESM + NodeNext + isolatedModules）
- `.prettierrc.json`（单引号、2 空格、带分号）
- `eslint.config.js`（flat config，TS strict 规则）
- `vitest.config.ts`
- `.editorconfig`
- `src/` 空目录骨架（按 TECH_DESIGN §7 布局）
- `tests/` 空目录骨架
- 一个 placeholder `src/cli/index.ts` 让 `npm run dev` 可启动

**验收**：

- `npm install` 通过
- `npm run typecheck` 通过（即使 src 几乎空）
- `npm run dev -- --version` 输出 `0.0.0`

**依赖**：完整列表见 TECH_DESIGN §8，但精简调整：

- 替换 `pnpm` 相关：默认 verify 改为 `npm test || tsc --noEmit`
- 不预装 `pino-pretty`（dev only），先用 `pino` 默认
- 加 `@types/node`
- 测试加 `@vitest/coverage-v8`

### 3.2 Sprint B — storage 模块

**产出**：

- `src/storage/paths.ts`：`userDataDir()` → `~/idleloop/`；`stateDir()` → `~/.idleloop/`；
  `worktreesDir()`、`logsDir(date)`、`quotaJsonlPath()`，附 `ensureDir`
- `src/storage/config.ts`：
  - YAML 加载 `~/idleloop/config.yml`
  - zod schema 严格匹配 TECH_DESIGN §6.2
  - 缺文件时返回 defaults 但标记 `isDefault: true`
  - 给 init 命令暴露 `writeDefaultConfig()`
- `src/types/index.ts`：导出 `QuotaSnapshot`、`Config`、`Task`、`TriggerDecision` 等

**验收**：单元测试覆盖：缺文件、字段缺失、字段类型错、合法配置。

### 3.3 Sprint C — watcher 模块

**产出**：

- `src/watcher/token-source.ts`：
  - 读 `~/.claude/.credentials.json`，提取 `claudeAiOauth.accessToken`
  - env fallback：`IDLELOOP_CLAUDE_TOKEN`（区别于 claude 自己的环境变量名，
    避免误读）
  - 返回 `{ token, expiresAt, subscriptionType }`
  - 检查 `expiresAt` 距今 < 5 分钟时记 warning（refresh 留 Phase 2）
- `src/watcher/oauth-client.ts`：
  - 单一函数 `fetchUsage(token): Promise<RawUsageResponse>`
  - zod schema `RawUsageResponseSchema` 完整覆盖上文 §2.1 的实测结构
  - HTTP 401 → throw `TokenInvalidError`；5xx → 指数退避 3 次；网络 timeout 30s
- `src/watcher/index.ts`：
  - `Watcher` 类实现 TECH_DESIGN §4.1 接口
  - `snapshot()` 内部把 utilization 从 0-100 normalize 成 0-1 的 `remaining`
    （`remaining = 1 - utilization/100`），保持后续模块用统一的"剩余比例"语义
  - `startPolling()` 用 `setInterval`，emit 'update' 事件
  - 每次 snapshot 写一行到 `~/.idleloop/state/quota.jsonl`
  - 失败时降级到 `cli_fallback`（Phase 0 占位，throw NotImplementedError）

**验收**：

- 单元测试：mock fetch，覆盖 200 正常 / 401 / 500 重试 / schema 缺失 / 字段为 null
- 集成测试（手动跑）：真实 token 调一次，打印 snapshot 不报错

### 3.4 Sprint D — CLI 入口 + init/status

**产出**：

- `src/cli/index.ts`：commander 入口，注册子命令，统一错误处理
- `src/cli/commands/init.ts`：
  - 创建 `~/idleloop/`、`~/idleloop/queue/`、`~/.idleloop/state/`、
    `~/.idleloop/worktrees/`、`~/.idleloop/logs/` 目录
  - 写 `~/idleloop/config.yml` 默认配置（带注释）
  - 调 `/api/oauth/profile` 验证 token，打印 "Authenticated as <email>"
- `src/cli/commands/status.ts`：
  - 调 `Watcher.snapshot()`
  - 漂亮打印：
    ```
    5h 窗口：剩余 93%（utilization 7%），距 reset 2 小时 41 分
    7d 窗口：剩余 75%（utilization 25%），距 reset 2 天 13 小时
    订阅：claude_max_20x
    最近一次拉取：2026-05-13 14:23:01
    ```
  - 增加 `--json` flag 输出机读版本

**Phase 0 总验收**：

1. `idleloop init` 在干净环境下能初始化
2. `idleloop status` 能打印真实余量
3. `npm test` 全绿
4. `npm run lint` 零 warning
5. `npm run typecheck` 通过

## 4. Phase 1 起步：能跑通 dry-run

**总目标**：`idleloop run --dry` 能从队列里挑一个任务，走完
Trigger → Curator → Runner 全流程（不真启 claude），生成 shift log。

### 4.1 Sprint E — trigger 模块

**产出**：

- `src/trigger/user-activity.ts`：扫 `~/.claude/projects/` 下所有文件 mtime，取最大值
- `src/trigger/policy.ts`：单个 policy 的 evaluate(snapshot) → 是否满足
- `src/trigger/index.ts`：`TriggerEngine` 类，组合多个 policy + quiet hours +
  user activity guard，输出 `TriggerDecision`

**验收**：单元测试覆盖：刚好等于阈值、quiet hours 边界、用户刚活跃、多 policy 任一满足。

### 4.2 Sprint F — curator 模块 + T1 书架

**产出**：

- `src/types/task.ts`：`Task` 接口 + zod schema（按 TECH_DESIGN §6.1 frontmatter
  字段）
- `src/curator/strategies/bookshelf.ts`：
  - 读 `~/idleloop/queue/*.md`
  - 用 `gray-matter` 解析 frontmatter
  - 校验 frontmatter 字段（zod）
  - body 当作 prompt（去掉前面的 `## Prompt` 标题）
- `src/curator/index.ts`：
  - 注册 strategies
  - `gather(budgetTokens)` 调用所有 strategy.discover()，合并、按 cost 排序
  - 输出 Task 列表

**验收**：

- 单元测试用 `tests/fixtures/queue/*.md` 覆盖：合法 / frontmatter 缺字段 /
  body 为空 / cost 超 budget 时排除
- 集成测试：往 `tests/fixtures/queue/` 放 2 个 md，gather() 返回 2 个 Task

### 4.3 Sprint G — runner 骨架（不真启 claude）

**产出**：

- `src/runner/worktree.ts`：
  - `createWorktree(task)`: 在 `~/.idleloop/worktrees/{task-id}/` 创建，
    分支名 `idleloop/{YYYY-MM-DD}/{task-id-short}`
  - `cleanupWorktree(task-id, keep: boolean)`
- `src/runner/safety-gate.ts`：
  - `checkDiff(worktreePath, task)`: 用 `simple-git.diffSummary()` 判断行数
  - `checkForbiddenPaths(diff, task)`: 任何 forbidden 路径出现在 diff 中即拒
  - `checkLockfiles(diff)`: package-lock / pnpm-lock / yarn.lock 任何变动即拒
- `src/runner/claude-process.ts`：
  - `runClaude(task, worktreePath, budgetUsd)`：用 §2.2 的命令启动
  - stdout 是 stream-json，按行解析，emit `'usage'` 事件
  - `--dry` 模式：不真启，直接 fake 一个 successful 的输出
- `src/runner/verify.ts`：执行 `task.verify_command`，超时 5 分钟
- `src/runner/index.ts`：编排上面四个，返回 `TaskResult`

**验收**：

- 单元测试：safety-gate（mock diff summary）、worktree（mock simple-git）
- 集成测试：`runner.execute(task, { dry: true })` 全程跑通，TaskResult.status='success'，
  不真创建文件

### 4.4 Sprint H — run / add / list 命令

**产出**：

- `src/cli/commands/add.ts`：
  - 验证传入文件是合法 Task md
  - 复制（或符号链接？默认复制）到 `~/idleloop/queue/`
  - 给 frontmatter 加 `added_at`
- `src/cli/commands/list.ts`：
  - 读队列，表格化展示
- `src/cli/commands/run.ts`：
  - 单次触发模拟：snapshot → trigger.shouldTrigger → curator.gather → runner.execute
  - `--dry` 传给 runner
  - 输出每一步决策过程

**Phase 1 起步总验收**：

1. 写一个 `tests/fixtures/queue/sample-task.md` 任务，`idleloop list` 能列出
2. 在测试 fixture 项目里跑 `idleloop run --dry` 走完全流程
3. 触发被 quiet hours 拦截时给出明确原因
4. `npm test` 全绿（含上面所有模块的单元 + 集成测试）
5. 没有真启动 claude CLI（dry-run 模式短路）

## 5. 不在本次会话范围内（Phase 2 及之后）

为避免范围漂移，明确推迟：

- ❌ Daemon 主循环 + systemd unit 文件（Phase 2）
- ❌ Shift log markdown 模板渲染（Phase 2）
- ❌ Review 交互模式（Phase 2）
- ❌ T2/T3/T4 strategy（goals / audit / test-gap / book-expand / proposal）
- ❌ OAuth refresh token 流程
- ❌ CLI fallback（解析 claude PTY 输出推断余量）
- ❌ 多任务并行
- ❌ 任务置信度分级 auto_merge 自动合入
- ❌ 偏好学习、周报、提案

这些会在下一个会话基于 MVP 是否能跑通用户反馈再启动。

## 6. 实施顺序与依赖

```
Sprint A (脚手架)
   ↓
Sprint B (storage) ──→ Sprint C (watcher) ──→ Sprint D (status) ━━ [Phase 0 验收]
                                                    ↓
                                              Sprint E (trigger)
                                                    ↓
                                              Sprint F (curator)
                                                    ↓
                                              Sprint G (runner)
                                                    ↓
                                              Sprint H (run cmd) ━━ [Phase 1 起步验收]
```

线性依赖，不并行。每个 sprint 完成后跑测试再下一个。

## 7. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| OAuth 端点字段悄悄变 | Watcher 崩 | zod 严格解析，schema mismatch 时 log 原始响应 + 降级 |
| `--max-budget-usd` 行为和预期不符 | budget 失控 | runner 自己也累计 stream-json 的 usage，硬上限兜底 |
| 在 testbox 环境没有真实 Claude 项目目录 | user-activity 检测无效 | 测试用 fixture dir + DI 注入路径；prod 默认 `~/.claude/projects/` |
| 测试需要真实 OAuth token | CI 不可跑 | 所有依赖 token 的测试标记 `it.skipIf(!process.env.IDLELOOP_E2E_TOKEN)` |
| 用户 expiresAt 已过期 | token 失效 | Phase 0 init 命令显式检查，让用户手动重登；refresh 走 Phase 2 |

## 8. 验证不被遗漏的事

实施期间随时核对：

- **不在仓库内写运行时数据**（AGENTS.md 红线 6）
- **不读非声明项目目录**（AGENTS.md 红线 2）
- **不调外部第三方**（AGENTS.md 红线 3）
- **每个 PR 范围对应一个 sprint**，commit message 走 conventional commits

## 9. 与上游文档的差异更新

本计划相对 TECH_DESIGN 的修正/新增：

- §3.1 OAuth 响应 schema → 重写为本文档 §2.1 的实测版本
- §3.2 token 来源路径 → 修正为 `~/.claude/.credentials.json`（带点）
- §4.4 runner 启动 claude 的命令 → 替换为本文档 §2.2 的命令（含 `stream-json`、
  `--max-budget-usd`、`--bare` 等新 flag）
- §6.1 任务 frontmatter 字段命名 → 实施时 snake_case 保持不变
- §11 路线表的 Phase 0 验收 → 收窄为「`idleloop status` 打印真实余量」

如果发现实施和上面任何一条冲突，**先停下问用户**，不要默默改设计。
