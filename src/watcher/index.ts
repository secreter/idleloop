import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, paths } from '../storage/paths.js';
import { logger as rootLogger } from '../utils/logger.js';
import {
  fetchUsage,
  TokenInvalidError,
  type OAuthClientOptions,
  type RawUsageResponse,
} from './oauth-client.js';
import { refreshAccessToken, type RefreshOptions } from './refresh.js';
import {
  isTokenExpired,
  loadToken,
  type LoadTokenOptions,
  type TokenInfo,
} from './token-source.js';
import type { ExtraUsageInfo, QuotaSnapshot, QuotaWindow } from './types.js';

const moduleLogger = rootLogger.child({ mod: 'watcher' });

export interface WatcherOptions {
  oauth?: OAuthClientOptions;
  tokenSource?: LoadTokenOptions;
  /** 历史文件路径，默认 paths.quotaJsonl() */
  quotaJsonlPath?: string;
  /** 是否写历史，默认 true */
  persistHistory?: boolean;
  /** OAuth refresh 配置；测试注入或自定义端点用 */
  refresh?: RefreshOptions;
  /** 401 是否走 refresh + retry，默认 true */
  autoRefreshOn401?: boolean;
}

export interface PollHandlers {
  onUpdate: (s: QuotaSnapshot) => void;
  onError?: (err: unknown) => void;
}

/**
 * 余量监视器。
 *
 * - snapshot(): 单次拉取
 * - startPolling(): 周期性拉取
 *
 * 注意：snapshot() 内部已把 utilization 从 0-100 转成 remaining 的语义。
 */
export class Watcher {
  private readonly opts: WatcherOptions;
  private pollTimer?: NodeJS.Timeout;
  private polling = false;

  constructor(opts: WatcherOptions = {}) {
    this.opts = opts;
  }

  async snapshot(): Promise<QuotaSnapshot> {
    let token = await loadToken(this.opts.tokenSource ?? {});
    const autoRefresh = this.opts.autoRefreshOn401 !== false;
    if (isTokenExpired(token) && autoRefresh) {
      moduleLogger.info(
        { expiresAt: token.expiresAt.toISOString() },
        'OAuth token near expiry; pre-emptively refreshing',
      );
      token = await tryRefreshToken(token, this.opts.refresh ?? {});
    }
    let raw: RawUsageResponse;
    try {
      raw = await fetchUsage(token.accessToken, this.opts.oauth ?? {});
    } catch (err) {
      if (err instanceof TokenInvalidError && autoRefresh && token.refreshToken) {
        moduleLogger.warn('got 401 from usage endpoint; trying refresh + retry');
        token = await tryRefreshToken(token, this.opts.refresh ?? {});
        raw = await fetchUsage(token.accessToken, this.opts.oauth ?? {});
      } else {
        throw err;
      }
    }
    const snapshot = toSnapshot(raw, token);
    if (this.opts.persistHistory !== false) {
      await this.appendJsonl(snapshot);
    }
    return snapshot;
  }

  startPolling(intervalMs: number, handlers: PollHandlers): void {
    if (this.pollTimer) throw new Error('Watcher already polling');
    if (intervalMs < 1000) throw new Error('intervalMs must be >= 1000');
    this.polling = true;
    const tick = async (): Promise<void> => {
      if (!this.polling) return;
      try {
        const s = await this.snapshot();
        handlers.onUpdate(s);
      } catch (err) {
        if (handlers.onError) handlers.onError(err);
        else moduleLogger.error({ err }, 'watcher poll failed');
      }
    };
    void tick();
    this.pollTimer = setInterval(() => void tick(), intervalMs);
  }

  stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async appendJsonl(s: QuotaSnapshot): Promise<void> {
    const filePath = this.opts.quotaJsonlPath ?? paths.quotaJsonl();
    await ensureDir(path.dirname(filePath));
    const line = JSON.stringify({
      fetched_at: s.fetchedAt.toISOString(),
      five_hour: serializeWindow(s.fiveHour),
      seven_day: serializeWindow(s.sevenDay),
      source: s.source,
    });
    await appendFile(filePath, line + '\n', { mode: 0o600 });
  }
}

function toWindow(raw: { utilization: number; resets_at: string | null } | null): QuotaWindow {
  if (raw == null) {
    return { utilizationPct: 0, remainingPct: 100, resetsAt: null };
  }
  const u = clampPct(raw.utilization);
  return {
    utilizationPct: u,
    remainingPct: Math.max(0, 100 - u),
    resetsAt: raw.resets_at != null ? new Date(raw.resets_at) : null,
  };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function toSnapshot(raw: RawUsageResponse, token: TokenInfo): QuotaSnapshot {
  const extra = raw.extra_usage ?? null;
  const extraInfo: ExtraUsageInfo | null = extra
    ? {
        enabled: extra.is_enabled,
        monthlyLimit: extra.monthly_limit,
        usedCredits: extra.used_credits,
        utilization: extra.utilization,
        currency: extra.currency,
      }
    : null;
  return {
    fiveHour: toWindow(raw.five_hour ?? null),
    sevenDay: toWindow(raw.seven_day ?? null),
    sevenDayOpus: raw.seven_day_opus != null ? toWindow(raw.seven_day_opus) : null,
    sevenDaySonnet: raw.seven_day_sonnet != null ? toWindow(raw.seven_day_sonnet) : null,
    sevenDayCowork: raw.seven_day_cowork != null ? toWindow(raw.seven_day_cowork) : null,
    extraUsage: extraInfo,
    subscriptionType: token.subscriptionType || null,
    rateLimitTier: token.rateLimitTier || null,
    fetchedAt: new Date(),
    source: 'oauth',
  };
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

async function tryRefreshToken(current: TokenInfo, opts: RefreshOptions): Promise<TokenInfo> {
  const refreshed = await refreshAccessToken(current, opts);
  return {
    ...current,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  };
}

/**
 * 把毫秒数格式化为「X 小时 Y 分」/「X 天 Y 小时」/「Z 分」等可读字符串。
 * 给 status 命令的展示层用。
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '已过';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) {
    const rh = h - d * 24;
    return rh > 0 ? `${d} 天 ${rh} 小时` : `${d} 天`;
  }
  if (h >= 1) {
    const rm = m - h * 60;
    return rm > 0 ? `${h} 小时 ${rm} 分` : `${h} 小时`;
  }
  if (m >= 1) return `${m} 分`;
  return `${s} 秒`;
}
