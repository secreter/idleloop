# idleloop 需求文档

## 1. 背景与动机

### 1.1 真实痛点

我（以及大多数 Claude Max / Pro 订阅用户）每月固定付费但用量经常用不完。Claude Code 的额度采用双窗口结构：

- **5 小时滚动窗口**：从你发出第一个 prompt 开始计时，5 小时后重置
- **7 天滚动窗口**：周度上限

到月底/周底接近重置时，如果剩余 30% 以上余量没用，等于直接浪费——重置后归零，无法滚存。

### 1.2 现有方案的局限

社区已有的相关工具盘点：

| 工具 | 解决了什么 | 缺什么 |
|---|---|---|
| claude-queue / claude-code-queue | 队列 + 余量监控 + 限额满了自动 pause/resume | 只防超额，不防浪费；任务都要手写 |
| Nightshift | 7 种代码库扫描策略 + worktree 隔离 + verification + shift log | 不感知 token 余量；只做代码维护，不做写作类任务 |
| continuous-claude | Ralph loop 接力 + max-cost/duration 预算控制 | 用户必须给固定 prompt |
| 官方 Scheduled Tasks / Routines | 云端定时执行 | 不感知 rolling window 余量；Routines 有每日 cap |
| CodexBar | 30+ 工具的余额查看 | 只读不调度 |

**关键空白**：没有一个工具同时做到「余量感知 + 反向触发（不浪费）+ 自动任务发散 + 安全沙箱」。这就是 idleloop 要填的空。

### 1.3 我的双重身份

我同时是技术书籍作者（《LLM Infra 工程实战》《OpenClaw 源码解析》等多本书在写）和全栈工程师（CoffeesMap、ai-watermark-remover 等多个工具项目）。两类工作都需要 AI 协助但顾不上做完，闲置余量正好可以填这个缝。

## 2. 用户场景

### 2.1 主场景：作者写书

我有 5 本书在不同推进阶段，每本都有 20+ 章大纲但只有 5-8 章写完。深夜睡觉时如果 5h 窗口还剩 60% 余量，我希望 AI 自动选一个章节大纲扩写成 2000+ 字的初稿，第二天早上我起来 review 并改稿。

### 2.2 副场景 1：工具项目维护

CoffeesMap 测试覆盖率只有 30%，AI 可以在闲时自动补关键模块的测试。ai-watermark-remover 有一批 lint warning 没处理，可以自动清理。

### 2.3 副场景 2：跨项目质量改进

`_references/` 下的开源项目源码可以让 AI 自动生成阅读笔记、架构梳理图，反哺我书籍的章节素材。

### 2.4 反场景（明确不做）

- **不在工作时间触发**：我正在用 Claude Code 时，idleloop 不能抢余量
- **不动 main 分支**：所有产出在独立 worktree 分支，main 永不污染
- **不传任何数据到外部服务**：写作类任务可能含未发表内容，必须本地处理

## 3. 目标用户

### 3.1 P0 用户（我自己）

订阅 Claude Max 20x 的全栈工程师 + 技术书籍作者，多项目并行，写作量大，余量经常用不完。

### 3.2 P1 用户

- Claude Pro / Max 5x / Max 20x 订阅者中，余量利用率 < 70% 的群体
- 同时维护多个开源 / 个人项目的开发者
- 用 AI 辅助创作（写作 / 文档 / 翻译）的非典型开发者

### 3.3 不适合的用户

- Anthropic API（按量计费）用户——按量付费没有"浪费"概念
- Enterprise 团队用户——他们的余量是企业账户管理，个人无控制权
- 重度日间使用、余量已经吃紧的用户

## 4. 产品目标

### 4.1 北极星指标

**"用户的月度 Claude 订阅余量利用率"**：从基线 60-70% 提升到 95%+，且产出物中 > 30% 被用户实际接受合并。

### 4.2 P0 目标（MVP 必须达到）

1. 实时读取 Claude Code 的 5h / 7d 余量与 reset 时间
2. 配置化的"反向触发"策略（距 reset < N 小时且剩余 > M% 时触发）
3. 至少支持两种任务源：用户手写书架 + 项目嗅探
4. 任务执行在独立 worktree 分支，失败自动 revert
5. 早晨生成 shift log（人类可读 markdown）+ 状态文件（机器可读 JSON）

### 4.3 P1 目标

1. 长期目标拆解（用户给方向，AI 拆任务）
2. 多项目并行调度
3. 任务级预算上限 + 单次 idle 总预算上限
4. 任务置信度分级（auto_merge / review_queue / draft_only）

### 4.4 P2 目标（未来版本）

1. AI 自主任务提案（每周日生成下周候选）
2. 周度复盘报告（"上周完成 7 项任务，节省 $43"）
3. 任务偏好学习（从接受/拒绝历史学风格）
4. 云端书架同步（多机共享）

## 5. 功能需求

