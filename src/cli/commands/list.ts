import { BookshelfStrategy } from '../../curator/strategies/bookshelf.js';
import type { Task } from '../../types/task.js';

export interface ListResult {
  tasks: Task[];
}

export interface RunListOptions {
  queueDir?: string;
}

export async function runList(opts: RunListOptions = {}): Promise<ListResult> {
  const strategy = new BookshelfStrategy(opts.queueDir != null ? { queueDir: opts.queueDir } : {});
  const tasks = await strategy.discover();
  return { tasks };
}

export function formatListTable(tasks: Task[]): string {
  if (tasks.length === 0) {
    return '(no tasks in queue)';
  }
  const rows: Array<[string, string, string, string, string, string]> = tasks.map((t) => [
    t.id.length > 18 ? t.id.slice(-18) : t.id,
    t.source,
    t.project,
    t.title.length > 32 ? t.title.slice(0, 29) + '...' : t.title,
    String(t.cost_estimate_tokens),
    t.confidence,
  ]);
  const header: (typeof rows)[number] = ['ID', 'SRC', 'PROJECT', 'TITLE', 'EST.TOK', 'CONFIDENCE'];
  const all = [header, ...rows];
  const widths = [0, 0, 0, 0, 0, 0].map((_, col) =>
    all.reduce((m, r) => Math.max(m, r[col]!.length), 0),
  );
  const fmtRow = (r: (typeof rows)[number]): string =>
    r.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  return [
    fmtRow(header),
    '-'.repeat(widths.reduce((a, b) => a + b, 0) + 10),
    ...rows.map(fmtRow),
  ].join('\n');
}
