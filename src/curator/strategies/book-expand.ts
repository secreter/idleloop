import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { expandHome } from '../../storage/paths.js';
import type { Task } from '../../types/task.js';
import { logger as rootLogger } from '../../utils/logger.js';
import type { CuratorStrategy } from '../types.js';
import { SHARED_SKIP_DIRS } from './skip-dirs.js';

const log = rootLogger.child({ mod: 'curator', strategy: 'book-expand' });

export interface BookExpandProjectInput {
  id: string;
  dir: string;
  /** chapter README 的相对 glob 起点，默认从 dir 递归找 README.md */
  chapterGlobRoot?: string;
  /** 标记 token，含此 token 的 README 视作「待扩写」 */
  marker?: string;
  /** 最少几章命中才生成 task */
  minHits?: number;
  /** 最多列出几章 */
  maxHits?: number;
  confidence?: Task['confidence'];
  readDirFn?: typeof readdir;
  readFileFn?: typeof readFile;
}

export interface BookExpandOptions {
  projects: BookExpandProjectInput[];
}

const SKIP_DIRS = SHARED_SKIP_DIRS;

const DEFAULT_MARKER = '<!-- TODO: expand -->';

/**
 * T3 book-expand 策略：扫书稿 chapter README 找待扩写标记。
 *
 * 命中文件示例（marker 默认 `<!-- TODO: expand -->`）：
 *   chapters/ch01-foo/README.md   包含  <!-- TODO: expand --> 这一行
 *
 * 生成的任务：让 Claude 把对应章节扩写成完整内容，遵守工作空间 CLAUDE.md 风格。
 */
export class BookExpandStrategy implements CuratorStrategy {
  readonly name = 'book-expand';
  readonly source = 'T3' as const;

  constructor(private readonly opts: BookExpandOptions) {}

  async discover(): Promise<Task[]> {
    const out: Task[] = [];
    for (const project of this.opts.projects) {
      try {
        const t = await this.scanProject(project);
        if (t) out.push(t);
      } catch (err) {
        log.warn({ project: project.id, err: (err as Error).message }, 'book-expand scan failed');
      }
    }
    return out;
  }

  private async scanProject(project: BookExpandProjectInput): Promise<Task | null> {
    const root = expandHome(project.dir);
    const globRoot = project.chapterGlobRoot ? path.join(root, project.chapterGlobRoot) : root;
    const marker = project.marker ?? DEFAULT_MARKER;
    const reader = project.readFileFn ?? readFile;
    const dirReader = project.readDirFn ?? readdir;

    const readmes = await collectReadmes(globRoot, dirReader);
    const hits: Array<{ path: string; firstHitLine: number; total: number }> = [];
    for (const file of readmes) {
      let content: string;
      try {
        content = await reader(file, 'utf-8');
      } catch {
        continue;
      }
      if (!content.includes(marker)) continue;
      const lines = content.split('\n');
      let firstHit = -1;
      let total = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(marker)) {
          if (firstHit < 0) firstHit = i + 1;
          total++;
        }
      }
      hits.push({ path: path.relative(root, file), firstHitLine: firstHit, total });
    }

    const minHits = project.minHits ?? 1;
    if (hits.length < minHits) {
      log.debug({ project: project.id, hits: hits.length }, 'book-expand: below threshold');
      return null;
    }
    const cap = project.maxHits ?? 5;
    const picked = hits.slice(0, cap);
    const prompt = buildPrompt(project, picked, marker);
    const taskId = `task-book-expand-${project.id}-${ulid().slice(-8).toLowerCase()}`;
    return {
      id: taskId,
      source: 'T3',
      project: project.id,
      title: `book-expand: 扩写 ${picked.length} 章 in ${project.id}`,
      prompt,
      working_dir: root,
      cost_estimate_tokens: 10_000 + 4_000 * picked.length,
      acceptance: '挑 1-2 章扩写到位（包含原理 + 实例代码 + 总结），其余章节维持现状，禁止"水"段落',
      verify_command: 'true',
      confidence: project.confidence ?? 'review_queue',
      budget_usd: 1.2,
      safety: { max_diff_lines: 2000, forbidden_paths: ['.env', 'secrets/'] },
    };
  }
}

async function collectReadmes(root: string, reader: typeof readdir): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5) return;
    let entries;
    try {
      entries = await reader(dir, { withFileTypes: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'ENOTDIR') return;
      throw err;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile() && /^README\.md$/i.test(ent.name)) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out;
}

function buildPrompt(
  project: BookExpandProjectInput,
  picks: Array<{ path: string; firstHitLine: number; total: number }>,
  marker: string,
): string {
  return [
    `书稿仓库 ${project.id} 里仍有 ${picks.length} 章包含「待扩写」标记 (\`${marker}\`)。`,
    '',
    '任务：',
    '1. 阅读父目录 CLAUDE.md（或 AGENTS.md）里的写作风格规范，再阅读相邻已成稿章节的语气。',
    '2. 在下面列表中挑 1-2 章扩写到位，删除对应位置的 marker。',
    `3. 写作要点：开头钩子、原理解释、可运行代码示例（如有 examples/ 目录就跑通）、收束总结。`,
    '4. 禁止 AI 套话（"让我们一起"、"显而易见"、"值得注意的是"），禁止 emoji。',
    '5. 不动其它章节，不动 CLAUDE.md / AGENTS.md。',
    '',
    'Hits:',
    picks
      .map(
        (h) =>
          `- ${h.path}  (line ${h.firstHitLine}${h.total > 1 ? `, ${h.total} occurrences` : ''})`,
      )
      .join('\n'),
  ].join('\n');
}
