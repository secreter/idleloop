import type { Task } from '../types/task.js';
import { logger as rootLogger } from '../utils/logger.js';
import { BookshelfStrategy } from './strategies/bookshelf.js';
import type { CuratorReport, CuratorStrategy } from './types.js';

const log = rootLogger.child({ mod: 'curator' });

export interface CuratorOptions {
  strategies: CuratorStrategy[];
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

    return { tasks, perStrategy };
  }
}

/**
 * 用 config + 默认 strategy 组装 Curator。
 * Phase 1 只启用 bookshelf；后续 sprint 加入 audit/test/book-expand。
 */
export function defaultCurator(): Curator {
  return new Curator({
    strategies: [new BookshelfStrategy()],
  });
}

export { BookshelfStrategy } from './strategies/bookshelf.js';
export { loadTaskFromFile, parseTaskMarkdown, TaskParseError } from './task-loader.js';
export type { CuratorReport, CuratorStrategy } from './types.js';
