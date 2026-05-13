import type { Task } from '../types/task.js';
import { logger as rootLogger } from '../utils/logger.js';
import type { Config, ProjectConfig } from '../storage/config.js';
import { selectByWeight } from './scheduler.js';
import { AuditStrategy, type AuditProjectInput } from './strategies/audit.js';
import { BookExpandStrategy, type BookExpandProjectInput } from './strategies/book-expand.js';
import { BookshelfStrategy } from './strategies/bookshelf.js';
import { TestGapStrategy, type TestGapProjectInput } from './strategies/test-gap.js';
import type { CuratorReport, CuratorStrategy } from './types.js';

const log = rootLogger.child({ mod: 'curator' });

export interface CuratorOptions {
  strategies: CuratorStrategy[];
  /** 多项目调度：按 weight round-robin，可选 */
  projects?: ProjectConfig[];
  /** 单次 gather 最多返回几个任务（防一次 idle session 拿过多） */
  maxTasks?: number;
}

/**
 * 任务调度器。组合多个 strategy，输出去重后的任务列表。
 *
 * 任意 strategy 失败不阻塞其他，只在报告里标错。
 * 去重规则：按 task.id 去重；同 id 的任务取第一次出现的版本。
 */
export class Curator {
  constructor(private readonly opts: CuratorOptions) {}

  async gather(): Promise<CuratorReport> {
    const seen = new Set<string>();
    const tasks: Task[] = [];
    const perStrategy: CuratorReport['perStrategy'] = [];

    for (const strategy of this.opts.strategies) {
      let discovered: Task[] = [];
      let errMsg: string | undefined;
      try {
        discovered = await strategy.discover();
      } catch (err) {
        errMsg = (err as Error).message;
        log.warn({ strategy: strategy.name, err: errMsg }, 'strategy discover failed');
      }

      let skipped = 0;
      for (const t of discovered) {
        if (seen.has(t.id)) {
          skipped++;
          continue;
        }
        seen.add(t.id);
        tasks.push(t);
      }
      perStrategy.push({
        name: strategy.name,
        source: strategy.source,
        discovered: discovered.length,
        skipped,
        ...(errMsg !== undefined ? { error: errMsg } : {}),
      });
    }

    // 多项目加权调度（如果 config 提供了 projects）
    const ordered =
      this.opts.projects && this.opts.projects.length > 0
        ? selectByWeight(tasks, {
            projects: this.opts.projects,
            ...(this.opts.maxTasks !== undefined ? { maxTasks: this.opts.maxTasks } : {}),
          })
        : this.opts.maxTasks !== undefined
          ? tasks.slice(0, this.opts.maxTasks)
          : tasks;

    return { tasks: ordered, perStrategy };
  }
}

/**
 * 用 config + 默认 strategy 组装 Curator。
 *
 * - 总是启用 T1 bookshelf（扫 ~/idleloop/queue/）
 * - 对每个 project 配置里出现的 strategy.name in {audit, test-gap, book-expand}，
 *   各起一个 strategy 实例（合并所有 projects 到一个 strategy，跑一次性扫描）
 */
export function defaultCurator(config?: Config): Curator {
  const strategies: CuratorStrategy[] = [new BookshelfStrategy()];

  if (config?.projects?.length) {
    const audit = collectStrategyProjects<AuditProjectInput>(config.projects, 'audit');
    if (audit.length > 0) strategies.push(new AuditStrategy({ projects: audit }));

    const testGap = collectStrategyProjects<TestGapProjectInput>(config.projects, 'test-gap');
    if (testGap.length > 0) strategies.push(new TestGapStrategy({ projects: testGap }));

    const book = collectStrategyProjects<BookExpandProjectInput>(config.projects, 'book-expand');
    if (book.length > 0) strategies.push(new BookExpandStrategy({ projects: book }));
  }
  return new Curator({
    strategies,
    ...(config?.projects ? { projects: config.projects } : {}),
  });
}

function collectStrategyProjects<T extends { id: string; dir: string; confidence?: string }>(
  projects: ProjectConfig[],
  name: string,
): T[] {
  const out: T[] = [];
  for (const p of projects) {
    const matched = p.strategies.find((s) => s.name === name);
    if (!matched) continue;
    out.push({
      id: p.id,
      dir: p.dir,
      confidence: matched.confidence,
      ...(matched.config ?? {}),
    } as unknown as T);
  }
  return out;
}

export { BookshelfStrategy } from './strategies/bookshelf.js';
export { AuditStrategy } from './strategies/audit.js';
export { TestGapStrategy } from './strategies/test-gap.js';
export { BookExpandStrategy } from './strategies/book-expand.js';
export { loadTaskFromFile, parseTaskMarkdown, TaskParseError } from './task-loader.js';
export type { CuratorReport, CuratorStrategy } from './types.js';
