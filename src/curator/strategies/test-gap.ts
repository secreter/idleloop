import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { expandHome } from '../../storage/paths.js';
import type { Task } from '../../types/task.js';
import { logger as rootLogger } from '../../utils/logger.js';
import type { CuratorStrategy } from '../types.js';
import { SHARED_SKIP_DIRS } from './skip-dirs.js';

const log = rootLogger.child({ mod: 'curator', strategy: 'test-gap' });

export interface TestGapProjectInput {
  id: string;
  dir: string;
  /** 源代码目录（默认 src/） */
  srcDir?: string;
  /** 测试目录候选；命中即视为已有测试覆盖（默认 tests/ 和 src/同名 *.test.ts） */
  testDirs?: string[];
  /** 源文件扩展名 */
  extensions?: string[];
  /** 最大候选模块数（生成的 task 提示中列出来的，不是真的修复数） */
  maxModules?: number;
  /** 一个项目至少缺多少模块的测试，才值得跑这个 task */
  minMissing?: number;
  confidence?: Task['confidence'];
  /** Glob 排除的文件名（默认排除 *.d.ts / index.ts / types.ts） */
  excludeBasenames?: RegExp[];
}

export interface TestGapOptions {
  projects: TestGapProjectInput[];
  readDirFn?: typeof readdir;
}

const SKIP_DIRS = SHARED_SKIP_DIRS;

/**
 * T3 test-gap 策略：扫源代码目录里没有对应测试文件的模块。
 *
 * 命中规则（默认 TypeScript 项目）：
 *   - src/foo.ts 没有 tests/foo.test.ts 也没有 src/foo.test.ts
 *   - 排除 *.d.ts、index.ts、types.ts、*.test.ts 自己
 */
export class TestGapStrategy implements CuratorStrategy {
  readonly name = 'test-gap';
  readonly source = 'T3' as const;

  constructor(private readonly opts: TestGapOptions) {}

  async discover(): Promise<Task[]> {
    const tasks: Task[] = [];
    for (const project of this.opts.projects) {
      try {
        const task = await this.scanProject(project);
        if (task) tasks.push(task);
      } catch (err) {
        log.warn({ project: project.id, err: (err as Error).message }, 'test-gap scan failed');
      }
    }
    return tasks;
  }

  private async scanProject(project: TestGapProjectInput): Promise<Task | null> {
    const exts = project.extensions ?? ['.ts', '.tsx', '.js'];
    const root = expandHome(project.dir);
    const srcDir = path.join(root, project.srcDir ?? 'src');
    const testDirs = (project.testDirs ?? ['tests', 'test', '__tests__']).map((t) =>
      path.join(root, t),
    );
    const excludes: RegExp[] = project.excludeBasenames ?? [
      /\.d\.ts$/,
      /\.test\./,
      /\.spec\./,
      /^index\./,
      /^types\./,
    ];

    const srcFiles = await this.collectFiles(srcDir, exts, excludes);
    if (srcFiles.length === 0) return null;
    const testFiles = new Set<string>();
    for (const tdir of testDirs) {
      const found = await this.collectFiles(tdir, exts, []);
      for (const f of found) {
        testFiles.add(path.basename(f).replace(/\.(test|spec)\./, '.'));
      }
    }
    // 同目录平铺 test 文件（src/foo.test.ts 同样视作覆盖）
    for (const f of srcFiles) {
      const base = path.basename(f);
      if (/\.(test|spec)\./.test(base)) {
        testFiles.add(base.replace(/\.(test|spec)\./, '.'));
      }
    }

    const missing: string[] = [];
    for (const file of srcFiles) {
      const base = path.basename(file);
      if (excludes.some((re) => re.test(base))) continue;
      if (testFiles.has(base)) continue;
      missing.push(path.relative(root, file));
    }

    const minMissing = project.minMissing ?? 3;
    if (missing.length < minMissing) {
      log.debug(
        { project: project.id, missing: missing.length, minMissing },
        'test-gap: below threshold',
      );
      return null;
    }

    const cap = project.maxModules ?? 20;
    const list = missing.slice(0, cap);
    const prompt = buildPrompt(project, list, missing.length);
    const taskId = `task-test-gap-${project.id}-${ulid().slice(-8).toLowerCase()}`;
    return {
      id: taskId,
      source: 'T3',
      project: project.id,
      title: `test-gap: cover ${list.length} untested modules in ${project.id}`,
      prompt,
      working_dir: root,
      cost_estimate_tokens: 8_000 + 1_500 * list.length,
      acceptance:
        'add unit tests for at least one of the listed modules; existing tests stay green',
      verify_command: 'npm test',
      confidence: project.confidence ?? 'review_queue',
      budget_usd: 1.0,
      safety: { max_diff_lines: 1000, forbidden_paths: ['.env', 'secrets/'] },
    };
  }

  private async collectFiles(dir: string, exts: string[], excludes: RegExp[]): Promise<string[]> {
    const reader = this.opts.readDirFn ?? readdir;
    const out: string[] = [];
    async function walk(current: string, depth: number): Promise<void> {
      if (depth > 8) return;
      let entries: Dirent[];
      try {
        entries = (await reader(current, { withFileTypes: true })) as unknown as Dirent[];
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'ENOTDIR') return;
        throw err;
      }
      for (const ent of entries) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (ent.name.startsWith('.')) continue;
        const full = path.join(current, ent.name);
        if (ent.isDirectory()) {
          await walk(full, depth + 1);
        } else if (ent.isFile()) {
          const e = path.extname(ent.name).toLowerCase();
          if (!exts.includes(e)) continue;
          if (excludes.some((re) => re.test(ent.name))) continue;
          out.push(full);
        }
      }
    }
    await walk(dir, 0);
    return out;
  }
}

function buildPrompt(project: TestGapProjectInput, list: string[], total: number): string {
  return [
    `项目 ${project.id} 有 ${total} 个源文件没有对应测试。下面挑了 ${list.length} 个待覆盖。`,
    '',
    '任务：',
    `1. 阅读列表上每个文件，挑出 1-3 个最值得加测试的（核心逻辑、纯函数、最少 mock 成本）。`,
    '2. 为这些文件添加 vitest 单元测试，放到 tests/ 下对应路径。',
    '3. 不要为接口/类型定义、index re-export 文件加测试。',
    '4. 跑 `npm test` 必须通过；失败就不要提交。',
    '',
    '硬性约束：',
    '- 单次最多改 1000 行 diff。',
    '- 测试用 vitest 风格 (`describe / it / expect`)，不引入新依赖。',
    '- 不修改源文件本身的 public API（如果发现 API 不可测，标记 TODO 但不要重构）。',
    '',
    'Candidate files:',
    list.map((f) => `- ${f}`).join('\n'),
  ].join('\n');
}
