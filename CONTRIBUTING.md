# 贡献指南

欢迎给 idleloop 提 issue 或 PR。本仓库公开承认：**大部分代码会由 AI 协助完成，
包括维护者自己的提交**。这份文件描述我们如何在 AI 协作下保持代码质量。

## 提 issue 之前

1. 搜一下 open / closed issues 有没有重复
2. **bug** 要可复现：贴 reproduce 步骤、环境（Node 版本 / OS）、预期 vs 实际
3. **feature 提案** 先描述使用场景再描述实现方案
4. **设计讨论** 建议在 issue 里发起，不要直接开 PR

## PR 流程

1. fork → feature 分支 → 改动 → PR 到 `main`
2. commit message 走 [Conventional Commits](https://www.conventionalcommits.org/)，**英文**
3. 本地必须跑过：
   - `npm run lint`
   - `npm test`
   - `npm run build`
4. PR 描述里必填：
   - 解决了什么问题（或链接 issue）
   - 验证步骤（哪些命令跑过、手动测了什么）
   - AI 参与程度（见下节）

## AI 协作策略

idleloop 本身就是一个 AI 自动化工具，对 AI 生成代码的态度是
**鼓励但严格审核**：

- ✅ **欢迎**：用 Claude Code / Codex / Cursor / Aider 等任何工具协助生成的 PR
- 🔒 **要求**：人类作者对每一行代码负责，理解了再合入。不接受「我没看，AI 写的」
- 📋 **要求**：在 PR 描述里如实标注 AI 参与程度：
  - `none` — 全部手写
  - `minor` — AI 做了补全、改名、文档润色等非核心改动
  - `substantial` — 核心逻辑 AI 写，作者已逐行 review
  - `fully-generated` — 整段 AI 生成，作者已逐行确认理解并能维护
- ❌ **拒绝**：含未审核 AI 内容、跑不通测试、改动超出 PR 描述范围、
  夹带 unrelated refactor 的 PR

详细的 AI 协作约定见 [`AGENTS.md`](AGENTS.md) 和 [`CLAUDE.md`](CLAUDE.md)。

## 代码风格

- TypeScript strict 模式，禁用 `any`
- 单引号 / 2 空格 / 带分号 / Prettier 默认配置
- 命名：函数 camelCase，类型 PascalCase，常量 SCREAMING_SNAKE_CASE
- 注释默认中文，标识符英文
- 不写 JSDoc 模板填空；只在 why 不明显时加注释

## 红线（必读）

无论是人写还是 AI 写，下面这些禁忌一视同仁。详细列表见 `AGENTS.md`。

- 不动 main 分支（PR review 通过才合入）
- 不读用户书稿 / 私有目录
- 不调用第三方网络（仅允许 Anthropic 官方端点）
- 不引入新依赖前先在 PR 里说明用途
- 不把运行时副作用文件写进仓库

## 行为准则

对人尊重，挑技术不挑人。讨论用证据，反对意见用具体的反例。

## 许可

通过提交 PR，你同意你的贡献按 [MIT License](LICENSE) 发布。
