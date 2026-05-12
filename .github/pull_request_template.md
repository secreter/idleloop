## 改动概要

<!-- 一句话说清这个 PR 解决什么问题。链接相关 issue。 -->

Closes #

## 怎么测的

<!-- 列出本地实际跑过的命令 / 复现步骤。空着或全填「应该没问题」的 PR 会被打回。 -->

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] 手动验证步骤：

## AI 参与程度

<!-- AI Native 仓库的真诚检查。如实选一项，详细分级见 CONTRIBUTING.md。 -->

- [ ] `none` — 全部手写
- [ ] `minor` — AI 补全 / 改名 / 文档润色
- [ ] `substantial` — 核心逻辑 AI 写，作者已逐行 review
- [ ] `fully-generated` — 整段 AI 生成，作者已逐行确认理解并能维护

使用的 AI 工具（可多选）：

- [ ] Claude Code
- [ ] OpenAI Codex
- [ ] Cursor
- [ ] Aider
- [ ] 其他：

## 自查清单

- [ ] commit message 走 Conventional Commits 且为英文
- [ ] 改动范围和 PR 描述一致，没夹带 unrelated refactor
- [ ] 涉及配置 / API / 红线变更已同步更新 `docs/` 或 `AGENTS.md`
- [ ] 没引入新依赖（如有，已在下方说明）
- [ ] 不触碰红线（见 `AGENTS.md`）

## 新依赖说明（如无则删除本节）

| 包 | 用途 | 替代方案 / 为什么不能手写 |
|---|---|---|
| | | |
