import type { Account } from './types'

/** Count snapshots without adding incompatible plans, units or reset windows. */
export function summarizeQuota(accounts: Account[]) {
  const sources = accounts.flatMap((a) => a.quotaSources || [])
  return {
    organizations: accounts.filter((a) => a.quotaSources?.some((s) => s.syncedAt)).length,
    plans: sources.reduce((count, s) => count + s.plans.length, 0),
    errors: sources.filter((s) => s.status === 'error').length,
  }
}
