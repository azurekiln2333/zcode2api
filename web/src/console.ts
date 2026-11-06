import { computed, ref, type Ref } from 'vue'
import { api, ApiError, type ApiDiagnostics } from './api'
import { runCaptcha, cancelCaptcha, captchaState, captchaMessage } from './captcha'
import { visibleQuotaSources } from './quota'
import type { Account, AccountRefresh, ClaimPlan, ClaimResult, ClaimTaskResult, LogChannel, LogEntry, LogPage, LogQuery, Overview, Settings, SelfTestJob } from './types'

const overview = ref<Overview | null>(null)
const logs = ref<LogEntry[]>([])
const logStreams = { requests: logs } as Record<LogChannel, Ref<LogEntry[]>>
export const LOG_PAGE_SIZE = 20
const emptyLogQuery = (): LogQuery => ({ offset: 0, q: '', outcome: 'all', kind: 'all' })
const logQueries = { requests: ref(emptyLogQuery()) } as Record<LogChannel, Ref<LogQuery>>
const logPages = {
  requests: ref({ total: 0, loading: false }),
} as Record<LogChannel, Ref<{ total: number; loading: boolean }>>
const loading = ref(false)
const refreshError = ref('')
const refreshDiagnostics = ref<ApiDiagnostics | null>(null)
const lastUpdated = ref<Date | null>(null)
const busy = ref(new Set<string>())
const refreshingAccounts = ref(new Set<string>())
const refreshProgress = ref<{ done: number; total: number } | null>(null)
const batchClaim = ref<{ running: boolean; cancelled: boolean; done: number; total: number; accountName: string; results: ClaimTaskResult[] } | null>(null)
const toasts = ref<{ id: number; text: string; error: boolean; diagnostics?: ApiDiagnostics }[]>([])
const registration = ref<{ account: Account; token: string } | null>(null)
let notificationId = 0
let activeClaimAccount: string | null = null
let claimGeneration = 0
let refreshPromise: Promise<void> | null = null
const logsRequests: Partial<Record<LogChannel, { path: string; promise: Promise<void> }>> = {}
let sessionGeneration = 0

function reset() {
  sessionGeneration++
  cancelClaim()
  batchClaim.value = null
  activeClaimAccount = null
  overview.value = null
  logs.value = []
  registration.value = null
  lastUpdated.value = null
  refreshError.value = ''
  refreshDiagnostics.value = null
  loading.value = false
  refreshPromise = null
  refreshingAccounts.value.clear()
  refreshProgress.value = null
  busy.value.clear()
  delete logsRequests.requests
  logQueries.requests.value = emptyLogQuery()
  logPages.requests.value = { total: 0, loading: false }
}

function cancelClaim() {
  claimGeneration++
  if (batchClaim.value?.running) batchClaim.value.cancelled = true
  cancelCaptcha()
}

export function notify(text: string, error = false, diagnostics?: ApiDiagnostics) {
  const id = ++notificationId
  toasts.value.push({ id, text, error, diagnostics })
  window.setTimeout(
    () => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    },
    diagnostics ? 15000 : 4500,
  )
}

async function refresh() {
  if (refreshPromise) return refreshPromise
  const generation = sessionGeneration
  loading.value = true
  refreshPromise = (async () => {
    try {
      const data = await api<Overview>('/overview')
      if (generation !== sessionGeneration) return
      if (!data || !Array.isArray(data.accounts) || !data.stats || !data.settings)
        throw new Error('面板返回的数据格式不正确')
      overview.value = data
      lastUpdated.value = new Date()
      refreshError.value = ''
      refreshDiagnostics.value = null
    } catch (error) {
      if (generation !== sessionGeneration) return
      refreshError.value = error instanceof Error ? error.message : '数据加载失败'
      refreshDiagnostics.value = error instanceof ApiError ? (error.diagnostics ?? null) : null
    } finally {
      if (generation === sessionGeneration) {
        loading.value = false
        refreshPromise = null
      }
    }
  })()
  return refreshPromise
}

