import type { Account, Quota } from './types'

export function formatRemainingQuotaPercent(credits: {
  total: number | null
  used: number | null
  freeze: number | null
}) {
  const { total, used, freeze } = credits
  if (total == null || total <= 0 || used == null || freeze == null) return '—'
  const remaining = Math.max(0, Math.min(total, total - used - freeze))
  return `${((remaining / total) * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`
}

/** 汇总号池额度：每个账号一条快照（zcgw 没有组织概念，org 即账号）。
 *  停用号也计入 —— 停用只关调度，额度还是这个号的额度。 */
export function summarizeQuota(accounts: Account[]) {
  const snapshots = new Map<string, Quota>()
  for (const account of accounts) {
    if (account.quota) snapshots.set(account.quota.org, account.quota)
  }
  const quotas = [...snapshots.values()]
  const times = quotas.map((item) => item.syncedAt).sort()
  return {
    configured: quotas.length,
    organizations: quotas.length,
    syncedAt: times[0] ?? null,
    syncing: 0,
    errors: 0,
    total: quotas.length ? quotas.reduce((sum, item) => sum + item.credits.total, 0) : null,
    used: quotas.length ? quotas.reduce((sum, item) => sum + item.credits.used, 0) : null,
    freeze: quotas.length ? quotas.reduce((sum, item) => sum + item.credits.freeze, 0) : null,
  }
}
