import { styleText } from 'node:util';
import { loadConfig, type Config } from '../../storage/config.js';
import { evaluatePolicy, isInQuietHours } from '../../trigger/policy.js';
import { checkUserActivity } from '../../trigger/user-activity.js';
import { detectSystemIdle } from '../../trigger/system-idle.js';
import { Watcher } from '../../watcher/index.js';
import type { QuotaSnapshot } from '../../watcher/types.js';

export interface RunWhyResult {
  triggered: boolean;
  blockedBy: string | null;
  /** 摘要行：让脚本快速判断 */
  summary: string;
  /** 每条「检查项 + 是否通过」 */
  steps: Array<{ name: string; pass: boolean; detail: string }>;
}

export interface RunWhyDeps {
  config?: Config;
  watcher?: { snapshot(): Promise<QuotaSnapshot> };
  /** 测试注入：替换 user activity 检查 */
  checkActivity?: typeof checkUserActivity;
  /** 测试注入：替换 system idle 探测 */
  checkSystemIdle?: typeof detectSystemIdle;
  print?: (s: string) => void;
  now?: () => Date;
}

/**
 * `idleloop why` — 解释「现在会不会触发，为什么/为什么不」。
 *
 * 一屏内打出整条决策链路：
 *   1. quota 当前状态
 *   2. system_idle（如启用）
 *   3. quiet_hours
 *   4. user_activity_guard
 *   5. 每条 policy 的命中/不命中原因
 *   6. 综合 verdict
 *
 * 比 `idleloop run --dry` 更专注：不跑 curator，不真碰任何 worktree，只回答「为什么」。
 */