### 5.1 P0 功能

#### F1 - 余量监控器（Watcher）

- 周期性（默认 15 分钟）调用 Claude OAuth usage 端点
- 缓存最近 N 次读数到本地（用于趋势分析）
- 配置项：轮询间隔、触发阈值、安静时段（绝不触发的小时段）
- CLI：`idleloop status` 立即查看当前余量

#### F2 - 触发策略引擎

- 默认策略：「5h 窗口距 reset < 1 小时且剩余 > 30%」或「7d 窗口距 reset < 12 小时且剩余 > 40%」
- 用户可在 `config.yml` 自定义阈值
- 反阈值条件：用户活跃中（最近 N 分钟有 Claude Code session 活动）则不触发

#### F3 - 任务源 T1：用户书架

- 目录约定：`~/idleloop/queue/*.md`
- 每个 md 文件即一个任务，frontmatter 含 `project / cost_estimate / acceptance / confidence`
- CLI：`idleloop add <file>` 把任务加入书架，`idleloop list` 查看队列

#### F4 - 任务源 T3：项目嗅探（基础版）

- 在 `config.yml` 配置 `projects: [{id, dir, strategies}]`
- 内置三种策略：`audit`（找 TODO/FIXME）、`test`（找无测试的模块）、`book-expand`（找未扩写的大纲条目）
- 触发时按策略扫描目录，生成候选任务进队列

#### F5 - 任务执行器（Runner）

- 为每个任务创建独立 git worktree（路径 `~/.idleloop/worktrees/{task-id}`）
- 通过 `claude` CLI 启动 Claude Code 在该 worktree 内执行
- 实时监控 Claude Code 进程的输出与 token 消耗
- 单任务预算上限触达时强制终止
- 任务结束后运行项目的 `verify` 命令（默认 `pnpm build || npm test || tsc --noEmit`，可配置）
- 验证失败：revert + 标记 `failed`；验证成功：进 review queue 等用户处理

#### F6 - Shift Log

每次 idle session 结束后生成两份文件到 `~/idleloop/logs/{date}/`：

- `shift.md`：人类可读，含执行摘要、每个任务的目的与产出、推荐合并的清单
- `state.json`：机器可读，含每个任务的 id / status / token_cost / duration / branch_name / verify_result

#### F7 - CLI 命令集

```
idleloop init                 # 初始化配置
idleloop status               # 查看当前余量与下次触发时间
idleloop add <file>           # 添加任务到书架
idleloop list                 # 查看队列
idleloop run --dry            # 模拟一次触发（不实际执行）
idleloop daemon start/stop    # 启动/停止守护进程
idleloop review               # 进入交互式 review 模式
idleloop logs [date]          # 查看历史 shift log
```

### 5.2 P1 功能

#### F8 - 任务源 T2：长期目标拆解

- 用户在 `~/idleloop/goals.yml` 定义高层目标
- 触发时由 Claude 读取目标 + 项目状态，自动拆解为可执行任务
- 拆解产出在 `~/idleloop/proposals/{date}.md`，用户审核后入队

#### F9 - 任务置信度分级

- 任务声明 `confidence: auto_merge | review_queue | draft_only`
- `auto_merge`：验证通过自动合入 main（仅限低风险类型，如 typo fix / format / lint）
- `review_queue`：默认行为，进 review 等人工处理
- `draft_only`：仅生成 draft 文件，不创建 git commit

#### F10 - 多项目并行调度

- 单次 idle session 可同时处理多个项目
- 项目级预算分配（按配置的 weight）
- 一个项目失败不阻塞其他项目

### 5.3 P2 功能

#### F11 - 任务源 T4：AI 自主提案

- 定时任务（如每周日 22:00）扫描所有项目 + 读取 CLAUDE.md 使命
- 生成 5-10 个下周候选任务，含 value / cost / acceptance / risk
- 用户次日 review 后选择性入队

#### F12 - 偏好学习

- 记录用户对每个任务的接受/拒绝决定到 `~/idleloop/history.jsonl`
- T4 提案时优先生成与"已接受"任务相似风格的候选
- 不用复杂 ML，简单规则匹配 + 关键词权重即可

#### F13 - 周度复盘报告

- 每周日生成 `~/idleloop/reports/{week}.md`
- 含：完成任务数、接受率、节省 token、按项目分布、推荐调整

## 6. 用户故事

### 6.1 故事 A：写书场景

> 周三晚上 23:30，我准备睡觉。idleloop 守护进程检测到 5h 窗口距 reset 1 小时 15 分，仍剩余 45% 余量。
>
> 它扫描 `llm-infra-book/` 找到 3 个未扩写的章节大纲文件，按配置选了风险最低的"第 4 章 RAG 基础"，启动 Claude Code 在独立分支 `idleloop/2026-05-12/llm-book-ch04` 内扩写。
>
> 25 分钟后任务完成，产出 `chapters/04-rag/README.draft.md`（约 2400 字）。verify 步骤运行 markdown lint 通过。任务进 review queue。
>
> 第二天早上我打开终端跑 `idleloop review`，看到候选清单。我浏览 ch04 草稿，觉得开头需要改但中段不错，于是手动合并中段，开头重写。

