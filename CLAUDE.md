# CLAUDE.md

跨工具通用约定都在 `AGENTS.md`，先读那一份。本文件只补充 Claude Code 专属内容。

@AGENTS.md

## Claude Code 专属补充

### 优先用的子能力

- **大范围搜索代码**：用 Explore 子代理，避免主上下文被搜索结果填满
- **多步骤实现前**：用 Plan 子代理出方案，让用户确认后再动
- **超过 5 步**的连续改动：先 plan，再实现；不要边写边推翻
- **跨独立任务并行**时：在一条消息里发多个 Agent 调用，不要串行等

### 守护进程类任务的测试

- 不要直接 `idleloop daemon start` 跑真守护——会阻塞 CLI 上下文
- 单次触发测试用 `idleloop run --dry`
- 需要长跑验证时用 Bash 的 `run_in_background`，看输出而不是 `sleep` 轮询
- 端到端验证守护进程时用 Monitor 工具流式读输出

### worktree 操作

仓库里有两类 git 操作，不要混：

- **改 idleloop 自己代码**：标准 feature 分支即可，`git switch -c feat/xxx`
- **测试 idleloop 创建/清理用户项目 worktree 的逻辑**：用 EnterWorktree 在
  本仓库的独立副本里跑，避免污染当前工作树

### Plan 偏好

- 设计阶段输出 plan 时，引用 `docs/PRD.md` / `docs/TECH_DESIGN.md` 的章节号，
  不要重述需求
- plan 里写「改哪些文件 + 改成什么样」，不要写「我会考虑...」「我会评估...」
- 不要把 plan 写成 markdown 文件存仓库，用 ExitPlanMode 给用户看

### 不要做的事

- 不要主动 `git push` / `git commit`，等用户明确说「提交」「commit」「push」
- 不要写 `session_notes.md` / `decisions.md` / `progress.md` 这类工作流副产品
- 不要在没人要的情况下生成 TODO 列表 markdown / 路线图 markdown
- 不要在每个回答末尾加「我刚才做了 A、B、C 三件事」的总结——diff 已经说明一切
- 不要主动重写已有的 PRD / TECH_DESIGN 文档段落，发现要改先和用户对齐

### 工作空间上下文

本仓库在 `/home/ubuntu/workspace/idleloop/`，是多项目 workspace 的一部分。
父目录 `/home/ubuntu/workspace/CLAUDE.md` 提供了作者背景、写作规范、其他项目索引
等更上层的约定（Claude Code 自动加载）。本仓库专属约定不要和那份重复。
