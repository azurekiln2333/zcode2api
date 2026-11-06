// Time semantics adapted from zcode-switch src/claim-time.js and src/ui.js.
// Copyright (c) 2026 zcode-switch contributors. MIT; see THIRD_PARTY_NOTICES.md.
import type { ClaimPlan, CurrentClaimPlan, Eligibility } from './types'

export const claimGroups = [
  { id: 'claimable', label: '可领取' },
  { id: 'claimed', label: '已领取' },
  { id: 'expired', label: '已过期' },
] as const

export interface ClaimDetail {
  key: string
  planId: string
  title: string
  name: string
  status: typeof claimGroups[number]['id']
  statusText: string
  startsAt: number | null
  endsAt: number | null
  effectiveText: string
  campaignId: string
  position: string
  description: string
  entitlements: ClaimPlan['entitlements']
}

const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const pad = (value: number) => String(value).padStart(2, '0')

export function formatClaimTime(value: number | string | null | undefined): string {
  if (value == null || value === '') return '未提供'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '未提供'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function dateMillis(year: number, month: number, day: number, hour: number, minute: number): number | null {
  const date = new Date(year, month - 1, day, hour, minute)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    && date.getHours() === hour && date.getMinutes() === minute ? date.getTime() : null
}

// Only a sentence containing 生效 can supply a fallback; activity start is never substituted.
export function effectiveFromCopy(text: string, now = Date.now()): number | null {
  const pattern = /(\d{4})\s*[年\-/.·]\s*(\d{1,2})\s*[月\-/.·]\s*(\d{1,2})\s*日?\s*[T ]?\s*(\d{1,2})\s*[:：]\s*(\d{2})|(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})|(\d{1,2})\/(\d{1,2})\s+(\d{1,2})\s*[:：]\s*(\d{2})/g
  for (const sentence of text.split(/[。；;\n\r]+/)) {
    const at = sentence.indexOf('生效')
    if (at < 0) continue
    const candidates: Array<{ at: number; index: number }> = []
    for (const match of sentence.matchAll(pattern)) {
      const hasYear = match[1] !== undefined
      const offset = hasYear ? 2 : match[6] !== undefined ? 6 : 10
      const year = hasYear ? Number(match[1]) : new Date(now).getFullYear()
      const month = Number(match[offset]), day = Number(match[offset + 1])
      const hour = Number(match[offset + 2]), minute = Number(match[offset + 3])
      let value = dateMillis(year, month, day, hour, minute)
      if (!hasYear && value !== null && value < now - 30 * 86400_000) value = dateMillis(year + 1, month, day, hour, minute)
      if (value !== null) candidates.push({ at: value, index: match.index })
    }
    const candidate = candidates.filter((c) => c.index < at).at(-1) ?? candidates[0]
    if (candidate) return candidate.at
  }
  return null
}

export function claimDetails(eligibility: Eligibility | null, now = Date.now()): ClaimDetail[] {
  if (!eligibility) return []
  const available = new Map(eligibility.plans.map((p) => [p.planId, p]))
  const current = eligibility.currentPlans ?? []
  const owned = new Set(current.map((p) => p.planId))
  const detail = (plan: ClaimPlan, active?: CurrentClaimPlan): ClaimDetail => {
    const offer = available.get(plan.planId)
    const campaign = plan.campaign ?? offer?.campaign
    const description = campaign?.body || plan.description || offer?.description || ''
    const field = numeric(plan.effectiveAt)
    const copy = field === null ? effectiveFromCopy(description, now) : null
    const effectiveText = field === 0 ? '立即生效' : field !== null ? formatClaimTime(field)
      : copy !== null ? `预计 ${formatClaimTime(copy)} 生效（据活动说明）` : active ? '上游未提供' : '领取后确认'
    const startsAt = numeric(plan.startsAt) ?? numeric(campaign?.startsAt)
    const endsAt = numeric(plan.endsAt) ?? numeric(campaign?.endsAt)
    const status = active?.status === 'expired' || (endsAt !== null && endsAt <= now) ? 'expired' : active ? 'claimed' : 'claimable'
    const statusText = status === 'expired' ? '已过期' : status === 'claimable' ? '可领取'
      : field !== null && field > now ? '已领取 · 待生效' : '已领取'
    return {
      key: active?.userPlanId || `${status}:${plan.planId}`, planId: plan.planId,
      title: campaign?.title || plan.name, name: plan.name, status, statusText, startsAt, endsAt, effectiveText,
      campaignId: campaign?.campaignId || '未提供', position: campaign?.position || '未提供', description,
      entitlements: plan.entitlements.length ? plan.entitlements : offer?.entitlements ?? [],
    }
  }
  return [
    ...eligibility.plans.filter((p) => !owned.has(p.planId)).map((p) => detail(p)),
    ...current.map((p) => detail(p, p)),
  ]
}
