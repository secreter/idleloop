# idleloop 当前进度

> 这份文档记录项目在每个开发会话结束时的状态快照。**新会话开始前先读这一份**，
> 再去读 `PRD.md` / `TECH_DESIGN.md` / `IMPLEMENTATION_PLAN.md`。

最近更新：2026-05-13（overnight Phase 2 收官）

## 一句话状态

Phase 2 全功能 + 一轮代码审查修复 + 一轮 PM/产品视角修复都完成了。
现在功能上覆盖：daemon 主循环、shift log、logs/review 命令、T3 三种嗅探策略、
多项目加权调度、auto_merge、OAuth refresh、working_dir 守门、单 shift 预算上限、
doctor 自检、task template、preview-mode --dry。**293 tests 全绿**，
typecheck / lint / build 都干净。

唯一没做的是真实 claude 子进程端到端联调（需要桌面环境，下次会话用真实 claude 跑）。

## 验收勾选

### Phase 0 ✅（已有）

- [x] `idleloop status` 真实余量 + reset 倒计时
- [x] `idleloop init` 建目录 + 写默认 config + 验 token
- [x] HTTPS_PROXY 兼容 / 单元测试 / OAuth schema 实测

### Phase 1 ✅（已有）

- [x] `idleloop list` / `add <file>` / `run --dry`
- [x] dry 模式不触发 Runner 副作用

### Phase 2 ✅（本次新增）

#### Shift log（F6）

- [x] `src/shift-log/` 模块：render.ts + writer.ts + types.ts
- [x] 每次 shift 写 `~/.idleloop/logs/{date}/shift.md`（追加）+ `state.json`（覆盖）+ `shifts/{shiftId}.json` 单独留底
- [x] markdown 包含触发原因、quota snapshot、curator 报告、每个 task 详情、review 提示
- [x] blocked shift 也会写 log，但 headline 显式说 `Blocked: quiet_hours`，避免被误读为 0 任务挂掉
- [x] 14 个单元测试（render + writer）

#### Logs 命令（F2）

- [x] `idleloop logs` 默认最近一天，`--list` 多天概览（含 cost / tokens / blocked 标记），`--raw` cat shift.md，`--json` 机器可读，`--date YYYY-MM-DD` 指定
- [x] 7 个测试

#### Review 命令（F8）

- [x] `idleloop review` 列出所有 `success` + worktree 还存在的候选
- [x] 交互动作：merge / discard / keep / diff / quit
- [x] **merge 二次确认**（默认 confirmMerge=true；可 `-y` 跳过）
- [x] **merge 前检查源仓库 status.isClean()**，脏的拒绝
- [x] **checkout 到 baseBranch 再 merge**，merge 后恢复用户原分支
- [x] `--auto-merge-only` 跳过非 auto_merge 候选
- [x] `--limit N` 限制处理数量
- [x] 10 个测试（含真实 git worktree + merge happy path + dirty source 拒绝）

#### Daemon（F1 / F7）

- [x] `src/daemon/loop.ts` 主循环：`maxIterations`、`intervalMs`、AbortSignal、`iterationTimeoutMs`（默认 per-task 超时 + 2min）
- [x] **race-with-signal-and-timeout**：单次 runOnce 卡死也不会冻结整个 daemon
- [x] `src/daemon/pidfile.ts`：O_EXCL 排他写（消 TOCTOU），stale pid 自动清
- [x] `src/daemon/units.ts`：systemd + launchd unit 生成
- [x] `idleloop daemon start --foreground` / `stop` / `status` / `unit`
- [x] `daemon unit` 在 stderr 打印**安装指引**（save to / systemctl reload / enable / journalctl）
- [x] `idleloop abort` 用户友好的 stop 别名
- [x] SIGTERM/SIGINT 优雅停机；二次按 Ctrl-C 强制退出
- [x] 22 个测试（loop / pidfile / units / cli）

#### T3 策略

