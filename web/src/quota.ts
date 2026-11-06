import type { Account, QuotaSource } from './types'

/** Empty sources have no quota to display; zero and unknown amounts are still valid items. */
export function visibleQuotaSources(sources: QuotaSource[]) {
  return sources.flatMap((source) => {
    const plans = source.plans.filter((plan) => plan.items.length > 0)
    return plans.length ? [{ ...source, plans }] : []
  })
}

/** Count snapshots without adding incompatible plans, units or reset windows. */
export function summarizeQuota(accounts: Account[]) {
  const sources = accounts.flatMap((a) => visibleQuotaSources(a.quotaSources || []))
  return {
    organizations: accounts.filter((a) => a.quotaSources?.some((s) => s.syncedAt)).length,
    plans: sources.reduce((count, s) => count + s.plans.length, 0),
    errors: sources.filter((s) => s.status === 'error').length,
  }
}
