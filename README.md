# idleloop

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![AI Native](https://img.shields.io/badge/AI--Native-CLAUDE.md%20%7C%20AGENTS.md-purple)](AGENTS.md)
[![Status: phase 1 starter](https://img.shields.io/badge/status-phase%201%20starter-blue)](docs/STATUS.md)

让 Claude Code 在你睡觉时自动消耗即将重置的订阅余量，帮你写书、补测试、修 bug——
所有产出都隔离在独立分支，等你早上 review。

仓库：[github.com/secreter/idleloop](https://github.com/secreter/idleloop)

## 一句话定位

订阅了 Claude Max / Pro 用不完？让 AI 在余量快重置前自动拉取队列任务跑起来，
每件事独立分支 + 验证 + shift log，要的合并不要的丢。

## 项目状态

**Phase 1 起步完成**。Watcher / TriggerEngine / Curator / Runner 主链路串通，
`idleloop status` / `init` / `list` / `add` / `run --dry` 可用。

下一步是 Phase 2（shift log + daemon + 真实 claude 联调）。
完整状态见 [`docs/STATUS.md`](docs/STATUS.md)。

## 文档

| 文件 | 用途 |
|---|---|
| [`docs/STATUS.md`](docs/STATUS.md) | **当前进度快照** — 新会话开始先读这一份 |
| [`docs/PRD.md`](docs/PRD.md) | 需求文档：动机、目标、功能、验收标准 |
| [`docs/TECH_DESIGN.md`](docs/TECH_DESIGN.md) | 技术框架：架构、模块、数据源、依赖 |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | 实施计划：sprint 拆分 + 实测 OAuth schema + 风险 |
| [`docs/NAMING.md`](docs/NAMING.md) | 命名探索：候选词与最终决策 |
| [`AGENTS.md`](AGENTS.md) | 跨工具 AI 协作契约（写给所有 AI Agent） |
| [`CLAUDE.md`](CLAUDE.md) | Claude Code 专属补充约定 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献者指南 + AI 协作策略 |

## 核心数据源

直接调用 Claude Code 的 OAuth usage 端点（`GET https://api.anthropic.com/api/oauth/usage`），
实时读取 `five_hour` 和 `seven_day` 利用率与 reset 时间戳，比解析本地 JSONL 文件
更准、更轻量。

## 技术栈

- 语言：TypeScript（严格模式）
- 运行时：Node.js >= 20 LTS
- 包管理：npm
- 风格：单引号、2 空格、带分号、Prettier 默认配置

完整依赖见 [`docs/TECH_DESIGN.md` §1](docs/TECH_DESIGN.md)。

## 项目原则

- **反向触发**：余量驱动，不浪费才是目标
- **强制隔离**：所有 AI 产出走独立 worktree 分支，main 永不污染
- **人工 review**：默认不自动合并，shift log 帮你 5 分钟决定每个任务的去留
- **本地运行**：不传任何数据到外部，工具本身不耗 token
- **AI Native**：仓库为 AI 协作而设计，[`AGENTS.md`](AGENTS.md) + [`CLAUDE.md`](CLAUDE.md) 是一等公民

## 许可

[MIT](LICENSE) © 2026 secreter
