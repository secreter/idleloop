import type { Config } from '../storage/config.js';
import { logger as rootLogger } from '../utils/logger.js';
import type { QuotaSnapshot } from '../watcher/types.js';
import { evaluatePolicy, isInQuietHours } from './policy.js';
import type { TriggerDecision, UserActivityCheck } from './types.js';
import { checkUserActivity } from './user-activity.js';

const moduleLogger = rootLogger.child({ mod: 'trigger' });

export interface SnapshotSource {
  snapshot(): Promise<QuotaSnapshot>;
}

export interface ActivityChecker {
  check(thresholdMinutes: number): Promise<UserActivityCheck>;
}

export interface TriggerEngineOptions {
  config: Config['trigger'];
  watcher: SnapshotSource;
  /** 测试注入；默认用 ~/.claude/projects/ 扫 mtime */
  activity?: ActivityChecker;
  /** 测试注入；默认 new Date() */
  now?: () => Date;
}

const defaultActivity: ActivityChecker = {
  async check(thresholdMinutes) {
    return checkUserActivity(thresholdMinutes);
  },
};

/**
 * 触发决策引擎。
 *
 * 决策步骤（按顺序短路）：
 *   1. quiet hours：当前时间是否在禁触发时段（如白天 8:00-22:00）
 *   2. user activity guard：最近 N 分钟内用户是否在用 Claude Code
 *   3. policies：任一 policy 命中即触发
 *
 * 三步任何一步「不允许」就返回 triggered=false 并带 blockedBy 原因。
 */
export class TriggerEngine {
  constructor(private readonly opts: TriggerEngineOptions) {}

  async shouldTrigger(): Promise<TriggerDecision> {
    const now = (this.opts.now ?? (() => new Date()))();

    if (this.opts.config.quiet_hours) {
      if (isInQuietHours(now, this.opts.config.quiet_hours)) {
        return {
          triggered: false,
          reason: `in quiet hours ${this.opts.config.quiet_hours.start}-${this.opts.config.quiet_hours.end}`,
          blockedBy: 'quiet_hours',
        };
      }
    }

    let snapshot: QuotaSnapshot;
    try {
      snapshot = await this.opts.watcher.snapshot();
    } catch (err) {
      moduleLogger.warn({ err }, 'watcher.snapshot failed during shouldTrigger');
      return {
        triggered: false,
        reason: `watcher.snapshot failed: ${(err as Error).message}`,
        blockedBy: 'invalid_snapshot',
      };
    }

    const activity = await (this.opts.activity ?? defaultActivity).check(
      this.opts.config.user_activity_guard_minutes,
    );
    if (activity.active) {
      return {
        triggered: false,
        reason: `user active ${activity.minutesSince?.toFixed(0) ?? '?'} minutes ago`,
        blockedBy: 'user_activity',
      };
    }

    const policyReasons: string[] = [];
    for (const policy of this.opts.config.policies) {
      const result = evaluatePolicy(policy, { snapshot, now });
      if (result.matches && result.window && result.window.resetsAt) {
        const msUntilReset = result.window.resetsAt.getTime() - now.getTime();
        return {
          triggered: true,
          reason: result.reason,
          matchedPolicy: policy,
          windowType: policy.window,
          remainingPct: result.window.remainingPct,
          msUntilReset,
        };
      }
      policyReasons.push(result.reason);
    }
    return {
      triggered: false,
      reason: `no policy satisfied: ${policyReasons.join('; ')}`,
      blockedBy: 'policies_not_satisfied',
    };
  }
}

export { evaluatePolicy, isInQuietHours } from './policy.js';
export { checkUserActivity, getMostRecentClaudeActivity } from './user-activity.js';
export type { TriggerDecision, UserActivityCheck } from './types.js';
