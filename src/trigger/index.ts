import type { Config } from '../storage/config.js';
import { logger as rootLogger } from '../utils/logger.js';
import type { QuotaSnapshot } from '../watcher/types.js';
import { evaluatePolicy, isInQuietHours } from './policy.js';
import { detectSystemIdle, type DetectIdleOptions } from './system-idle.js';
import type { SystemIdleCheck, TriggerDecision, UserActivityCheck } from './types.js';
import { checkUserActivity } from './user-activity.js';

const moduleLogger = rootLogger.child({ mod: 'trigger' });

export interface SnapshotSource {
  snapshot(): Promise<QuotaSnapshot>;
}

export interface ActivityChecker {
  check(thresholdMinutes: number): Promise<UserActivityCheck>;
}

export interface SystemIdleChecker {
  check(): Promise<SystemIdleCheck>;
}

export interface TriggerEngineOptions {
  config: Config['trigger'];
  watcher: SnapshotSource;
  /** 测试注入；默认用 ~/.claude/projects/ 扫 mtime */
  activity?: ActivityChecker;
  /** 测试注入；默认用 xprintidle / loginctl / ioreg 探测 */
  systemIdle?: SystemIdleChecker;
  /** 测试注入；默认 new Date() */
  now?: () => Date;
}

const defaultActivity: ActivityChecker = {
  async check(thresholdMinutes) {
    return checkUserActivity(thresholdMinutes);
  },
};

function defaultSystemIdleChecker(
  minMinutes: number,
  opts: DetectIdleOptions = {},
): SystemIdleChecker {
  return {
    async check(): Promise<SystemIdleCheck> {
      const r = await detectSystemIdle(opts);
      const isAfk = r.idleMs >= 0 && r.idleMs >= minMinutes * 60_000;
      return { idleMs: r.idleMs, source: r.source, isAfk };
    },
  };
}

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

    // 先做系统级 afk 检测：用户离开电脑足够久就 bypass quiet_hours + user_activity，
    // 但仍受 policies 约束（余量得满足）。
    const sysIdleConfig = this.opts.config.system_idle;
    let afk = false;
    if (sysIdleConfig?.enabled) {
      const checker = this.opts.systemIdle ?? defaultSystemIdleChecker(sysIdleConfig.min_minutes);
      try {
        const r = await checker.check();
        afk = r.isAfk;
        if (afk) {
          moduleLogger.debug(
            { idleMs: r.idleMs, source: r.source },
            'system idle detected; bypassing quiet_hours + user_activity',
          );
        }
      } catch (err) {
        moduleLogger.debug({ err: (err as Error).message }, 'system-idle check failed; continuing');
      }
    }

    if (!afk && this.opts.config.quiet_hours) {
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

    if (!afk) {
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
export { detectSystemIdle } from './system-idle.js';
export type { TriggerDecision, UserActivityCheck, SystemIdleCheck } from './types.js';