export async function runWhy(deps: RunWhyDeps = {}): Promise<RunWhyResult> {
  const print = deps.print ?? ((s: string) => console.log(s));
  const now = (deps.now ?? (() => new Date()))();
  const config = deps.config ?? (await loadConfig());
  const steps: RunWhyResult['steps'] = [];

  print(styleText('bold', `When: ${now.toLocaleString()}`));

  // 1. quota
  let snapshot: QuotaSnapshot | null = null;
  try {
    const watcher = deps.watcher ?? new Watcher();
    snapshot = await watcher.snapshot();
    const fr = snapshot.fiveHour.remainingPct.toFixed(0);
    const sr = snapshot.sevenDay.remainingPct.toFixed(0);
    print(
      `  quota:        ${styleText('green', '✓')} 5h=${fr}% (reset ${formatReset(snapshot.fiveHour.resetsAt, now)})  ·  7d=${sr}% (reset ${formatReset(snapshot.sevenDay.resetsAt, now)})`,
    );
    steps.push({ name: 'quota', pass: true, detail: `5h=${fr}% 7d=${sr}%` });
  } catch (err) {
    const msg = (err as Error).message;
    print(`  quota:        ${styleText('red', '✗')} ${msg}`);
    steps.push({ name: 'quota', pass: false, detail: msg });
    print('');
    print(styleText('red', 'Cannot evaluate: quota fetch failed.'));
    return {
      triggered: false,
      blockedBy: 'invalid_snapshot',
      summary: 'quota unavailable',
      steps,
    };
  }

  // 2. system_idle bypass（如启用，则其它 gate 可绕过）
  let afk = false;
  if (config.trigger.system_idle?.enabled) {
    try {
      const r = await (deps.checkSystemIdle ?? detectSystemIdle)({});
      const min = config.trigger.system_idle.min_minutes;
      const idleMin = r.idleMs >= 0 ? Math.floor(r.idleMs / 60_000) : -1;
      if (r.idleMs >= 0 && idleMin >= min) {
        afk = true;
        print(
          `  system_idle:  ${styleText('green', '✓')} afk ${idleMin}min ≥ ${min}min via ${r.source}  → bypassing quiet_hours + user_activity`,
        );
        steps.push({
          name: 'system_idle',
          pass: true,
          detail: `idle ${idleMin}min (source=${r.source}) — bypass enabled`,
        });
      } else if (r.idleMs >= 0) {
        print(
          `  system_idle:  ${styleText('dim', '·')} idle ${idleMin}min < ${min}min threshold (source=${r.source})`,
        );
        steps.push({
          name: 'system_idle',
          pass: false,
          detail: `idle ${idleMin}min < ${min}min`,
        });
      } else {
        print(
          styleText(
            'dim',
            `  system_idle:  · detection unavailable on this platform (${r.source})`,
          ),
        );
        steps.push({ name: 'system_idle', pass: false, detail: 'detection unavailable' });
      }
    } catch (err) {
      print(styleText('dim', `  system_idle:  · check failed: ${(err as Error).message}`));
      steps.push({ name: 'system_idle', pass: false, detail: (err as Error).message });
    }
  } else {
    print(styleText('dim', '  system_idle:  · disabled in config'));
  }

  // 3. quiet_hours
  if (config.trigger.quiet_hours) {
    const qh = config.trigger.quiet_hours;
    const inQ = isInQuietHours(now, qh);
    if (inQ && !afk) {
      print(
        `  quiet_hours:  ${styleText('red', '✗')} ${formatHour(qh.start)}–${formatHour(qh.end)} active (would block; current hour=${now.getHours()})`,
      );
      steps.push({
        name: 'quiet_hours',
        pass: false,
        detail: `${formatHour(qh.start)}–${formatHour(qh.end)} active`,
      });
    } else if (inQ && afk) {
      print(
        `  quiet_hours:  ${styleText('yellow', '~')} ${formatHour(qh.start)}–${formatHour(qh.end)} active but bypassed by system_idle`,
      );
      steps.push({ name: 'quiet_hours', pass: true, detail: 'bypassed by system_idle' });
    } else {
      print(
        `  quiet_hours:  ${styleText('green', '✓')} outside ${formatHour(qh.start)}–${formatHour(qh.end)} window`,
      );
      steps.push({ name: 'quiet_hours', pass: true, detail: 'outside window' });
    }
  } else {
    print(styleText('dim', '  quiet_hours:  · disabled'));
    steps.push({ name: 'quiet_hours', pass: true, detail: 'disabled' });
  }

  // 4. user_activity_guard
  if (!afk) {
    try {
      const act = await (deps.checkActivity ?? checkUserActivity)(
        config.trigger.user_activity_guard_minutes,
      );
      if (act.active) {
        const since = act.minutesSince?.toFixed(0) ?? '?';
        print(
          `  user_activity: ${styleText('red', '✗')} claude usage ${since}min ago (within ${config.trigger.user_activity_guard_minutes}min guard)`,
        );
        steps.push({
          name: 'user_activity',
          pass: false,
          detail: `recent activity ${since}min ago`,
        });
      } else {
        const since = act.minutesSince != null ? `${act.minutesSince.toFixed(0)}min ago` : 'never';
        print(`  user_activity: ${styleText('green', '✓')} last claude activity ${since}`);
        steps.push({ name: 'user_activity', pass: true, detail: `last activity ${since}` });
      }
    } catch (err) {
      print(styleText('dim', `  user_activity: · check failed: ${(err as Error).message}`));
      steps.push({ name: 'user_activity', pass: true, detail: 'check failed (ignored)' });
    }
  } else {
    print(styleText('dim', '  user_activity: ~ bypassed by system_idle'));
    steps.push({ name: 'user_activity', pass: true, detail: 'bypassed by system_idle' });
  }

  // 5. policies
  print(styleText('bold', '  policies:'));
  let policyMatched = false;
  for (const p of config.trigger.policies) {
    const r = evaluatePolicy(p, { snapshot, now });
    if (r.matches) {
      policyMatched = true;
      print(`    ${styleText('green', '✓')} ${p.window}: ${r.reason}`);
      steps.push({ name: `policy.${p.window}`, pass: true, detail: r.reason });
    } else {
      print(`    ${styleText('yellow', '·')} ${p.window}: ${r.reason}`);
      steps.push({ name: `policy.${p.window}`, pass: false, detail: r.reason });
    }
  }

  // 6. verdict
  print('');
  const inQuiet = config.trigger.quiet_hours
    ? isInQuietHours(now, config.trigger.quiet_hours) && !afk
    : false;
  // 用户 activity 单独算（注意：上面已经短路 print 过；这里用 steps 反向取）
  const activityBlocked = steps.find((s) => s.name === 'user_activity' && !s.pass) != null;

  if (inQuiet) {
    print(styleText('yellow', '→ would NOT trigger now: blocked by quiet_hours'));
    return {
      triggered: false,
      blockedBy: 'quiet_hours',
      summary: 'quiet_hours active',
      steps,
    };
  }
  if (activityBlocked) {
    print(styleText('yellow', '→ would NOT trigger now: blocked by user_activity'));
    return {
      triggered: false,
      blockedBy: 'user_activity',
      summary: 'user_activity within guard window',
      steps,
    };
  }
  if (!policyMatched) {
    print(
      styleText(
        'yellow',
        '→ would NOT trigger now: no policy satisfied (quota too healthy / too far from reset)',
      ),
    );
    return {
      triggered: false,
      blockedBy: 'policies_not_satisfied',
      summary: 'no policy satisfied',
      steps,
    };
  }
  print(styleText('green', '→ WOULD trigger now (gates open + policy matched)'));
  return {
    triggered: true,
    blockedBy: null,
    summary: 'all gates open, policy matched',
    steps,
  };
}

function formatReset(resetsAt: Date | null, now: Date): string {
  if (!resetsAt) return 'unknown';
  const ms = resetsAt.getTime() - now.getTime();
  if (ms <= 0) return 'past';
  if (ms < 3600_000) return `in ${Math.round(ms / 60_000)}min`;
  if (ms < 86_400_000) return `in ${(ms / 3600_000).toFixed(1)}h`;
  return `in ${(ms / 86_400_000).toFixed(1)}d`;
}

function formatHour(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}
