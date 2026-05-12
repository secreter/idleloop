import type { TriggerPolicyConfig } from '../storage/config.js';
import type { QuotaSnapshot, QuotaWindow } from '../watcher/types.js';

export interface PolicyEvalContext {
  snapshot: QuotaSnapshot;
  now: Date;
}

export interface PolicyEvalResult {
  matches: boolean;
  reason: string;
  /** matches=true 时返回触发的窗口，便于上层提取 reset 时间 */
  window?: QuotaWindow;
}

/**
 * 评估单个 policy 是否触发。
 *
 * 命中条件（两条都必须满足）：
 *   1. 当前距 reset 时间 <= policy.hours_before_reset
 *   2. 当前 remainingPct >= policy.min_remaining_pct
 *
 * 即「快 reset 了 + 还剩不少」=「快浪费了，赶紧用」。
 */
export function evaluatePolicy(
  policy: TriggerPolicyConfig,
  ctx: PolicyEvalContext,
): PolicyEvalResult {
  const window = policy.window === 'five_hour' ? ctx.snapshot.fiveHour : ctx.snapshot.sevenDay;

  if (window.resetsAt == null) {
    return {
      matches: false,
      reason: `${policy.window}: resets_at unknown, cannot evaluate`,
    };
  }

  const msUntilReset = window.resetsAt.getTime() - ctx.now.getTime();
  const hoursUntilReset = msUntilReset / 3600_000;

  if (hoursUntilReset <= 0) {
    return {
      matches: false,
      reason: `${policy.window}: already past reset, skip`,
    };
  }

  if (hoursUntilReset > policy.hours_before_reset) {
    return {
      matches: false,
      reason: `${policy.window}: ${hoursUntilReset.toFixed(1)}h until reset > threshold ${policy.hours_before_reset}h`,
    };
  }

  if (window.remainingPct < policy.min_remaining_pct) {
    return {
      matches: false,
      reason: `${policy.window}: only ${window.remainingPct.toFixed(0)}% remaining < threshold ${policy.min_remaining_pct}%`,
    };
  }

  return {
    matches: true,
    reason: `${policy.window}: ${window.remainingPct.toFixed(0)}% remaining, reset in ${hoursUntilReset.toFixed(1)}h`,
    window,
  };
}

/**
 * 判断 now 是否落在 quiet hours 内。
 *
 * quiet hours 是「绝不触发」的时间段。支持跨午夜：
 *   { start: 8, end: 22 }   → 8:00 至 22:00（同一天）
 *   { start: 22, end: 8 }   → 22:00 至 次日 8:00（跨午夜）
 *   { start: 0, end: 0 }    → 视作不启用
 */
export function isInQuietHours(now: Date, qh: { start: number; end: number }): boolean {
  if (qh.start === qh.end) return false;
  const h = now.getHours();
  if (qh.start < qh.end) {
    return h >= qh.start && h < qh.end;
  }
  return h >= qh.start || h < qh.end;
}
