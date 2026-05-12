---
id: task-fixture-001
source: T1
project: llm-infra-book
title: Expand ch04 RAG basics
working_dir: /tmp/fixture-project
cost_estimate_tokens: 40000
acceptance: produce chapters/04-rag/README.draft.md with >= 2000 words
verify_command: "echo verify-ok"
confidence: review_queue
budget_usd: 0.5
safety:
  max_diff_lines: 800
  forbidden_paths:
    - .env
    - secrets/
    - package-lock.json
---

## Prompt

Read chapters/04-rag/README.md outline, expand sections 2 and 3 into full prose.
Reference chapters/01-llm-basics/README.md for style.
Output to chapters/04-rag/README.draft.md without modifying the original.