export function logPath(channel: LogChannel, query: LogQuery, download = false) {
  const params = new URLSearchParams({
    ...(download ? { download: '1' } : { limit: String(LOG_PAGE_SIZE), offset: String(query.offset) }),
    q: query.q,
    outcome: query.outcome,
    kind: query.kind,
  })
  return `/logs?${params}`
}

async function refreshLogs(channel: LogChannel = 'requests', query = logQueries[channel].value) {
  const path = logPath(channel, query)
  const previous = logsRequests[channel]
  if (previous?.path === path) return previous.promise
  const generation = sessionGeneration
  if (logPath(channel, logQueries[channel].value) !== path) {
    logStreams[channel].value = []
    logPages[channel].value.total = 0
  }
  logQueries[channel].value = { ...query }
  logPages[channel].value.loading = true
  const request = { path, promise: Promise.resolve() }
  logsRequests[channel] = request
  const current = () => generation === sessionGeneration && logsRequests[channel] === request
  request.promise = (async () => {
    try {
      const result = await api<LogPage>(path)
      if (!Array.isArray(result.logs) || !Number.isFinite(result.total))
        throw new Error('日志数据格式不正确')
      if (current()) {
        logStreams[channel].value = result.logs
        logPages[channel].value.total = result.total
      }
    } catch (error) {
      if (current())
        notify(
          error instanceof Error ? error.message : '日志加载失败',
          true,
          error instanceof ApiError ? error.diagnostics : undefined,
        )
    } finally {
      if (current()) {
        logPages[channel].value.loading = false
        delete logsRequests[channel]
      }
    }
  })()
  return request.promise
}

/**
 * 账号行内操作：probe → 网关自检（真实走一次上游推理），quota → 领取套餐额度。
 * 领取前重新确认选中套餐，再做一次验证码并提交；失败由用户重新发起。
 */
async function action(id: string, operation: 'probe' | 'quota', planId?: string) {
  if (busy.value.has(id)) return
  if (operation === 'quota' && (activeClaimAccount !== null || batchClaim.value?.running)) {
    notify('请先完成或取消当前人机验证', true)
    return
  }
  busy.value.add(id)
  if (operation === 'quota') activeClaimAccount = id
  const generation = claimGeneration
  const session = sessionGeneration
  try {
    if (operation === 'probe') {
      const path = `/accounts/${encodeURIComponent(id)}/selftest`
      let job = await api<SelfTestJob>(path, 'POST', {})
      const deadline = Date.now() + 75000
      while (job.status === 'running') {
        if (session !== sessionGeneration) return
        if (Date.now() >= deadline) throw new Error('探测结果等待超时，请稍后查看账号状态')
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
        if (session !== sessionGeneration) return
        job = await api<SelfTestJob>(`${path}/${encodeURIComponent(job.jobId)}`)
      }
      if (session !== sessionGeneration) return
      const result = job.result
      if (!result) throw new Error('探测未返回结果，请稍后重试')
      notify(
        result.ok
          ? `自检通过：${result.account ?? '账号'} 回复「${result.text || '正常'}」（${result.ms ?? '—'} ms）`
          : `${result.error || '自检请求未通过'}${result.rayId ? ` · 上游 Ray ID ${result.rayId}` : ''}`,
        !result.ok,
      )
    } else {
      captchaState.value = 'verifying'
      captchaMessage.value = '正在确认可领取套餐…'
      const prepared = await api<{ preparationId: string; plan: ClaimPlan }>(
        `/accounts/${encodeURIComponent(id)}/claim/start`, 'POST', { planId },
      )
      if (generation !== claimGeneration) return
      const proof = await runCaptcha()
      if (generation !== claimGeneration) return
      const result = await api<{ results: ClaimResult[] }>(
        `/accounts/${encodeURIComponent(id)}/claim`, 'POST', {
          planId: prepared.plan.planId, preparationId: prepared.preparationId,
          captchaParam: proof.param, captchaRegion: proof.region,
        },
      )
      cancelCaptcha()
      const outcome = result.results[0]
      if (outcome?.ok) notify(`已成功领取 ${outcome.planName || prepared.plan.name}`)
      else notify(outcome?.msg || '领取未返回结果', true)
    }
    await refresh()
  } catch (error) {
    if (session !== sessionGeneration) return
    if (operation === 'quota') cancelCaptcha()
    if (operation === 'quota' && generation !== claimGeneration) return
    notify(
      error instanceof Error ? error.message : '操作失败',
      true,
      error instanceof ApiError ? error.diagnostics : undefined,
    )
  } finally {
    if (session === sessionGeneration) busy.value.delete(id)
    if (operation === 'quota' && session === sessionGeneration) activeClaimAccount = null
  }
}

