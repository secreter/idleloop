import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { styleText } from 'node:util';
import { BookshelfStrategy } from '../../curator/strategies/bookshelf.js';
import { paths } from '../../storage/paths.js';
import type { Task } from '../../types/task.js';

export interface ListResult {
  tasks: Task[];
  /** 队列目录下没被 BookshelfStrategy 识别的 *.template / 非 md 文件，用作提示 */
  templates: string[];
  queueDir: string;
}

export interface RunListOptions {
  queueDir?: string;
}

export async function runList(opts: RunListOptions = {}): Promise<ListResult> {
  const queueDir = opts.queueDir ?? paths.queueDir();
  const strategy = new BookshelfStrategy({ queueDir });
  const tasks = await strategy.discover();

  let templates: string[] = [];
  if (tasks.length === 0) {
    templates = await listTemplates(queueDir);
  }
  return { tasks, templates, queueDir };
}

async function listTemplates(queueDir: string): Promise<string[]> {
  try {
    const entries = await readdir(queueDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.(template|example)$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function formatListTable(result: ListResult | Task[]): string {
  const isArr = Array.isArray(result);
  const tasks = isArr ? result : result.tasks;
  const templates = isArr ? [] : result.templates;
  const queueDir = isArr ? paths.queueDir() : result.queueDir;

  if (tasks.length === 0) {
    if (templates.length > 0) {
      const lines: string[] = ['(no tasks in queue)'];
      lines.push('');
      lines.push(`${templates.length} template file(s) waiting in ${queueDir}:`);
      for (const t of templates) {
        const target = t.replace(/\.(template|example)$/i, '');
        lines.push(`  · ${t}`);
        lines.push(
          styleText(
            'dim',
            `      → mv "${path.join(queueDir, t)}" "${path.join(queueDir, target)}" to enqueue`,
          ),
        );
      }
      lines.push('');
      lines.push(
        styleText('dim', 'Or print a fresh template: `idleloop task template > my-task.md`'),
      );
      return lines.join('\n');
    }
    // 旧契约：Task[] 入参（含测试）就只返回单行；ListResult 入参才追加 onboarding hint
    if (isArr) return '(no tasks in queue)';
    return [
      '(no tasks in queue)',
      '',
      styleText('dim', 'Get started:'),
      styleText('dim', '  idleloop task template > my-task.md'),
      styleText('dim', '  idleloop add my-task.md'),
    ].join('\n');
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
