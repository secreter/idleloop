# idleloop 当前进度

> 这份文档记录项目在每个开发会话结束时的状态快照。**新会话开始前先读这一份**，
> 再去读 `PRD.md` / `TECH_DESIGN.md` / `IMPLEMENTATION_PLAN.md`。

最近更新：2026-05-13

## 一句话状态

Phase 0（能看到余量）+ Phase 1 起步（能跑通 dry-run）已完成。
core pipeline `Watcher → TriggerEngine → Curator → Runner` 串通，
但 Runner 的真实 claude 联调 + Phase 2 的 daemon/shift log/review 还没做。

## 验收勾选

### Phase 0 ✅

- [x] `idleloop status` 能打印真实余量（5h / 7d 利用率 + reset 倒计时）
- [x] `idleloop init` 创建目录 + 写默认 `~/idleloop/config.yml`
- [x] 单元测试覆盖 storage / watcher / cli
- [x] HTTPS_PROXY 环境下也能正确调 OAuth 端点

### Phase 1 起步 ✅

- [x] `idleloop list` 表格化展示队列
- [x] `idleloop add <file>` 校验并把 task md 加入队列
- [x] `idleloop run --dry` 走完整流水线（trigger → curator → runner）
- [x] dry 模式短路 Runner，不创建 worktree、不启 claude
- [x] 触发被 quiet hours / user_activity / 未满足 policy 拦截时给出明确原因
- [x] Runner 单元测试用 mock claudeRunner 覆盖 happy path / safety 中止 / verify 失败

### 工程基线 ✅

- [x] 186 tests 全绿（`npm test`）
- [x] `npm run typecheck` 干净
- [x] `npm run lint` 干净
- [x] `npm run build` 产出 ESM bundle 到 dist/
- [x] AI Native 元信息（CLAUDE.md / AGENTS.md / CONTRIBUTING.md）齐全
- [x] git 仓库已初始化，main 分支，首个 commit `6e99b21`

## 模块清单

```
src/
  cli/
    index.ts                  # commander 入口
    commands/
      init.ts                 # 建目录 + 写 default config + 验 token
      status.ts               # 展示余量 + reset 倒计时
      add.ts                  # 加任务到队列
      list.ts                 # 列出队列
      run.ts                  # 单次触发模拟（含 dry/force）
  storage/
    paths.ts                  # 路径解析（~/idleloop/ + ~/.idleloop/）
    config.ts                 # YAML + zod schema
  watcher/
    index.ts                  # Watcher 类
    oauth-client.ts           # /api/oauth/usage + /profile
    token-source.ts           # 从 ~/.claude/.credentials.json 读 token
    types.ts                  # QuotaSnapshot / QuotaWindow
  trigger/
    index.ts                  # TriggerEngine
    policy.ts                 # 单 policy 评估 + isInQuietHours
    user-activity.ts          # 扫 ~/.claude/projects/ 取 mtime
    types.ts                  # TriggerDecision
  curator/
    index.ts                  # Curator 编排
    task-loader.ts            # parseTaskMarkdown + loadTaskFromFile
    strategies/
      bookshelf.ts            # T1 用户书架
    types.ts                  # CuratorStrategy / CuratorReport
  runner/
    index.ts                  # Runner 类（dry + happy + safety/verify 路径）
    worktree.ts               # simple-git 创建/清理
    claude-process.ts         # 启动 claude CLI + parseStreamEvent
    safety-gate.ts            # diff lines / forbidden / lockfile 检查
    verify.ts                 # 跑 task.verify_command
  types/
    index.ts                  # 聚合 re-export
    task.ts                   # Task / TaskResult / TaskSchema
  utils/
    http.ts                   # proxiedFetch（含 undici ProxyAgent）
    logger.ts                 # pino → stderr
```

## 没做（Phase 2+ 待办）

按优先级排：

### 立刻需要的（Phase 2）

1. **Shift log 渲染**：`~/.idleloop/logs/{date}/shift.md` 模板 + `state.json` 写入
2. **Daemon 主循环**：`idleloop daemon start/stop`，systemd unit / launchd plist 生成器
3. **`idleloop review` 交互模式**：用 `@inquirer/prompts` 对每个 review_queue 任务给出 merge/discard/keep
4. **`idleloop logs [date]` 命令**：浏览历史 shift log
5. **真实 claude 联调**：把 Runner 的 `--dry` 去掉跑一次小任务，端到端验证 stream-json 解析

### 中期（Phase 3）

6. **T3 嗅探策略**：`audit`（TODO/FIXME）、`test-gap`（无测试模块）、`book-expand`（未扩写大纲）
7. **多项目调度**：单次 idle session 处理多个 project，按 weight 分配预算
8. **任务置信度分级**：`auto_merge` 走自动合入 main，仅限低风险类型
9. **OAuth refresh**：token 过期时用 refresh_token 续期