/** Refresh each target, then claim each distinct offer once, serially through the official SDK. */
async function claimAll(ids?: string[]) {
  if (batchClaim.value?.running || activeClaimAccount !== null || refreshProgress.value) return
  const targets = (overview.value?.accounts ?? []).filter((a) => ids ? ids.includes(a.id) : a.enabled)
  const session = sessionGeneration
  const generation = claimGeneration
  const current = () => session === sessionGeneration && generation === claimGeneration
  const progress = { running: true, cancelled: false, done: 0, total: targets.length, accountName: '', results: [] as ClaimTaskResult[] }
  batchClaim.value = progress
  const record = (account: Account, plan: ClaimPlan | null, status: ClaimTaskResult['status'], message: string) => {
    if (session !== sessionGeneration || !batchClaim.value) return
    batchClaim.value.results.push({ accountId: account.id, accountName: account.name, planId: plan?.planId ?? null,
      planName: plan?.name ?? null, status, message })
  }
  try {
    for (const account of targets) {
      if (!current()) break
      batchClaim.value!.accountName = account.name
      if (busy.value.has(account.id)) {
        record(account, null, 'skipped', '账号正在执行其他操作，已跳过')
        batchClaim.value!.done++
        continue
      }
      busy.value.add(account.id)
      activeClaimAccount = account.id
      try {
        const result = await refreshAccount(account.id)
        if (!current()) break
        const queryError = [result.eligibility.error, result.eligibility.activation?.error, result.eligibility.currentError].filter(Boolean).join('；')
        if (!result.eligibility.plans.length) record(account, null, queryError ? 'failed' : 'empty', queryError || '暂无可领取套餐')
        else if (queryError) record(account, null, 'failed', queryError)
        const seen = new Set<string>()
        for (const plan of result.eligibility.plans) {
          if (!current()) break
          if (seen.has(plan.planId)) continue
          seen.add(plan.planId)
          let submitted = false
          try {
            const prepared = await api<{ preparationId: string; plan: ClaimPlan }>(
              `/accounts/${encodeURIComponent(account.id)}/claim/start`, 'POST', { planId: plan.planId },
            )
            if (!current()) break
            const proof = await runCaptcha({ interactive: false })
            if (!current()) break
            submitted = true
            const reply = await api<{ results: ClaimResult[] }>(`/accounts/${encodeURIComponent(account.id)}/claim`, 'POST', {
              planId: prepared.plan.planId, preparationId: prepared.preparationId, captchaParam: proof.param, captchaRegion: proof.region,
            })
            if (session !== sessionGeneration) return
            const outcome = reply.results[0]
            record(account, plan, outcome?.unknown ? 'unknown' : outcome?.ok ? 'claimed' : outcome?.alreadyClaimed ? 'already_claimed' : 'failed',
              outcome?.unknown ? '提交结果未知，请刷新套餐并人工确认' : outcome?.ok ? '领取成功' : outcome?.msg || '领取未返回结果')
            if (!outcome?.ok && !outcome?.alreadyClaimed) break
          } catch (error) {
            if (session !== sessionGeneration || (!current() && !submitted)) break
            const interactive = (error as { code?: string }).code === 'captcha_interactive'
            record(account, plan, submitted ? 'unknown' : interactive ? 'needs_verification' : 'failed',
              submitted ? '提交结果未知，请刷新套餐并人工确认' : error instanceof Error ? error.message : '领取失败')
            break
          } finally { if (session === sessionGeneration) cancelCaptcha() }
        }
      } catch (error) {
        if (current()) record(account, null, 'failed', error instanceof Error ? error.message : '资格刷新失败')
      } finally {
        if (session === sessionGeneration) {
          busy.value.delete(account.id)
          activeClaimAccount = null
          if (batchClaim.value) batchClaim.value.done++
        }
      }
    }
  } finally {
    if (session === sessionGeneration && batchClaim.value) {
      batchClaim.value.running = false
      batchClaim.value.accountName = ''
      if (refreshPromise) await refreshPromise
      if (session === sessionGeneration) await refresh()
    }
  }
}

