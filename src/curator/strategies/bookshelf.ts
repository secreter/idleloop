import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../../storage/paths.js';
import type { Task } from '../../types/task.js';
import { logger as rootLogger } from '../../utils/logger.js';
import { loadTaskFromFile, TaskParseError } from '../task-loader.js';
import type { CuratorStrategy } from '../types.js';

const log = rootLogger.child({ mod: 'curator', strategy: 'bookshelf' });

export interface BookshelfOptions {
  /** 队列目录，默认 paths.queueDir() */
  queueDir?: string;
}

/**
 * T1: 用户书架策略。
 *
 * 扫描 ~/idleloop/queue/*.md，每个文件视作一个 Task。解析失败的文件被跳过并记录 warning。
 * 输出按文件名字典序排序，确保多次 discover() 顺序稳定。
 */
export class BookshelfStrategy implements CuratorStrategy {
  readonly name = 'bookshelf';
  readonly source = 'T1' as const;

  constructor(private readonly opts: BookshelfOptions = {}) {}

  async discover(): Promise<Task[]> {
    const dir = this.opts.queueDir ?? paths.queueDir();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        log.debug({ dir }, 'queue dir does not exist; returning no tasks');
        return [];
      }
      throw err;
    }

    const mdFiles = entries
      .filter((e) => e.isFile() && /\.md$/i.test(e.name))
      .map((e) => e.name)
      .sort();

    const tasks: Task[] = [];
    for (const name of mdFiles) {
      const filePath = path.join(dir, name);
      try {
        const task = await loadTaskFromFile(filePath);
        // 防伪：用户书架来源的任务，source 字段强制为 T1。
        // 否则一个写在 queue/ 下的 md 可以伪造 source=T3，骗过将来的 trust 决策。
        if (task.source !== 'T1') {
          log.warn(
            { filePath, declaredSource: task.source },
            'bookshelf task declared non-T1 source; forcing T1',
          );
          task.source = 'T1';
        }
        tasks.push(task);
      } catch (err) {
        if (err instanceof TaskParseError) {
          log.warn({ filePath, err: err.message }, 'skipping malformed task file');
          continue;
        }
        throw err;
      }
    }
    return tasks;
  }
}