- [x] **audit**：扫 `TODO|FIXME|XXX|HACK` 标记，达到 minFindings 才出 task
- [x] **test-gap**：扫 src/ 缺 tests/ 对应文件的模块
- [x] **book-expand**：扫 chapter README 含 `<!-- TODO: expand -->` marker
- [x] 三者共享 `SHARED_SKIP_DIRS`（合并 node_modules / dist / _references / vendor / venv / coverage 等）
- [x] `defaultCurator(config)` 按 `projects[].strategies[].name` 自动挂载
- [x] 16 + 5 测试

#### 多项目调度 / auto_merge

- [x] `src/curator/scheduler.ts` 加权 round-robin（weight 3:1 → a 出 3 个 b 出 1 个）
- [x] 同权重按 tasks 中首次出现顺序稳定
- [x] Runner.execute 收到 `task.confidence === 'auto_merge'`：verify 通过后自动 merge 回源仓库默认分支
- [x] `TaskResult.autoMerged: boolean` 字段，shift log + review 可见真实状态
- [x] auto-merge 前先 checkout baseBranch + 检查 clean；失败安全降级到「保留 worktree」
- [x] 7 + 1 测试

#### OAuth token refresh

- [x] `src/watcher/refresh.ts`：POST `refresh_token`
- [x] 401 时自动 refresh + retry（`autoRefreshOn401: true` 默认开）
- [x] token 即将过期时主动 refresh
- [x] OAuth 错误响应 redact（只允许 `error` / `error_description`）
- [x] credentials 文件**原子写**（tmp + rename），不会损坏 Claude Code 自己的 token
- [x] 9 测试（refresh.test.ts + watcher.test.ts 新增）

#### 信任 / 安全（PM review 后加）

- [x] **working_dir allowlist**：`runner.require_declared_project_dir: true` 默认开。
      task.working_dir 必须落在 `projects[].dir` 之一，否则跳过该任务。这是
      AGENTS.md §3.2 红线的运行时执行。
- [x] **`runner.max_shift_usd: 5.0`** 单次 shift 累计成本上限，超过则丢弃后续任务
- [x] `idleloop doctor`：config / 目录 / OAuth / claude CLI / projects / worktree base 7 项自检
- [x] `idleloop task template > my-task.md`：可被 `parseTaskMarkdown` 直接解析的范例
- [x] `idleloop init` 写一份 `queue/example.md.template`
- [x] `idleloop add` 校验失败时提示 `idleloop task template > my-task.md`
- [x] `idleloop run` 输出末尾打印 quota 状态，方便看完直接判断剩余余量
- [x] **`idleloop run --dry`** 现在真正预览：印 quota / 决策原因 / curator 候选 / 每个 task 的估算成本，
      而不只是 "SKIP: in quiet hours"

### 工程基线 ✅

- [x] **293 tests 全绿**（`npm test`）
- [x] `npm run typecheck` / `npm run lint` / `npm run build` 均干净
- [x] 38 测试文件，覆盖 cli / curator / shift-log / daemon / runner / watcher / trigger / storage / utils
- [x] AI 协作元信息（CLAUDE.md / AGENTS.md / CONTRIBUTING.md）齐全
- [x] 主分支 / 首个 Phase 0 commit 仍是 `6e99b21`

## 模块清单