/** Observe the server's automatic refresh even after the login dialog closes. */
async function syncAuthorizedAccount(id: string) {
  const generation = sessionGeneration
  const deadline = Date.now() + 150000
  while (generation === sessionGeneration) {
    if (refreshPromise) await refreshPromise
    if (generation !== sessionGeneration) return
    await refresh()
    if (generation !== sessionGeneration) return
    const account = overview.value?.accounts.find((a) => a.id === id)
    if (!refreshError.value && account && !account.eligibilityRefreshing) {
      const state = account.eligibility
      const failed = !state || state.status !== 'ready' || !!state.activation?.error || !!state.currentError
        || visibleQuotaSources(account.quotaSources).some((s) => s.status === 'error')
      notify(failed ? '授权已更新，资格或额度查询有异常，请查看账号提示' : '授权已更新，资格与额度已自动刷新', failed)
      return
    }
    if (Date.now() >= deadline) {
      notify('授权已保存，资格与额度仍在刷新，请稍后查看账号状态')
      return
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1000))
  }
}

async function refreshAccount(id: string) {
  const result = await api<AccountRefresh>(`/accounts/${encodeURIComponent(id)}/refresh`, 'POST', {})
  return result
}

/** Limit upstream concurrency and keep per-account failures visible. */
async function refreshQualifications(ids?: string[]) {
  if (refreshProgress.value || batchClaim.value?.running) return
  const targets = ids ?? overview.value?.accounts.map((a) => a.id) ?? []
  const generation = sessionGeneration
  refreshProgress.value = { done: 0, total: targets.length }
  let failures = 0
  let next = 0
  const worker = async () => {
    while (next < targets.length && generation === sessionGeneration) {
      const id = targets[next++]!
      refreshingAccounts.value.add(id)
      try {
        const result = await refreshAccount(id)
        if (result.eligibility.status !== 'ready' || result.eligibility.activation?.error || result.eligibility.currentError || visibleQuotaSources(result.quotaSources).some((s) => s.status === 'error')) failures++
      } catch (error) {
        failures++
        if (generation === sessionGeneration) notify(`${id}：${error instanceof Error ? error.message : '刷新失败'}`, true)
      } finally {
        if (generation === sessionGeneration) {
          refreshingAccounts.value.delete(id)
          if (refreshProgress.value) refreshProgress.value.done++
        }
      }
    }
  }
  try {
    await Promise.all([worker(), worker()])
    if (generation !== sessionGeneration) return
    // Wait for any earlier poll before requesting the updated snapshots.
    if (refreshPromise) await refreshPromise
    await refresh()
    notify(`已刷新 ${targets.length} 个账号${failures ? `，${failures} 个需要查看资格或额度提示` : '的资格和额度'}`, failures > 0)
  } finally {
    if (generation === sessionGeneration) refreshProgress.value = null
  }
}

