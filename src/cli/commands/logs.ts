import { readFile } from 'node:fs/promises';
import { styleText } from 'node:util';
import {
  listShiftDates,
  loadLatestShiftState,
  loadShiftsForDate,
  type ShiftState,
} from '../../shift-log/index.js';
import { paths, todayDateString } from '../../storage/paths.js';

export interface RunLogsOptions {
  /** 看具体某天，未提供则取最近一天 */
  date?: string;
  /** 直接打印 shift.md 全文，不解析 */
  raw?: boolean;
  /** 列出所有有 log 的日期，不进入详情 */
  list?: boolean;
  /** 显示最近 N 天的概览（默认 7） */
  recent?: number;
  /** machine-readable */
  json?: boolean;
  /** 默认折叠 blocked-only 的 shift；传 true 全部展开 */
  includeBlocked?: boolean;
}

export interface RunLogsDeps {
  logsRoot?: string;
  /** 注入 console.log，便于测试静默 */
  print?: (line: string) => void;
}

export interface RunLogsResult {
  /** 指定日期的 shift 列表（按 startedAt 升序）；list mode 下为空 */
  shifts: ShiftState[];
  /** 所有可用日期（list mode + 概览） */
  availableDates: string[];
  /** 此次 print 的日期 */
  date?: string;
  /** 原始 markdown，仅 raw 模式 */
  rawMd?: string;
}

/**
 * `idleloop logs [--date YYYY-MM-DD] [--raw] [--list] [--recent N] [--json]`
 *
 * 默认：打印最近一天的所有 shift 概览。
 * --raw：直接 cat shift.md。
 * --list：列出所有日期 + 每天 shift 数 + 总成本。
 */
export async function runLogs(
  opts: RunLogsOptions = {},
  deps: RunLogsDeps = {},
): Promise<RunLogsResult> {
  const print = deps.print ?? ((s: string) => console.log(s));
  const logsRoot = deps.logsRoot ?? paths.logsDir();
  const availableDates = await listShiftDates({ logsRoot });

  if (opts.list) {
    const overviews = await summarizeDates(
      availableDates.slice(0, opts.recent ?? availableDates.length),
      logsRoot,
    );
    if (opts.json) {
      print(JSON.stringify({ dates: overviews }, null, 2));
    } else {
      printList(overviews, print);
    }
    return { shifts: [], availableDates };
  }

  const date = opts.date ?? availableDates[0];
  if (!date) {
    print(styleText('yellow', "no shift logs yet — idleloop hasn't run any shift."));
    return { shifts: [], availableDates };
  }

  if (opts.raw) {
    const shiftMd = `${logsRoot}/${date}/shift.md`;
    let raw: string;
    try {
      raw = await readFile(shiftMd, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        print(styleText('yellow', `no shift.md for ${date} at ${shiftMd}`));
        return { shifts: [], availableDates, date };
      }
      throw err;
    }
    print(raw);
    return { shifts: [], availableDates, date, rawMd: raw };
  }

  const shifts = await loadShiftsForDate(date, { logsRoot });
  if (shifts.length === 0) {
    // 兜底：尝试 state.json（可能 shifts/ 没有但 state.json 有）
    const latest = await loadLatestShiftState(date, { logsRoot });
    if (latest) {
      if (opts.json) {
        print(JSON.stringify({ date, shifts: [latest] }, null, 2));
      } else {
        printShifts(date, [latest], print, { includeBlocked: opts.includeBlocked === true });
      }
      return { shifts: [latest], availableDates, date };
    }
    print(styleText('yellow', `no shift log for ${date}`));
    return { shifts: [], availableDates, date };
  }
  if (opts.json) {
    print(JSON.stringify({ date, shifts }, null, 2));
  } else {
    printShifts(date, shifts, print, { includeBlocked: opts.includeBlocked === true });
  }
  return { shifts, availableDates, date };
}

interface DateOverview {
  date: string;
  shifts: number;
  successTasks: number;
  totalCostUsd: number;
  totalTokens: number;
  blockedOnly: boolean;
}

async function summarizeDates(dates: string[], logsRoot: string): Promise<DateOverview[]> {
  const out: DateOverview[] = [];
  for (const date of dates) {
    const shifts = await loadShiftsForDate(date, { logsRoot });
    let totalCost = 0;
    let totalTokens = 0;
    let successTasks = 0;
    let triggeredCount = 0;
    for (const s of shifts) {
      totalCost += s.totalCostUsd;
      totalTokens += s.totalTokens;
      successTasks += s.results.filter((r) => r.status === 'success').length;
      if (s.decision.triggered) triggeredCount++;
    }
    out.push({
      date,
      shifts: shifts.length,
      successTasks,
      totalCostUsd: totalCost,
      totalTokens,
      blockedOnly: shifts.length > 0 && triggeredCount === 0,
    });
  }
  return out;
}

