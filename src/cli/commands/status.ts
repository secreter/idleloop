import { styleText } from 'node:util';
import { Watcher, formatDuration } from '../../watcher/index.js';
import type { QuotaSnapshot, QuotaWindow } from '../../watcher/types.js';

export interface StatusOptions {
  json?: boolean;
  /** 测试注入：跳过 history 写入 + 替换 fetch */
  watcher?: Watcher;
}

export interface StatusResult {
  snapshot: QuotaSnapshot;
}

/**
 * `idleloop status` 实现：调 Watcher.snapshot() 并展示。
 *
 * 返回 snapshot 让调用方决定输出（CLI 用 formatHuman 打印，测试可以直接断言）。
 */
export async function runStatus(opts: StatusOptions = {}): Promise<StatusResult> {
  const watcher = opts.watcher ?? new Watcher();
  const snapshot = await watcher.snapshot();
  return { snapshot };
}

function pctBar(pct: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function colorByRemaining(pct: number, text: string): string {
  if (pct >= 60) return styleText('green', text);
  if (pct >= 30) return styleText('yellow', text);
  return styleText('red', text);
}

function formatWindow(label: string, w: QuotaWindow, now: Date = new Date()): string {
  const remain = w.remainingPct;
  const bar = pctBar(remain);
  const remainStr = colorByRemaining(remain, `${remain.toFixed(0).padStart(3)}%`);
  const utilStr = styleText('dim', `已用 ${w.utilizationPct.toFixed(0)}%`);
  let resetStr = styleText('dim', '（reset 时间未知）');
  if (w.resetsAt != null) {
    const delta = w.resetsAt.getTime() - now.getTime();
    resetStr =
      delta <= 0
        ? styleText('dim', '（已 reset，等待下一次刷新）')
        : `距 reset ${formatDuration(delta)}`;
  }
  return `${styleText('bold', label.padEnd(8))} ${remainStr} 剩余  ${bar}  ${utilStr}  ${resetStr}`;
}

/**
 * 把 snapshot 渲染成人类可读的多行文本。
 */
export function formatHuman(snapshot: QuotaSnapshot, now: Date = new Date()): string {
  const lines: string[] = [];
  lines.push(formatWindow('5h 窗口', snapshot.fiveHour, now));
  lines.push(formatWindow('7d 窗口', snapshot.sevenDay, now));
  if (snapshot.sevenDaySonnet) {
    lines.push(
      styleText('dim', `  ↳ sonnet 7d: 剩 ${snapshot.sevenDaySonnet.remainingPct.toFixed(0)}%`),
    );
  }
  if (snapshot.sevenDayOpus) {
    lines.push(
      styleText('dim', `  ↳ opus   7d: 剩 ${snapshot.sevenDayOpus.remainingPct.toFixed(0)}%`),
    );
  }
  const sub = [snapshot.subscriptionType, snapshot.rateLimitTier].filter(Boolean).join(' / ');
  if (sub) lines.push(styleText('dim', `订阅：${sub}`));
  lines.push(styleText('dim', `拉取于：${snapshot.fetchedAt.toLocaleString()}`));
  return lines.join('\n');
}

/**
 * JSON 输出格式 —— 给脚本 / shell 用。
 */
export function formatJson(snapshot: QuotaSnapshot): string {
  return JSON.stringify(
    {
      fetched_at: snapshot.fetchedAt.toISOString(),
      source: snapshot.source,
      five_hour: serializeWindow(snapshot.fiveHour),
      seven_day: serializeWindow(snapshot.sevenDay),
      seven_day_opus: snapshot.sevenDayOpus ? serializeWindow(snapshot.sevenDayOpus) : null,
      seven_day_sonnet: snapshot.sevenDaySonnet ? serializeWindow(snapshot.sevenDaySonnet) : null,
      subscription_type: snapshot.subscriptionType,
      rate_limit_tier: snapshot.rateLimitTier,
    },
    null,
    2,
  );
}

function serializeWindow(w: QuotaWindow): {
  utilization_pct: number;
  remaining_pct: number;
  resets_at: string | null;
} {
  return {
    utilization_pct: w.utilizationPct,
    remaining_pct: w.remainingPct,
    resets_at: w.resetsAt != null ? w.resetsAt.toISOString() : null,
  };
}