### 长期（Phase 4 / 未排期）

10. T2 长期目标拆解 / T4 AI 自主提案
11. 偏好学习（接受/拒绝历史驱动提案）
12. 周度复盘报告
13. CLI PTY fallback（OAuth 端点失败时解析 claude 输出兜底）

## 已知 gotcha（新会话踩前必读）

1. **OAuth `utilization` 是 0-100（百分比）**，不是 0-1。代码内部 normalize 成 `remainingPct: 100 - utilization`。
2. **Node fetch 不读 `HTTPS_PROXY`**——已用 `src/utils/http.ts` 的 `proxiedFetch` 解决，新模块发起 HTTP 时记得用它而不是裸 `fetch`。
3. **`isInQuietHours` 用本地时间**（`now.getHours()`），不是 UTC。测试要用 `new Date(year, monthIdx, day, hour, ...)` 而不是 `new Date('...Z')`，否则在非 UTC 机器上挂。
4. **git < 2.28 没有 `git init -b`**——开发机就是 2.25。初始化测试 repo 要 init → commit → rename。
5. **mockResolvedValue(response) 不能复用**——同一个 `Response` 实例 body 只能读一次。多次 snapshot 测试要用 `mockImplementation(() => Promise.resolve(jsonResponse({...})))` 给每次返回新实例。
6. **safety-gate 先 `git add -A`**——`git diff HEAD` 默认看不到 untracked 文件，所以我先 stage 全部。worktree 是 task 专属，stage 副作用可接受。
7. **logger 默认 level = warn**，info 级别被静默以避免污染 CLI 输出。调试用 `IDLELOOP_LOG_LEVEL=info`。

## 重要文件指针

| 想做的事 | 看这个 |
|---|---|
| 看完整产品定义 | `docs/PRD.md` |
| 看技术架构 / 模块设计 | `docs/TECH_DESIGN.md`（注意 §3.1 OAuth schema 已被 IMPLEMENTATION_PLAN §2.1 修正）|
| 看 sprint 拆分 / 实测的 OAuth schema / claude flag map | `docs/IMPLEMENTATION_PLAN.md` |
| 看本次会话进度（你正在读的）| `docs/STATUS.md` |
| 看 AI 协作规则 | `AGENTS.md` 红线 + `CLAUDE.md` 补充 |
| 任务格式 | `tests/fixtures/queue/valid-task.md`（带完整 frontmatter） |

## 验证命令（新会话开局先跑）

```bash
# 1. 拉依赖（如果是新 worktree）
npm install

# 2. 静态检查
npm run typecheck
npm run lint

# 3. 跑测试
npm test                   # 186 tests，预期全绿

# 4. 真实环境烟测（需要 ~/.claude/.credentials.json 存在）
npm run dev -- status      # 应打印真实 5h / 7d 余量

# 5. 端到端 dry-run（需要在隔离 HOME 下跑，否则会改你的 ~/idleloop/）
TEST_HOME=$(mktemp -d)
mkdir -p "$TEST_HOME/.claude" && cp ~/.claude/.credentials.json "$TEST_HOME/.claude/.credentials.json"
HOME="$TEST_HOME" npm run dev -- init --skip-verify
cp tests/fixtures/queue/valid-task.md "$TEST_HOME/idleloop/queue/sample.md"
HOME="$TEST_HOME" npm run dev -- run --dry
rm -rf "$TEST_HOME"
```

预期：trigger 决策打印、curator 报告 1 个任务、runner 返回 `[dry_run]` 状态。

## 下一步建议（写给下个会话的我）

我（前一次会话的我）建议这个顺序：

1. **先把 Shift Log 模块做了**（F6）—— Runner 已经能产出 TaskResult，再差一个 markdown + json 写出就是 Phase 2 第一块产出。Runner 单元测试已经覆盖各种 status，模板很好写。

2. **然后做一次真实 claude 联调**（不是新代码，是验证）—— 找一个超低风险任务，比如「在 fixture repo 里加一行注释」，把 `--dry` 去掉跑一次。看 stream-json 解析是否准确、--max-budget-usd 是否真的限流、verify 是否能跑通。这一步会发现 claude-process.ts 里假设的 bug。

3. **再做 daemon 主循环**（F1 完整版 + F7 daemon 命令）—— 把 single-shot 的 `run` 包成 setInterval 循环。systemd unit 文件用 template + 用户 home 路径生成。

4. **再扩 T3 策略** —— audit 最简单（grep TODO），test-gap 中等（扫 src/*.ts vs *.test.ts），book-expand 最有趣（你的实际写作场景）。

按这个顺序的话，第 1、2 步加起来一个会话；第 3 步单独一个会话；第 4 步可以拆 sprint。

不建议先做 T2/T4（长期目标拆解 / AI 自主提案）—— 没有 daemon + shift log 数据，那两个的反馈循环不闭环，做了也用不起来。
