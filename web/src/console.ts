import { computed, ref, type Ref } from 'vue'
import { api, ApiError, type ApiDiagnostics } from './api'
import { runCaptcha, cancelCaptcha, captchaState, captchaMessage } from './captcha'
import type { Account, AccountRefresh, LogChannel, LogEntry, LogPage, LogQuery, Overview, Settings } from './types'

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
const toasts = ref<{ id: number; text: string; error: boolean; diagnostics?: ApiDiagnostics }[]>([])
const registration = ref<{ account: Account; token: string } | null>(null)
let notificationId = 0
let refreshPromise: Promise<void> | null = null
const logsRequests: Partial<Record<LogChannel, { path: string; promise: Promise<void> }>> = {}
let sessionGeneration = 0

function reset() {
  sessionGeneration++
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
  delete logsRequests.requests
  logQueries.requests.value = emptyLogQuery()
  logPages.requests.value = { total: 0, loading: false }
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
 * 领取前先跑阿里云人机验证（上游 claim 强制），3007 时自动换新验证参数重试一轮。
 */
async function action(id: string, operation: 'probe' | 'quota', planId?: string) {
  if (busy.value.has(id)) return
  busy.value.add(id)
  try {
    if (operation === 'probe') {
      const result = await api<{ ok: boolean; account?: string; text?: string; ms?: number; error?: string }>(
        `/accounts/${encodeURIComponent(id)}/selftest`,
        'POST',
        {},
      )
      notify(
        result.ok
          ? `自检通过：${result.account ?? '账号'} 回复「${result.text || '正常'}」（${result.ms ?? '—'} ms）`
          : result.error || '自检请求未通过',
        !result.ok,
      )
    } else {
      let last: { ok: boolean; alreadyClaimed?: boolean; expired?: boolean; claimed?: string; msg?: string; code?: number | string } | undefined
      // 验证参数是一次性的：最多两轮（首轮 + 3007 换新参数重试）
      for (let attempt = 0; attempt < 2; attempt++) {
        captchaState.value = 'verifying'
        let param: string
        try {
          param = await runCaptcha()
        } catch (e) {
          last = { ok: false, msg: e instanceof Error ? e.message : '人机验证失败' }
          break
        }
        const result = await api<{ results?: Array<{ ok: boolean; alreadyClaimed?: boolean; expired?: boolean; claimed?: string; msg?: string; code?: number | string }> }>(
          `/accounts/${encodeURIComponent(id)}/claim`,
          'POST',
          { captchaParam: param, planId },
        )
        last = (result.results ?? [])[0]
        if (last?.code === 3007) {
          captchaMessage.value = '验证参数已过期，正在重新验证…'
          continue
        }
        break
      }
      cancelCaptcha()
      const x = last ?? { ok: false, msg: '领取未返回结果' }
      if (x.expired) notify('注册礼包已领过（新号专属，4 天窗口）', true)
      else if (x.ok && x.alreadyClaimed) notify('额度已在生效中，无需重复领取')
      else if (x.ok) notify(`已成功领取 ${x.claimed ?? '额度'}`)
      else notify(x.msg || '当前不在可领取窗口', true)
      await refreshAccount(id)
    }
    await refresh()
  } catch (error) {
    cancelCaptcha()
    notify(
      error instanceof Error ? error.message : '操作失败',
      true,
      error instanceof ApiError ? error.diagnostics : undefined,
    )
  } finally {
    busy.value.delete(id)
  }
}

async function refreshAccount(id: string) {
  const result = await api<AccountRefresh>(`/accounts/${encodeURIComponent(id)}/refresh`, 'POST', {})
  return result
}

/** Limit upstream concurrency and keep per-account failures visible. */
async function refreshQualifications(ids?: string[]) {
  if (refreshProgress.value) return
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
        if (result.eligibility.status !== 'ready' || result.quotaSources.some((s) => s.status === 'error')) failures++
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
    notify(`已刷新 ${targets.length} 个账号${failures ? `，${failures} 个存在查询失败，请查看明细` : '的资格和额度'}`, failures > 0)
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
    refreshQualifications,
    toasts,
    registration,
    accounts: computed(() => overview.value?.accounts ?? []),
    captchaState,
    captchaMessage,
    refresh,
    refreshLogs,
    reset,
    action,
    setEnabled,
  }
}