```
src/
  cli/
    index.ts                  # commander 入口，注册所有命令
    commands/
      init.ts                 # init + 写 example.md.template
      status.ts               # quota + reset 倒计时
      add.ts                  # 加队列，校验失败提示 task template
      list.ts                 # 队列表格
      run.ts                  # 单次触发 + dry-preview + working_dir 守门 + shift 预算上限
      logs.ts                 # 浏览历史 shift
      review.ts               # 交互 merge/discard/keep + confirmMerge
      daemon.ts               # daemon start/stop/status/unit
      doctor.ts               # 环境自检
      task-template.ts        # 范例 task md 文本
  curator/
    index.ts                  # Curator 编排 + defaultCurator(config) 自动挂 T3
    scheduler.ts              # 加权 round-robin
    task-loader.ts            # md → Task 校验
    strategies/
      bookshelf.ts            # T1
      audit.ts                # T3 audit
      test-gap.ts             # T3 test-gap
      book-expand.ts          # T3 book-expand
      skip-dirs.ts            # 共享 SKIP_DIRS
  daemon/
    index.ts                  # 聚合 re-export
    loop.ts                   # 主循环 + race-with-signal-timeout
    pidfile.ts                # O_EXCL pidfile
    units.ts                  # systemd + launchd 生成
  runner/
    index.ts                  # Runner + auto_merge + autoMerged 字段
    worktree.ts / safety-gate.ts / verify.ts / claude-process.ts
  shift-log/
    index.ts / render.ts / writer.ts / types.ts
  storage/
    config.ts                 # zod schema：含 max_shift_usd / require_declared_project_dir
    paths.ts                  # 路径解析
  trigger/
    index.ts / policy.ts / user-activity.ts / types.ts
  types/
    index.ts / task.ts        # TaskResult 含 baseBranch / autoMerged / confidence
  utils/
    http.ts / logger.ts
  watcher/
    index.ts / oauth-client.ts / refresh.ts / token-source.ts / types.ts
```

## 没做（Phase 3+ 待办）

### 立刻可做的（短期）

1. **真实 claude 联调**：把 `--dry` 去掉跑一次极小任务，验证 claude-process.ts 的 stream-json 解析
2. **`idleloop status` 显示「现在会不会触发」**：把 policy 决策也展示出来
3. **`idleloop logs` 默认隐藏 blocked-only 的 shift**，避免白天 96 次 poll 淹没 shift.md
4. **per-shift cumulative cost 在 shift log 里写出来**（现在只在 CLI summary 打印）
5. **`idleloop config check`**：单独的命令做 zod 校验（不依赖 doctor 的其它检查）

### 中期（Phase 3）

6. T2 长期目标拆解（goals.yml + 子任务生成）
7. T4 AI 自主提案（proposals/ 目录）
8. 周度复盘报告
9. CLI PTY fallback（OAuth 端点失败时解析 claude 输出兜底）
10. `--at <time>` 模拟特定时刻的 dry-preview

### 长期 / 未排期

11. 偏好学习（接受/拒绝历史驱动提案）
12. Per-task signal propagation（让 SIGTERM 真正杀掉 claude 子进程，不只是 daemon loop 自身）

## 已知 gotcha（新会话踩前必读）

1. **OAuth `utilization` 是 0-100（百分比）**，不是 0-1。代码内部 normalize 成 `remainingPct: 100 - utilization`。
2. **Node fetch 不读 `HTTPS_PROXY`**——已用 `src/utils/http.ts` 的 `proxiedFetch` 解决，新模块发起 HTTP 时记得用它而不是裸 `fetch`。
3. **`isInQuietHours` 用本地时间**（`now.getHours()`），不是 UTC。测试要用 `new Date(year, monthIdx, day, hour, ...)` 而不是 `new Date('...Z')`。
4. **git < 2.28 没有 `git init -b`**——开发机就是 2.25。测试 initRepo 要在 commit **之后**做 `git branch -M main`，否则 `branch -M` 失败留在 master。Runner / Review 都用 `handle.baseBranch` 或 `c.result.baseBranch ?? 'main'`，所以建测试 repo 时务必把 baseBranch 传对。
5. **mockResolvedValue(response) 不能复用**——同一个 `Response` 实例 body 只能读一次。多次 snapshot 测试要用 `mockImplementation(() => Promise.resolve(jsonResponse({...})))`。
6. **safety-gate 先 `git add -A`**——`git diff HEAD` 默认看不到 untracked 文件。worktree 是 task 专属，stage 副作用可接受。
7. **logger 默认 level = warn**，info 级别被静默以避免污染 CLI 输出。调试用 `IDLELOOP_LOG_LEVEL=info`。
8. **测试 inject `activity: idleActivity` 和 `shiftLog: false`**：runRun 在 deps 没传 activity 时会扫真实 `~/.claude/projects/`，跑 Claude Code 时永远命中 user_activity。在 deps 没传 shiftLog 时会写真实 `~/.idleloop/logs/`，污染本机。新加 runRun 测试时记得两个都注入。
9. **review 测试调 merge 时要 inject `confirm: async () => true`**，否则会卡住等 stdin。
10. **`idleloop daemon start --foreground` 不真正后台化**。要让它后台跑只能靠 systemd / launchd / `nohup &`。不要尝试在 cli 层做 double-fork。
11. **`idleloop run --dry` 现在 == preview**：bypass 所有 gate，走 curator + working_dir 守门 + dry-run runner，但不写 shift log（除非 `--write-shift-log`）。**与 `--force` 不同**，`--force` 是「忽略 gate 但真的跑」。
12. **per-shift budget cap 默认 $5.0**。修改 config 才能放开。