function printList(rows: DateOverview[], print: (s: string) => void): void {
  if (rows.length === 0) {
    print(styleText('yellow', 'no shift logs yet.'));
    return;
  }
  const todayStr = todayDateString(new Date());
  print(styleText('bold', 'date         shifts  ok-tasks  cost      tokens'));
  for (const r of rows) {
    const tag = r.date === todayStr ? styleText('green', ' (today)') : '';
    const blockedNote = r.blockedOnly ? styleText('dim', '  [all blocked]') : '';
    print(
      `${r.date.padEnd(11)}  ${String(r.shifts).padEnd(6)}  ${String(r.successTasks).padEnd(8)}  $${r.totalCostUsd.toFixed(4).padEnd(7)}  ${String(r.totalTokens).padEnd(8)}${tag}${blockedNote}`,
    );
  }
}

function printShifts(
  date: string,
  shifts: ShiftState[],
  print: (s: string) => void,
  opts: { includeBlocked: boolean } = { includeBlocked: false },
): void {
  const triggered = shifts.filter((s) => s.decision.triggered);
  const blocked = shifts.filter((s) => !s.decision.triggered);

  // 顶部 roll-up：一眼看清今天/这一天的核心数字
  let okTasks = 0;
  let failTasks = 0;
  let totalCost = 0;
  let totalTokens = 0;
  for (const s of shifts) {
    totalCost += s.totalCostUsd;
    totalTokens += s.totalTokens;
    for (const r of s.results) {
      if (r.status === 'success') okTasks++;
      else if (r.status !== 'dry_run') failTasks++;
    }
  }
  print(
    styleText(
      'bold',
      `Shifts on ${date}  ·  ${shifts.length} total / ${triggered.length} triggered / ${blocked.length} blocked  ·  ${okTasks} ok-tasks${failTasks > 0 ? ` / ${failTasks} failed` : ''}  ·  $${totalCost.toFixed(4)}  ·  ${totalTokens} tokens`,
    ),
  );

  // 默认隐藏 blocked-only shift（白天 96 次 poll 不污染输出）。
  // 没有 triggered shift 时退化为全展开，避免空表。
  const showBlocked = opts.includeBlocked || triggered.length === 0;
  const shownShifts = showBlocked ? shifts : triggered;

  for (const s of shownShifts) {
    const triggerTag = s.decision.triggered
      ? styleText('green', '✓ TRIGGER')
      : styleText('yellow', `✗ SKIP[${s.decision.blockedBy ?? 'n/a'}]`);
    print('');
    print(`  ${triggerTag}  ${s.shiftId}  ${shiftClock(s.startedAt, s.finishedAt)}`);
    print(styleText('dim', `    reason: ${s.decision.reason}`));
    if (s.results.length > 0 || s.decision.triggered) {
      print(
        styleText(
          'dim',
          `    tasks: ${s.results.length}  cost: $${s.totalCostUsd.toFixed(4)}  tokens: ${s.totalTokens}`,
        ),
      );
    }
    for (const r of s.results) {
      const color =
        r.status === 'success'
          ? styleText('green', '✓')
          : r.status === 'verify_failed' ||
              r.status === 'aborted_oversized' ||
              r.status === 'aborted_budget' ||
              r.status === 'aborted_forbidden_path' ||
              r.status === 'aborted_secret_leak'
            ? styleText('yellow', '!')
            : r.status === 'error'
              ? styleText('red', '✗')
              : styleText('cyan', '·');
      print(`      ${color} [${r.status}] ${r.taskId}  (${r.diffLinesChanged}L diff)`);
    }
  }

  if (!showBlocked && blocked.length > 0) {
    print('');
    print(
      styleText(
        'dim',
        `  · ${blocked.length} blocked shift(s) hidden — pass --include-blocked to see them`,
      ),
    );
  }
}

function shiftClock(startedAt: string, finishedAt: string): string {
  const s = new Date(startedAt);
  const f = new Date(finishedAt);
  const sh = String(s.getHours()).padStart(2, '0');
  const sm = String(s.getMinutes()).padStart(2, '0');
  const fh = String(f.getHours()).padStart(2, '0');
  const fm = String(f.getMinutes()).padStart(2, '0');
  return `${sh}:${sm}–${fh}:${fm}`;
}
