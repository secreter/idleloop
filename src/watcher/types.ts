/**
 * Watcher 暴露给其他模块的 normalized 类型。
 * 字段命名 camelCase（内部类型），和上游 OAuth 端点的 snake_case 不同。
 */

export interface QuotaWindow {
  /** 已用百分比 0-100 */
  utilizationPct: number;
  /** 剩余百分比 0-100 */
  remainingPct: number;
  /** 下次 reset 时间；null 表示该窗口当前不适用（如 promotional 类未启用） */
  resetsAt: Date | null;
}

export interface ExtraUsageInfo {
  enabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
}

export type QuotaSnapshotSource = 'oauth' | 'cli_fallback' | 'cached';

export interface QuotaSnapshot {
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;

  /** 辅助窗口：模型/产品维度的额度，可能为 null */
  sevenDayOpus: QuotaWindow | null;
  sevenDaySonnet: QuotaWindow | null;
  sevenDayCowork: QuotaWindow | null;

  /** Pay-as-you-go 额外用量配置 */
  extraUsage: ExtraUsageInfo | null;

  /** 用户订阅类型（来自 token），仅供展示 */
  subscriptionType: string | null;
  /** 限速 tier（来自 token），仅供展示 */
  rateLimitTier: string | null;

  fetchedAt: Date;
  source: QuotaSnapshotSource;
}
