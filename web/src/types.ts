/** zcgw 面板领域类型 —— 结构沿用 cnb2api console 的命名约定，字段映射 zcgw 网关真实数据。 */

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  reportedRequests: number
  missingRequests: number
  partialRequests: number
}

export interface Quota {
  org: string
  credits: { total: number; used: number; freeze: number }
  dev: { total: number; used: number; freeze: number }
  ci: { total: number; used: number }
  syncedAt: string
}

export interface QuotaProtectionState {
  suspended: boolean
  reason: 'disabled' | 'unknown' | 'sync-error' | 'invalid' | 'low' | 'override' | null
  remainingPercent: number | null
  thresholdPercent: number
}

export interface QuotaItem {
  id: string
  name: string
  unit: string
  total: number | null
  used: number | null
  remaining: number | null
  remainingPercent: number | null
  resetAt: string | null
  display?: 'percent'
  resetTimeFormat?: 'datetime' | 'date'
}

export interface QuotaPlan {
  id: string
  name: string
  status: string
  endsAt: string | null
  items: QuotaItem[]
  campaign?: { label: string; description: string }
}

export interface QuotaSource {
  id: string
  name: string
  status: 'pending' | 'ready' | 'error' | 'unconfigured'
  plans: QuotaPlan[]
  syncedAt: string | null
  error: string | null
  diagnostics?: {
    provider: string
    credentials: { oauth: boolean; savedKey: boolean; manualKey: boolean }
    checkedAt: string
    steps: Array<{ resource: string; credential?: string; status: 'ready' | 'error' | 'skipped'; httpStatus?: number; code?: number; count?: number; error?: string }>
  }
}

export interface ClaimPlan {
  planId: string
  name: string
  description: string
  effectiveAt: number | null
  startsAt?: number | null
  endsAt?: number | null
  entitlements: Array<{ model: string; grant: number; period: string }>
  campaign: {
    campaignId?: string
    position?: string
    title: string
    body: string
    startsAt: number | null
    endsAt: number | null
  } | null
}

export interface CurrentClaimPlan extends ClaimPlan {
  userPlanId: string
  status: string
}

export interface ClaimResult {
  ok: boolean
  code?: number | string
  msg?: string
  alreadyClaimed?: boolean
  unknown?: boolean
  planName?: string
  effectiveAt?: number | null
  startsAt?: number | null
  endsAt?: number | null
  nextAt?: number | null
}

interface EligibilityChannel {
  status: number | null
  code: number | null
  count: number
  parsedCount: number
  transport: string | null
  error: string | null
}

export interface Eligibility {
  status: 'ready' | 'partial' | 'error'
  plans: ClaimPlan[]
  currentPlans?: CurrentClaimPlan[]
  currentError?: string | null
  version?: { reported: string; latest: string | null; stale: boolean; checkedAt: string | null; error: string | null }
  diagnostics?: { preview: EligibilityChannel; marketing: EligibilityChannel; current: EligibilityChannel; elapsedMs: number }
  checkedAt: string
  error: string | null
  activation?: {
    status: 'ready' | 'error' | 'unavailable'
    checkedAt: string
    retryAt: string
    error: string | null
  } | null
}

export interface AccountRefresh {
  quotaSources: QuotaSource[]
  eligibility: Eligibility
}

export interface SelfTestResult {
  ok: boolean
  account: string
  text?: string
  ms?: number
  error?: string
  code?: string
  upstreamStatus?: number | null
  rayId?: string | null
}

export interface SelfTestJob {
  jobId: string
  status: 'running' | 'completed'
  result: SelfTestResult | null
}

export interface Account {
  id: string
  name: string
  label: string
  uid: string
  group: string
  realm: 'cn' | 'intl' | 'unknown'
  identity: string | null
  email: string | null
  phone: string | null
  weight: number
  manualWeight: number
  priority: number
  enabled: boolean
  disabled: boolean
  hasAccessToken: boolean
  hasCodingPlanKey: boolean
  codingPlanProvider: 'zai' | 'bigmodel'
  quotaSources: QuotaSource[]
  eligibility: Eligibility | null
  eligibilityRefreshing?: boolean
  quotaProtection?: QuotaProtectionState
  status: 'pending' | 'healthy' | 'unhealthy'
  checkedAt: string | null
  registeredAt: string | null
  cooldownUntil: string | null
  cooldownMin: number
  failures: number
  latencyMs: number | null
  lastError: string
  quota: Quota | null
  plans: QuotaPlan[]
  requests: number
  errors: number
  activeRequests: number
  createdAt: string
  updatedAt: string
  tokenUsage: TokenTotals
}

