# AGENTS.md

本文件是写给**所有 AI 编码工具**的协作契约——Claude Code、OpenAI Codex、Cursor、
Aider、Continue 等都按 AGENTS.md 事实标准自动读取。Claude Code 通过 `CLAUDE.md`
中的一行 import 引用本文件，Claude-only 的补充约定写在 `CLAUDE.md` 里。

人类贡献者也建议读一遍——本仓库公开承认大部分代码会由 AI 协助完成，这份文件
是质量边界的保险丝。

## 项目使命

idleloop 是一个本地 CLI 工具。它在订阅用户即将浪费 Claude Max / Pro 余量时
（5 小时滚动窗口或 7 天滚动窗口接近 reset），自动从任务队列拉一件值得做的事
——扩写书稿、补测试、修 lint、跑代码审计——在隔离的 git worktree 里跑完，
等用户早上 review。

设计哲学是「**反向触发**、**强制隔离**、**人工 review**」：余量驱动而非时间驱动，
所有产出隔离在独立分支，main 永不污染，没有 PR review 不进 main。

## 权威文档

修改任何东西之前，先读这两份；它们是单一信息源，本文件不重复细节：

- 需求文档：[`docs/PRD.md`](docs/PRD.md)
- 技术框架：[`docs/TECH_DESIGN.md`](docs/TECH_DESIGN.md)
- 命名背景：[`docs/NAMING.md`](docs/NAMING.md)

如果发现源码和上面两份文档不一致，先停下，问用户哪个是真。不要默默以代码为准
顺手改文档，也不要默默以文档为准强行改代码。

## 技术栈

| 维度 | 选择 |
|---|---|
| 语言 | TypeScript（严格模式，禁 `any`） |
| 运行时 | Node.js >= 20 LTS |
| 包管理 | npm |
| CLI 框架 | `commander` |
| 配置格式 | YAML（`yaml` 包） |
| 任务定义 | Markdown + frontmatter（`gray-matter`） |
| 进程编排 | `execa` |
| 守护进程 | systemd / launchd |
| 日志 | `pino` |
| Git 操作 | `simple-git` |
| HTTP | 原生 `fetch` |
| 测试 | `vitest` |

**不引入**：Electron、Tauri、数据库、React、Next.js、LangChain、任何 Agent 编排框架。
直接调 `claude` CLI 子进程比加一层封装更简单可控。

## 仓库布局

```
idleloop/
├── src/                # 源码（实现阶段建立）
├── test/               # 测试
├── docs/               # PRD / 技术框架 / 命名背景
│   ├── PRD.md
│   ├── TECH_DESIGN.md
│   └── NAMING.md
├── examples/           # 示例 config.yml / 任务模板
├── scripts/            # 构建发布脚本
├── .github/            # PR 模板等
├── CLAUDE.md           # Claude Code 入口（import AGENTS.md）
├── AGENTS.md           # 跨工具 AI 协作契约（本文件）
├── CONTRIBUTING.md     # 贡献者指南 + AI 协作策略
├── README.md           # 用户视角入口
└── LICENSE
```

用户运行时数据在 `~/.idleloop/`（config、队列、worktrees、logs），**不在仓库内**。
不要把任何运行时产物写进仓库。

## 红线：绝对不做

按严重程度排序：

1. **不动 main 分支**。所有改动走 feature 分支或 worktree，PR review 通过才合入。
2. **不读不传用户书稿**。idleloop 的 worktree 范围是用户在 `config.yml` 显式声明的
   项目目录。如果发现自己在读 `~/workspace/llm-infra-book/` 等未声明目录，立即停下报错。
3. **不调用外部网络**，除了：Anthropic 官方端点（`api.anthropic.com`）、用户 config
   显式声明的 git remote。第三方 LLM、telemetry、analytics、错误上报一律拒绝。
4. **不读其他工具的 OAuth token**。idleloop 自己读 `~/.claude/oauth.json`
   （或等价位置）的流程在 `docs/TECH_DESIGN.md` §3，**仅此一种**读法。
5. **不引入新依赖**前先在 PR 描述里说明用途。优先用 Node 原生 API；能 50 行手写的
   不引入 500KB 的依赖。
6. **不写运行时副作用文件**到仓库内（缓存、状态、临时 worktree、日志一律到 `~/.idleloop/`）。

## 代码风格

- TypeScript strict，禁用 `any`（必要时用 `unknown` 或精确类型）
- 单引号 / 2 空格 / 带分号 / Prettier 默认配置
- 命名：函数 camelCase，类型 / 接口 PascalCase，常量 SCREAMING_SNAKE_CASE
- 注释默认中文，标识符英文；不写 JSDoc 模板填空（`@param foo - the foo` 这种）
- 只在 **why 不明显**时写注释；what 用名字说话

## 提交规范

- [Conventional Commits](https://www.conventionalcommits.org/)，**英文**
- 例：`feat(watcher): add five-hour reset countdown cache`
- 一次 commit 一件事，不要混入无关 refactor
- AI 生成的 commit 在 message 末尾加一行：
  `Co-Authored-By: Claude <noreply@anthropic.com>`（其他工具替换名字）

## 构建 / 测试 / 验证

实现阶段建立 `package.json` 后，约定脚本：

```bash
npm install          # 安装依赖
npm run lint         # ESLint + Prettier check
npm test             # vitest
npm run build        # tsc + 打包
npm run dev          # 本地直接跑 CLI（ts-node 或 tsx）
```

任何代码改动 PR 必须本地至少跑通 `npm test` 和 `npm run build`，
并在 PR 描述里列出验证过的命令。

## AI 协作约定

写给读这份文件的下一个 AI Agent，比写给人类还重要：

1. **不要凭记忆推断架构**。源码改了文档没同步是常态，每次改前读相关源码。
2. **跨 5 个以上文件的改动先出计划**，等用户 ack 再开干。不要在没有方案的情况下
   连续 edit 一堆文件，回滚成本会爆。
3. **不要生成工作流副产品 markdown**：`session_notes.md` / `decisions.md` /
   `progress.md` / `TODO.md` 一律不要建。该追踪的事用 git commit message 和 PR
   描述记录，剩下的靠 issue tracker。
4. **不要写「summary of what I did」段落**。git diff 已经说明一切，PR 描述里
   写 why 而不是 what。
5. **凡是涉及网络请求、文件系统写入、子进程启动**，先确认是否在红线允许范围内。
6. **遇到不确定，问用户**。不确定该用哪个库、不确定该不该改、不确定 PRD 怎么解释——
   问比猜便宜。
