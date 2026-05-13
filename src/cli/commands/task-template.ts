/**
 * 任务 markdown 模板：`idleloop task template` 输出 + init 时也写到 queue/example.md.template
 *
 * 注意：保留 `# 重命名` 注释顺序，让用户第一眼看到 rename 指令。
 */
export const EXAMPLE_TASK_MD = `---
# 任务唯一 id；不写会自动用 ulid 生成
id: task-example-001

# 任务来源类型：T1=手写书架, T2=长期目标拆解, T3=策略嗅探, T4=AI 自荐
source: T1

# 项目 id；建议和 config.yml 的 projects[].id 一致
project: example

# 任务标题，会出现在 shift log、idleloop list 等地方
title: 示例任务（请修改）

# 工作目录：必须是 config.yml 里 projects[].dir 之一
# require_declared_project_dir: true 时这是硬性约束
working_dir: ~/path/to/your/repo

# 估算 token，给 curator 做容量规划用；不必精确
cost_estimate_tokens: 5000

# 验收标准：自然语言描述「成功」是什么样
acceptance: "示例：在 README 末尾追加一个 'Status' 段落，列出当前已实现的功能"

# verify 命令：runner 在 worktree 跑这个；非 0 即 verify_failed
# 不需要 verify 的写 'true'；想自定义可以写 'npm test' / 'cargo test' 等
verify_command: "true"

# 置信度等级：
#   auto_merge   = 极低风险，verify 通过后自动合入源仓库（如改 docs 错别字）
#   review_queue = 默认值，等用户 idleloop review 手动决策
#   draft_only   = 永远不允许 merge，只生成草稿
confidence: review_queue

# 单任务硬性美元上限；超过会被 claude CLI 自身的 --max-budget-usd 阻断
budget_usd: 0.5

# 安全门控：diff 行数 + 禁止修改的路径
safety:
  max_diff_lines: 300
  forbidden_paths: [".env", "secrets/", ".github/workflows/"]
---

# 任务说明（这一段会作为 prompt 喂给 Claude）

请阅读 README.md，在文件末尾追加一段 Markdown：

\`\`\`markdown
## Status

- 已实现：xxx, yyy
- 进行中：zzz
\`\`\`

字段内容根据当前仓库的实际功能填写。不修改其它内容。

---

# 使用说明

1. 把这份文件重命名（去掉 .template）：
   mv ~/idleloop/queue/example.md.template ~/idleloop/queue/example.md

2. 改 frontmatter 里的 working_dir 指向你的真实项目。

3. \`idleloop run --dry\` 预演一次，看看 curator 会不会发现这个任务。

4. \`idleloop daemon unit > ~/.config/systemd/user/idleloop.service\` 装守护进程。
`;
