import type { TriggerPolicyConfig } from '../storage/config.js';

export type TriggerBlockReason =
  | 'quiet_hours'
  | 'user_activity'
  | 'policies_not_satisfied'
  | 'invalid_snapshot';

export interface TriggerDecision {
  triggered: boolean;
  reason: string;
  /** 命中的策略，仅当 triggered=true */
  matchedPolicy?: TriggerPolicyConfig;
  /** 命中的窗口类型，仅当 triggered=true */
  windowType?: 'five_hour' | 'seven_day';
  /** 触发窗口当前剩余 %，仅当 triggered=true */
  remainingPct?: number;
  /** 触发窗口距 reset 毫秒，仅当 triggered=true */
  msUntilReset?: number;
  /** 被拦截原因，仅当 triggered=false */
  blockedBy?: TriggerBlockReason;
}

export interface UserActivityCheck {
  active: boolean;
  lastActivityAt: Date | null;
  minutesSince: number | null;
}