/** 启用/停用账号：停用后彻底退出调度（含全冷却兜底）。 */
async function setEnabled(account: Account, enabled: boolean) {
  busy.value.add(account.id)
  try {
    await api<{ ok: boolean }>(`/accounts/${encodeURIComponent(account.id)}`, 'PATCH', { enabled })
    await refresh()
    notify(enabled ? '账号已启用，恢复参与调度' : '账号已停用，停止分配新请求', !enabled)
  } catch (error) {
    notify(
      error instanceof Error ? error.message : '状态更新失败',
      true,
      error instanceof ApiError ? error.diagnostics : undefined,
    )
  } finally {
    busy.value.delete(account.id)
  }
}

export function accountState(a: Account) {
  if (!a.enabled) return 'disabled'
  if (a.quotaProtection?.suspended) return 'quota'
  if (a.cooldownUntil && Date.parse(a.cooldownUntil) > Date.now()) return 'cooling'
  if (a.status === 'healthy') return 'healthy'
  if (a.status === 'unhealthy') return 'offline'
  return 'pending'
}
export const stateLabels: Record<string, string> = {
  healthy: '可用',
  cooling: '冷却中',
  offline: '降级中',
  pending: '待接入',
  disabled: '已停用',
  quota: '临时暂停',
}
export function quotaProtectionMessage(a: Account) {
  const state = a.quotaProtection
  if (!state?.suspended) return ''
  return '等待额度验证，验证成功后自动恢复'
}
export const strategyLabels: Record<Settings['strategy'], string> = {
  weighted: '加权随机调度',
}
export const number = (n: number | null | undefined, digits = 0) =>
  n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: digits })
export const compact = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : number(n))
export const time = (value: string | null, full = false) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        ...(full ? ({ month: '2-digit', day: '2-digit' } as const) : {}),
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '尚未探活'
export function quotaPercent(a: Account) {
  if (!a.quota || a.quota.credits.total <= 0) return 0
  const { total, used, freeze } = a.quota.credits
  return Math.min(100, ((used + freeze) / total) * 100)
}

export async function copy(text: string) {
  try {
    let copied = false
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text)
        copied = true
      } catch {
        // Browsers may deny the Clipboard API while still allowing a user-initiated copy.
      }
    }
    if (!copied) {
      const previousFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      const previousInput =
        previousFocus instanceof HTMLInputElement || previousFocus instanceof HTMLTextAreaElement
          ? previousFocus
          : null
      const selection = previousInput
        ? {
            start: previousInput.selectionStart,
            end: previousInput.selectionEnd,
            direction: previousInput.selectionDirection,
          }
        : null
      const input = document.createElement('textarea')
      input.value = text
      input.readOnly = true
      input.tabIndex = -1
      input.style.position = 'fixed'
      input.style.top = '0'
      input.style.left = '0'
      input.style.opacity = '0'
      const dialogs = document.querySelectorAll('dialog[open]')
      const container =
        previousFocus?.closest('dialog[open]') || dialogs.item(dialogs.length - 1) || document.body
      try {
        container.appendChild(input)
        input.focus({ preventScroll: true })
        input.select()
        input.setSelectionRange(0, text.length)
        copied = document.execCommand('copy')
      } finally {
        input.remove()
        previousFocus?.focus({ preventScroll: true })
        if (previousInput && selection?.start != null)
          previousInput.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined)
      }
      if (!copied) throw new Error('clipboard unavailable')
    }
    notify('已复制到剪贴板')
  } catch {
    notify('复制失败，请手动选择内容复制', true)
  }
}

export function useConsole() {
  return {
    overview,
    logs,
    logStreams,
    logPages,
    loading,
    refreshError,
    refreshDiagnostics,
    lastUpdated,
    busy,
    refreshingAccounts,
    refreshProgress,
    batchClaim,
    claimAll,
    refreshQualifications,
    syncAuthorizedAccount,
    toasts,
    registration,
    accounts: computed(() => overview.value?.accounts ?? []),
    captchaState,
    captchaMessage,
    cancelClaim,
    refresh,
    refreshLogs,
    reset,
    action,
    setEnabled,
  }
}