### 6.2 故事 B：工具维护场景

> 周五凌晨 2:00，7d 窗口距 reset 18 小时，仍剩余 55%。
>
> idleloop 触发，对 `coffeesmap/` 跑 `test` 策略，发现 `src/lib/places.ts` 无单元测试但有 6 个导出函数。启动任务"为 places.ts 添加 unit test"。
>
> Claude Code 在独立分支生成 `places.test.ts`，verify 跑 `npm test` 通过，覆盖率从 30% 提升至 41%。任务进 review queue。
>
> 我早上 review 后直接合并，无需改动。

### 6.3 故事 C：触发失败场景（安全闸生效）

> 凌晨 1:00 触发，任务"重构 places.ts 拆分为多个文件"。
>
> Claude Code 改动超过 max_diff_lines=150（声明的安全上限），runner 强制终止 + revert worktree。任务标记 `aborted_oversized`，shift log 记录原因。
>
> 早上我看到任务被中止，明白这个任务范围太大不适合自动跑，手动接管。

## 7. 验收标准（MVP 上线判定）

MVP 上线时必须满足：

1. F1-F7 全部实现且通过端到端测试
2. 真实跑通至少 7 个连续夜晚的自动触发，无误触发（在我正使用时被中断）
3. 至少 10 个任务实际完成 + 验证通过
4. 至少 3 个任务被我手动 review 后合并入 main
5. 没有任何一次任务破坏 main 分支或污染工作区
6. Shift log 信息密度满足"早上 5 分钟内能决定每个任务的去留"

## 8. 不做的事情（明确边界）

- **不做闭源 SaaS**：开源 CLI 工具，本地运行，所有数据不出本机
- **不接非 Claude 工具**：第一版只做 Claude Code，Cursor/Codex 等留到 P2 评估
- **不做团队功能**：MVP 是单用户单机工具
- **不做云端书架**：MVP 不做多机同步
- **不替代 PR review**：所有产出必须人工 review 才能进 main
- **不做 prompt 优化建议**：那是另一个产品方向
- **不读 secrets / 配置**：worktree 内的 `.env` / `secrets/` 等敏感目录默认排除

## 9. 命名与品牌

- 项目代号：`idleloop`（呼应作者品牌 inferloop）
- 备选名：`night-loop` / `loop-after-dark` / `bedtime-loop`
- 一句话定位：「订阅了 Claude Max 用不完？让 AI 在余量快重置前帮你写书、补测试、修 bug，所有产出独立分支等你 review。」

## 10. 风险与已知问题

### 10.1 OAuth 端点未公开

`GET /api/oauth/usage` 是 Claude Code 内部使用的端点，Anthropic 未官方文档化，可能随时变更。需要：

- 实现时做防御性处理（404 / 字段缺失时降级）
- 准备 fallback：解析 Claude Code 输出中的 reset 信息（参考 claude-code-queue 的方式）

### 10.2 我正在用 Claude Code 时的冲突

5h 滚动窗口的"reset 时间"在用户开新会话时刷新。如果 idleloop 在我开新会话前 30 秒触发，可能干扰我接下来的工作。

缓解：触发前检查最近 30 分钟内是否有 Claude Code 活动（通过 `~/.claude/projects/` 文件 mtime 判断），有则跳过。

### 10.3 任务质量参差

AI 自动生成的扩写章节质量可能远低于我的标准，导致 review 都嫌浪费时间。

缓解：T3 嗅探和 T4 提案都从最低风险类型起步（typo / lint / 单测），写作类任务必须有用户预先写好的大纲约束。

### 10.4 余量浪费的反讽

如果工具本身消耗大量 token（如频繁调用 OAuth 端点、不必要的提案生成），反而加剧浪费。

缓解：OAuth 端点本身不耗 token（是查询接口）；提案生成限制在每周一次。

## 11. 路线图

| 阶段 | 周期 | 目标 |
|---|---|---|
| Phase 0 | 1 周 | 项目脚手架 + OAuth usage 端点封装 + Watcher 原型 |
| Phase 1 | 2 周 | F1-F5（Watcher + 触发引擎 + T1 书架 + Runner + worktree） |
| Phase 2 | 1 周 | F6-F7（Shift log + CLI 命令集）→ MVP 上线（自用） |
| Phase 3 | 2 周 | F8-F10（长期目标拆解 + 置信度分级 + 多项目调度） |
| Phase 4 | 待定 | F11-F13（AI 提案 + 偏好学习 + 周报） |

MVP 目标：6 周内自用可用，自用稳定 4 周后开源。