export interface Settings {
  strategy: 'weighted'
  sessionAffinity: boolean
  stickyTtlMin: number
  topN: number
  maxInFlight: number
  breakerThreshold: number
  breakerCooldownMin: number
  blockedCooldownMin: number
  quotaCooldownMin: number
  busyCooldownSec: number
  minPickGapMs: number
  idleWeightPerHour: number
  idleWeightMax: number
  weightBalFactor: number
  weightSuccFactor: number
  weekendGrab: boolean
  limits: Record<string, [number, number]>
}

export interface HourBucket {
  at: string
  requests: number
  errors: number
  durationMs: number
  accounts: Record<string, number>
  tokenUsage?: TokenTotals
}

export interface Stats {
  total: number
  ready: number
  cooling: number
  disabled: number
  requests: number
  errors: number
  successRate: number | null
  remainingCredits: number | null
  totalCredits: number | null
  quotaOrganizations: number
  averageDurationMs: number | null
  activeRequests: number
  tokenUsage: { today: TokenTotals; total: TokenTotals; startedAt: string }
}

export interface LogEntry {
  id: string
  at: string
  kind: 'request' | 'audit' | 'account' | 'register' | 'health' | 'failover' | 'wake'
  accountId: string | null
  accountName: string
  status: number
  message: string
  ip?: string
  model?: string
  durationMs?: number
  ok?: boolean
  err?: string
  tokenUsage?: TokenTotals
}

export interface Overview {
  accounts: Account[]
  settings: Settings
  hourly: HourBucket[]
  stats: Stats
  claimAutomation?: ClaimAutomation
}

export interface ClaimTaskResult {
  accountId: string
  accountName: string
  planId: string | null
  planName: string | null
  status: 'claimed' | 'already_claimed' | 'failed' | 'needs_verification' | 'empty' | 'skipped' | 'unknown'
  message: string
  at?: string
}

export interface ClaimAutomation {
  settings: { enabled: boolean; time: string; timezone: string }
  browser?: { mode: 'panel' | 'remote' | 'local'; connectedPanels?: number } | null
  nextRunAt: string | null
  running: boolean
  error: string | null
  lastRun: {
    id: string
    source: 'manual' | 'scheduled'
    status: 'running' | 'stopping' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
    startedAt: string
    finishedAt: string | null
    total: number
    done: number
    accountName: string | null
    error: string | null
    results: ClaimTaskResult[]
  } | null
}

export interface ModelAccount {
  id: string
  name: string
}

export interface ModelInventoryEntry {
  id: string
  listed: boolean
  configuredAccounts: ModelAccount[]
  discoveredAccounts: ModelAccount[]
  eligibleAccounts: ModelAccount[]
}

export interface ModelInventory {
  models: ModelInventoryEntry[]
}

export interface AccessProfile {
  publicUrl: string
  maskedKey: string
  gatewayKeySet: boolean
  panelAuthRequired: boolean
  models: Array<{ id: string; name: string; context: number; maxOutput: number }>
}

export interface LogQuery {
  offset: number
  q: string
  outcome: 'all' | 'success' | 'failure'
  kind: string
}

export interface LogPage {
  logs: LogEntry[]
  total: number
  limit: number
  offset: number
}

export interface AuthConfig {
  keyLoginEnabled: boolean
  sso: { enabled: boolean; providerName: string; loginUrl: string }
}

export interface SessionUser {
  name: string
  email: string
  picture: string
  provider: 'key' | 'oidc'
}

export type LogChannel = 'requests'
export type Page =
  | 'accounts' | 'overview' | 'models' | 'routing' | 'activity' | 'access'