## 重要文件指针

| 想做的事 | 看这个 |
|---|---|
| 看完整产品定义 | `docs/PRD.md` |
| 看技术架构 / 模块设计 | `docs/TECH_DESIGN.md` |
| 看 sprint 拆分 / 实测的 OAuth schema | `docs/IMPLEMENTATION_PLAN.md` |
| 看本次会话进度（你正在读的） | `docs/STATUS.md` |
| 看 AI 协作规则 | `AGENTS.md` 红线 + `CLAUDE.md` 补充 |
| 任务格式 | `idleloop task template` 或 `tests/fixtures/queue/valid-task.md` |

## 验证命令（新会话开局先跑）

```bash
# 1. 拉依赖（如果是新 worktree）
npm install

# 2. 静态检查
npm run typecheck
npm run lint
npm run build

# 3. 跑测试
npm test                   # 293 tests，预期全绿

# 4. 真实环境烟测（需要 ~/.claude/.credentials.json 存在）
TEST_HOME=$(mktemp -d)
mkdir -p "$TEST_HOME/.claude" && cp ~/.claude/.credentials.json "$TEST_HOME/.claude/.credentials.json"
HOME="$TEST_HOME" node dist/index.js init --skip-verify
HOME="$TEST_HOME" node dist/index.js doctor --skip-network
HOME="$TEST_HOME" node dist/index.js task template > /tmp/task.md
HOME="$TEST_HOME" node dist/index.js add /tmp/task.md
HOME="$TEST_HOME" node dist/index.js run --dry
rm -rf "$TEST_HOME"
```

## 下一步建议（写给下个会话的我）

1. **真实 claude 端到端跑一次**：找一个 fixture repo + 极小 task（如「在 README 末尾追加一行」），把 `--dry` 去掉，看 stream-json 解析 / `--max-budget-usd` / verify 是否真的端到端通。

2. **`idleloop status` 加上「会不会触发」**：现在 status 只给数字。加一条 `→ would trigger now: yes (5h policy)` 或 `→ would not trigger (gate=quiet_hours)`。
   这是把 `--dry` 的 trigger 信息搬到 status 输出里，让用户在 idle session 之外也能预判。

3. **logs 默认隐藏纯 blocked 的 shift**：白天 96 次 poll 写 96 条 blocked 行，shift.md 不可读。
   方案：blocked shift 只写 state.json，不进 shift.md；`logs --include-blocked` 才看完整。

4. **改进 shift log 列表里同日多个 shift 的「上次跑了啥」展示**：现在 `idleloop logs` 默认列今天所有 shifts。当 96 个 blocked + 2 个真跑过的时，那 2 个被淹没。考虑按 `triggered=true` 先排。

不建议先做 T2/T4 —— 它们依赖 shift log 数据沉淀几天后才能验证反馈循环。
