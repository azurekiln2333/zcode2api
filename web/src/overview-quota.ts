import { visibleQuotaSources } from './quota.ts'
import type { QuotaSource } from './types'

export interface OverviewQuota {
  mode: 'amount' | 'percent' | 'empty'
  unit: string | null
  remaining: number | null
  total: number | null
  used: number | null
  percent: number | null
  plans: number
  items: number
  partial: boolean
  syncedAt: string | null
  stale: boolean
}

const amount = (value: number | null) =>
  value !== null && Number.isFinite(value) && value >= 0 ? value : null
const clamp = (value: number) => Math.max(0, Math.min(100, value))
const unitName = (unit: string) => {
  const value = unit.trim()
  if (/^tokens?$/i.test(value)) return 'Tokens'
  if (/^credits?$/i.test(value)) return 'Credits'
  return value
}

/** Overview only: one account/pool summary. Account management keeps every bucket separate. */
export function summarizeOverviewQuota(sources: QuotaSource[]): OverviewQuota {
  const visible = visibleQuotaSources(sources)
  const items = visible.flatMap((source) => source.plans.flatMap((plan) => plan.items))
  const times = visible.map((source) => source.syncedAt)
    .filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
  const summary: OverviewQuota = {
    mode: 'empty', unit: null, remaining: null, total: null, used: null, percent: null,
    plans: visible.reduce((sum, source) => sum + source.plans.length, 0),
    items: items.length, partial: false, syncedAt: times[0] ?? null,
    stale: visible.some((source) => source.status === 'error'),
  }
  if (!items.length) return summary

  const units = new Set(items.map((item) => unitName(item.unit)))
  const unit = units.size === 1 ? [...units][0]! : null
  // Generic Coding Plan units can represent overlapping time limits, not a quantity to add.
  const additive = unit !== null && unit !== '' && unit !== '单位'
  const values = items.map((item) => {
    const total = amount(item.total)
    const rawRemaining = amount(item.remaining)
    const remaining = rawRemaining !== null && total !== null ? Math.min(rawRemaining, total) : rawRemaining
    const percent = item.display === 'percent' && amount(item.remainingPercent) !== null ? clamp(item.remainingPercent!) : total !== null && remaining !== null
      ? (total > 0 ? clamp(remaining / total * 100) : 0)
      : (amount(item.remainingPercent) !== null ? clamp(item.remainingPercent!) : null)
    return { total, remaining, percent }
  })

  if (additive) {
    const complete = values.filter((item) => item.total !== null && item.remaining !== null)
    if (complete.length) {
      const total = complete.reduce((sum, item) => sum + item.total!, 0)
      const remaining = complete.reduce((sum, item) => sum + item.remaining!, 0)
      return { ...summary, mode: 'amount', unit, total, remaining, used: total - remaining,
        percent: total > 0 ? clamp(remaining / total * 100) : 0,
        partial: complete.length !== items.length }
    }
    const knownRemaining = values.filter((item) => item.remaining !== null)
    if (knownRemaining.length) {
      return { ...summary, mode: 'amount', unit,
        remaining: knownRemaining.reduce((sum, item) => sum + item.remaining!, 0), partial: true }
    }
  }

  // Mixed units and percentage-only windows share a single normalized bar, never a fictitious token total.
  const percentages = values.filter((item) => item.percent !== null)
  return { ...summary, mode: 'percent',
    percent: percentages.length ? percentages.reduce((sum, item) => sum + item.percent!, 0) / percentages.length : null,
    partial: percentages.length !== items.length }
}
