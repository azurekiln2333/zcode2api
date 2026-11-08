<script setup lang="ts">
import { computed, ref, watch, onUnmounted, nextTick } from 'vue'
import {
  Plus,
  RefreshCw,
  Search,
  ChevronDown,
  ArrowDownUp,
  UsersRound,
  CircleCheck,
  Activity,
  Wallet,
  MoreHorizontal,
  Pencil,
  Copy,
  KeyRound,
  LoaderCircle,
  Check,
  X,
  ArrowRight,
  ArrowUpRight,
  Zap,
  Layers,
  FilterX,
  Waypoints,
  Cloud,
  Gift,
} from '@lucide/vue'
import { api } from '../api'
import {
  useConsole,
  accountState,
  number,
  time,
  strategyLabels,
  copy,
} from '../console'
import type { Account, Page } from '../types'
import { summarizeQuota } from '../quota'
import AccountDialog from '../components/AccountDialog.vue'
import OnboardDialog from '../components/OnboardDialog.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ModalShell from '../components/ModalShell.vue'
import QuotaDetails from '../components/QuotaDetails.vue'
import ClaimDetailsDialog from '../components/ClaimDetailsDialog.vue'

const emit = defineEmits<{ navigate: [page: Page] }>()
const { overview, accounts, loading, busy, refresh, action, setEnabled, refreshQualifications, refreshProgress, refreshingAccounts, captchaState, captchaMessage, cancelClaim, cancelManualClaim, claimAll, batchClaim } = useConsole()
onUnmounted(cancelManualClaim)
const search = ref('')
const tab = ref('all')
const group = ref('all')
const selected = ref(new Set<string>())
const showEditor = ref(false)
const editingAccount = ref<Account | null>(null)
const managingId = ref<string | null>(null)
const managing = computed(() => accounts.value.find((a) => a.id === managingId.value) ?? null)
const detailsAccountId = ref<string | null>(null)
const detailsPlanId = ref<string>()
const detailsAccount = computed(() => accounts.value.find((a) => a.id === detailsAccountId.value) ?? null)
const showOnboard = ref(false)
const onboardAccount = ref<Account | null>(null)
const onboardProvider = ref<'zai' | 'bigmodel'>()
const page = ref(1)
const sortBy = ref<'created' | 'name'>('created')
const groups = computed(() => [...new Set(accounts.value.map((a) => a.group))])
const credits = computed(() => summarizeQuota(accounts.value))
const tabs = computed(() => [
  { id: 'all', label: '全部账号', count: accounts.value.length },
  {
    id: 'healthy',
    label: '可用',
    count: accounts.value.filter((a) => accountState(a) === 'healthy').length,
  },
  {
    id: 'attention',
    label: '需关注',
    count: accounts.value.filter((a) =>
      ['pending', 'offline', 'cooling', 'quota'].includes(accountState(a)),
    ).length,
  },
  { id: 'disabled', label: '已停用', count: accounts.value.filter((a) => !a.enabled).length },
])
const filtered = computed(() =>
  accounts.value
    .filter((a) => {
      const matches = `${a.name} ${a.identity ?? ''} ${a.label}`
        .toLowerCase()
        .includes(search.value.toLowerCase())
      const state = accountState(a)
      return (
        matches &&
        (group.value === 'all' || a.group === group.value) &&
        (tab.value === 'all' ||
          tab.value === state ||
          (tab.value === 'attention' && ['pending', 'offline', 'cooling', 'quota'].includes(state)))
      )
    })
    .sort((a, b) =>
      sortBy.value === 'name'
        ? a.name.localeCompare(b.name, 'zh-CN')
        : b.createdAt.localeCompare(a.createdAt),
    ),
)
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 10)))
const rows = computed(() => filtered.value.slice((page.value - 1) * 10, page.value * 10))
const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every((a) => selected.value.has(a.id)),
)
watch([search, group, tab], () => {
  page.value = 1
  selected.value.clear()
})
watch(accounts, () => {
  selected.value = new Set(
    [...selected.value].filter((id) => accounts.value.some((a) => a.id === id)),
  )
  page.value = Math.min(page.value, pages.value)
})
const totalToday = (id: string) => {
  const today = Math.floor((Date.now() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
  return (
    overview.value?.hourly
      .filter((b) => Date.parse(b.at) >= today)
      .reduce((n, b) => n + (b.accounts[id] || 0), 0) ?? 0
  )
}
const rowOps = ref<Record<string, 'probe' | 'quota' | undefined>>({})
async function rowAction(id: string, operation: 'probe' | 'quota', planId?: string) {
  if (busy.value.has(id)) return
  rowOps.value[id] = operation
  try {
    await action(id, operation, planId)
  } finally {
    if (rowOps.value[id] === operation) delete rowOps.value[id]
  }
}
function openClaimDetails(id: string, planId?: string) {
  managingId.value = null
  detailsAccountId.value = id
  detailsPlanId.value = planId
  if (!accounts.value.find((account) => account.id === id)?.eligibility) void refreshQualifications([id])
}
async function claimFromDetails(planId: string) {
  const account = detailsAccount.value
  if (!account || busy.value.has(account.id)) return
  detailsAccountId.value = null
  // Close the native modal before captcha so its interactive popup remains accessible.
  await nextTick()
  await rowAction(account.id, 'quota', planId)
}
function edit(account: Account | null = null) {
  editingAccount.value = account
  showEditor.value = true
  managingId.value = null
}
function startOnboard(account: Account | null = null, provider?: 'zai' | 'bigmodel') {
  onboardAccount.value = account
  onboardProvider.value = provider
  showOnboard.value = true
  managingId.value = null
}
function toggleAll() {
  if (allSelected.value) rows.value.forEach((a) => selected.value.delete(a.id))
  else rows.value.forEach((a) => selected.value.add(a.id))
}
function clearFilters() {
  search.value = ''
  tab.value = 'all'
  group.value = 'all'
}
function manageEnable() {
  if (!managing.value) return
  void setEnabled(managing.value, !managing.value.enabled)
  managingId.value = null
}
function manageAction(operation: 'quota' | 'probe') {
  if (!managing.value) return
  if (operation === 'quota') {
    openClaimDetails(managing.value.id)
    return
  }
  void action(managing.value.id, operation)
  managingId.value = null
}
async function batch(enabled: boolean) {
  await Promise.all(
    accounts.value.filter((a) => selected.value.has(a.id)).map((a) => setEnabled(a, enabled)),
  )
  selected.value.clear()
}
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />ACCOUNT POOL</div>
      <h1>
        账号池<span class="heading-count">{{ accounts.length }}</span>
      </h1>
      <p>把多个 ZCode 账号连接起来，让请求总有去处。</p>
    </div>
    <div class="heading-actions">
      <button class="button token-shortcut" @click="emit('navigate', 'overview')">
        <Wallet :size="15" />用量统计
      </button>
      <button class="button" :disabled="!!refreshProgress || !!batchClaim?.running || !accounts.length" @click="refreshQualifications()">
        <RefreshCw :size="15" :class="{ spin: !!refreshProgress }" />
        {{ refreshProgress ? `刷新中 ${refreshProgress.done}/${refreshProgress.total}` : '一键刷新资格' }}
      </button>
      <button class="button" :disabled="!!refreshProgress || !!batchClaim?.running || captchaState !== 'idle' || !accounts.length || !!overview?.claimAutomation?.running"
        @click="claimAll(selected.size ? [...selected] : undefined)">
        <Gift :size="15" />{{ batchClaim?.running ? `领取中 ${batchClaim.done}/${batchClaim.total}` : selected.size ? `一键领取（${selected.size} 个）` : '一键领取' }}
      </button>
      <button class="button primary" @click="startOnboard()"
        ><Plus :size="17" />登录新账号</button
      >
    </div>
  </div>
  <section v-if="batchClaim" class="section-panel claim-batch-panel" aria-live="polite">
    <div class="claim-batch-heading">
      <strong>{{ batchClaim.running ? `正在处理 ${batchClaim.accountName}` : batchClaim.cancelled ? '一键领取已停止' : '一键领取已完成' }} · {{ batchClaim.done }}/{{ batchClaim.total }} 个账号</strong>
      <button v-if="batchClaim.running" class="button" :disabled="batchClaim.cancelled" @click="cancelClaim">{{ batchClaim.cancelled ? '正在停止' : '停止领取' }}</button>
      <button v-else class="icon-button" aria-label="收起领取结果" @click="batchClaim = null"><X :size="16" /></button>
    </div>
    <p class="subtle">{{ batchClaim.results.filter(r => r.status === 'claimed').length }} 个套餐领取成功；需要人工验证的账号可单独点击领取。</p>
    <div class="claim-result-list">
      <div v-for="(result, index) in batchClaim.results" :key="index" class="claim-result-row">
        <strong>{{ result.accountName }}</strong><span>{{ result.planName || '资格检测' }}</span><span :class="{ 'success-text': result.status === 'claimed' }">{{ result.message }}</span>
        <button v-if="result.status === 'needs_verification' && !batchClaim.running" class="button small" @click="openClaimDetails(result.accountId, result.planId || undefined)">领取</button>
      </div>
    </div>
  </section>
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-top">
        <span>已接入账号</span><span class="stat-icon blue"><UsersRound :size="17" /></span>
      </div>
      <div class="stat-value">{{ number(overview?.stats.total) }}<small>个</small></div>
      <div class="stat-bottom">
        <span class="stat-dots"><i /><i /><i /></span>独立账号 · 统一入口
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>当前可用</span><span class="stat-icon green"><CircleCheck :size="17" /></span>
      </div>
      <div class="stat-value">
        {{ number(overview?.stats.ready) }}<small>/ {{ accounts.length }}</small
        ><span class="stat-tag" :class="{ warning: !overview?.stats.ready }">{{
          overview?.stats.ready ? '可以接收请求' : '等待账号就绪'
        }}</span>
      </div>
      <div class="stat-bottom">
        <i class="status-dot" :class="{ green: overview?.stats.ready }" />{{
          overview?.stats.cooling
            ? `${overview.stats.cooling} 个账号冷却中`
            : '启用后自动加入路由'
        }}
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>今日请求</span><span class="stat-icon violet"><Activity :size="17" /></span>
      </div>
      <div class="stat-value">{{ number(overview?.stats.requests ?? 0) }}<small>次</small></div>
      <div class="stat-bottom">
        <span v-if="overview?.stats.successRate != null" class="success-text"
          >{{ number(overview.stats.successRate, 1) }}% 成功率</span
        ><span v-else>等待第一条请求</span><span class="stat-meta">UTC+8</span>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>套餐额度</span><span class="stat-icon amber"><Wallet :size="17" /></span>
      </div>
      <div class="stat-value">{{ credits.plans }}<small>个套餐</small></div>
      <div class="stat-bottom">
        <span>{{ credits.organizations }} 个账号已查询 · 按套餐分别展示</span>
      </div>
    </div>
  </div>
  <section class="pool-panel">
    <div v-if="captchaState === 'verifying' || captchaState === 'interactive'" class="table-toolbar" role="status">
      <span>{{ captchaMessage }}</span>
      <button class="quiet-button" @click="cancelClaim">取消验证</button>
    </div>
    <div class="pool-panel-header">
      <div class="pool-tabs" role="tablist" aria-label="按账号状态筛选">
        <button
          v-for="item in tabs"
          :key="item.id"
          role="tab"
          :aria-selected="tab === item.id"
          :class="{ active: tab === item.id }"
          @click="tab = item.id"
        >
          {{ item.label }}<span>{{ item.count }}</span>
        </button>
      </div>
      <button class="quiet-button route-shortcut" @click="emit('navigate', 'routing')">
        <span class="status-dot green" />{{
          overview ? strategyLabels[overview.settings.strategy] : '自动路由'
        }}<ChevronDown :size="13" />
      </button>
    </div>
    <div class="table-toolbar">
      <div class="search-field">
        <Search :size="16" /><input
          id="account-search"
          v-model="search"
          placeholder="搜索账号、身份或备注…"
          aria-label="搜索账号"
        /><button v-if="search" class="icon-button" aria-label="清空搜索" @click="search = ''">
          <X :size="13" />
        </button>
      </div>
      <div class="toolbar-filters">
        <label class="select-wrap"
          ><Layers :size="14" /><select v-model="group" aria-label="账号分组">
            <option value="all">全部分组</option>
            <option v-for="g in groups" :key="g" :value="g">{{ g }}</option></select
          ><ChevronDown :size="12" /></label
        ><button
          class="button sort-button"
          :title="sortBy === 'created' ? '按名称排序' : '按接入时间排序'"
          @click="sortBy = sortBy === 'created' ? 'name' : 'created'"
        >
          <ArrowDownUp :size="14" /><span>{{
            sortBy === 'created' ? '最近接入' : '账号名称'
          }}</span></button
        ><button
          class="icon-button table-refresh"
          aria-label="刷新账号列表"
          :disabled="loading"
          @click="refresh"
        >
          <RefreshCw :size="15" :class="{ spin: loading }" />
        </button>
      </div>
    </div>
    <div v-if="selected.size" class="batch-bar">
      <span><Check :size="14" />已选择 {{ selected.size }} 个账号</span
      ><button @click="batch(true)">启用所选</button><button @click="batch(false)">停用所选</button
      ><button class="batch-cancel" @click="selected.clear()">取消选择</button>
    </div>
    <div v-if="rows.length" class="table-scroll">
      <table class="account-table">
        <thead>
          <tr>
            <th class="checkbox-cell">
              <input
                type="checkbox"
                :checked="allSelected"
                aria-label="选择当前页全部账号"
                @change="toggleAll"
              />
            </th>
            <th>账号 / 身份</th>
            <th>运行状态</th>
            <th>套餐额度</th>
            <th>今日请求</th>
            <th>权重</th>
            <th class="right-align">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(account, index) in rows"
            :key="account.id"
            :class="{
              selected: selected.has(account.id),
              muted: !account.enabled,
            }"
          >
            <td class="checkbox-cell">
              <input
                type="checkbox"
                :checked="selected.has(account.id)"
                :aria-label="`选择${account.name}`"
                @change="
                  selected.has(account.id) ? selected.delete(account.id) : selected.add(account.id)
                "
              />
            </td>
            <td>
              <div class="account-identity">
                <span class="account-avatar" :class="`avatar-${index % 5}`">{{
                  account.name.slice(0, 1).toUpperCase()
                }}</span>
                <div>
                  <button class="account-name" @click="edit(account)">
                    {{ account.name }}<span class="group-tag">{{ account.group }}</span>
                  </button>
                  <span class="account-repo account-repo-link">
                    <KeyRound :size="11" /><span>{{ account.identity || account.uid }}</span>
                  </span>
                </div>
              </div>
              <button
                class="account-endpoint"
                :title="`复制账号 ID：${account.id}`"
                @click="copy(account.id)"
              >
                <span class="endpoint-prefix">↳</span
                ><span>{{ account.label }}</span>
                <Copy :size="10" />
              </button>
            </td>
            <td>
              <StatusBadge :account="account" />
              <template v-if="accountState(account) === 'cooling'">
                <div class="cell-secondary account-health-detail account-health-error">
                  {{ account.lastError || '账号请求失败，暂时停止分配' }}
                </div>
                <div class="cell-secondary account-health-detail">
                  冷却至 {{ time(account.cooldownUntil) }} · 到期后自动重试
                </div>
              </template>
              <div
                v-else
                class="cell-secondary account-health-detail"
                :title="account.lastError || `最近使用 ${time(account.checkedAt, true)}`"
              >
                <span v-if="accountState(account) === 'healthy'" class="latency-bars"
                  ><i /><i /><i /></span
                >{{
                  accountState(account) === 'healthy'
                    ? `在途 ${account.activeRequests} 个请求`
                    : account.enabled
                      ? account.lastError || '等待首次调用'
                      : '已停用调度 · 额度与领取不受影响'
                }}
              </div>
            </td>
            <td class="quota-cell">
              <QuotaDetails :sources="account.quotaSources || []" :refreshing="account.eligibilityRefreshing"
                @reauthorize="startOnboard(account, $event)" />
              <div class="eligibility-status">
                <button class="text-link small-link" :disabled="!!refreshProgress"
                  @click="refreshQualifications([account.id])">
                  <RefreshCw :size="12" :class="{ spin: refreshingAccounts.has(account.id) }" />刷新资格与额度
                </button>
                <span v-if="account.eligibilityRefreshing" class="quota-sync-state" role="status">授权已更新，正在自动刷新资格与额度…</span>
                <span v-else-if="!account.eligibility" class="quota-sync-state">领取资格尚未查询</span>
                <template v-else>
                  <span v-if="account.eligibility.activation?.error" class="quota-sync-state error">{{ account.eligibility.activation.error }}</span>
                  <span v-else-if="account.eligibility.activation?.status === 'ready'" class="quota-updated">资格激活上报已完成</span>
                  <span v-if="account.eligibility.error" class="quota-sync-state error">{{ account.eligibility.error }}</span>
                  <span v-if="account.eligibility.status === 'ready' && !account.eligibility.plans.length" class="quota-sync-state">上游本次未返回可领取套餐</span>
                  <button v-for="plan in account.eligibility.plans" :key="plan.planId"
                    class="text-link small-link" :title="plan.description || plan.campaign?.body || plan.planId"
                    :disabled="busy.has(account.id)" @click="openClaimDetails(account.id, plan.planId)">
                    <Zap :size="12" />{{ plan.name }} · 查看详情
                  </button>
                  <span v-if="account.eligibility.currentError" class="quota-sync-state error">已领套餐：{{ account.eligibility.currentError }}</span>
                  <button class="text-link small-link" @click="openClaimDetails(account.id)">
                    活动与已领套餐详情<span v-if="account.eligibility.currentPlans?.length">（已领 {{ account.eligibility.currentPlans.length }}）</span>
                  </button>
                  <details v-if="account.eligibility.diagnostics" class="quota-updated">
                    <summary>查询详情 · 客户端 {{ account.eligibility.version?.reported }}</summary>
                    <div v-if="account.eligibility.version?.error">{{ account.eligibility.version.error }}</div>
                    <div v-for="channel in (['preview', 'marketing', 'current'] as const)" :key="channel">
                      {{ channel }}：HTTP {{ account.eligibility.diagnostics[channel].status ?? '—' }}，
                      业务码 {{ account.eligibility.diagnostics[channel].code ?? '—' }}，
                      返回 {{ account.eligibility.diagnostics[channel].count }} 项 / 解析 {{ account.eligibility.diagnostics[channel].parsedCount }} 个套餐，
                      {{ account.eligibility.diagnostics[channel].transport || '未完成' }}
                    </div>
                  </details>
                  <span class="quota-updated">资格查询于 {{ time(account.eligibility.checkedAt, true) }}</span>
                </template>
              </div>
            </td>
            <td>
              <span class="request-number">{{ number(totalToday(account.id)) }}</span>
              <div class="cell-secondary">{{ account.activeRequests }} 个进行中</div>
            </td>
            <td>
              <div class="weight-cell">
                <span class="weight-number">{{ account.weight }}</span>
              </div>
              <div class="cell-secondary">
                {{
                  account.plans.length
                    ? `${account.plans.length} 个生效套餐`
                    : '无生效套餐'
                }}
              </div>
            </td>
            <td>
              <div class="row-actions">
                <button
                  class="icon-button"
                  :disabled="busy.has(account.id)"
                  :aria-label="`自检${account.name}`"
                  :aria-busy="rowOps[account.id] === 'probe'"
                  :title="account.enabled ? '真实调用一次上游，验证连通' : '账号已停用，启用后才能自检'"
                  @click="rowAction(account.id, 'probe')"
                >
                  <LoaderCircle
                    v-if="rowOps[account.id] === 'probe'"
                    :size="15"
                    class="spin"
                  /><Activity v-else :size="15" /></button
                ><button
                  class="icon-button quota-button"
                  :disabled="busy.has(account.id)"
                  :aria-label="`查看${account.name}套餐详情`"
                  :aria-busy="rowOps[account.id] === 'quota'"
                  title="查看套餐详情后领取"
                  @click="openClaimDetails(account.id)"
                >
                  <LoaderCircle v-if="rowOps[account.id] === 'quota'" :size="15" class="spin" /><Zap
                    v-else
                    :size="15"
                  /></button
                ><button
                  class="icon-button"
                  :aria-label="`编辑${account.name}`"
                  title="编辑账号身份与权重"
                  @click="edit(account)"
                >
                  <Pencil :size="14" /></button
                ><button
                  class="icon-button"
                  :aria-label="`管理${account.name}`"
                  title="更多操作"
                  @click="managingId = account.id"
                >
                  <MoreHorizontal :size="17" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="accounts.length" class="empty-filter">
      <Search :size="30" />
      <h3>没有找到匹配的账号</h3>
      <p>试试其他关键词，或清除筛选条件。</p>
      <button class="button" @click="clearFilters"><FilterX :size="14" />清除筛选</button>
    </div>
    <div v-else class="pool-empty">
      <div class="empty-illustration" aria-hidden="true">
        <span class="empty-node left"><Cloud :size="20" /></span><span class="empty-path" /><span
          class="empty-main"
          ><UsersRound :size="29" /></span
        ><span class="empty-path" /><span class="empty-node right"><Plus :size="20" /></span>
      </div>
      <span class="eyebrow">YOUR POOL STARTS HERE</span>
      <h2>从第一个账号开始</h2>
      <p>
        完成 ZCode 登录授权后，刷新资格并选择套餐领取，<br
          class="desktop-only"
        />网关自动管理账号与请求分配。
      </p>
      <button class="button primary" @click="startOnboard()"><Plus :size="16" />登录第一个账号</button>
      <div class="empty-steps">
        <span><b>1</b>登录授权</span><ArrowRight :size="13" /><span><b>2</b>查看套餐并领取</span
        ><ArrowRight :size="13" /><span><b>3</b>统一 API 调用</span>
      </div>
    </div>
    <footer v-if="accounts.length" class="table-footer">
      <span
        >{{ selected.size ? `已选择 ${selected.size} 个账号` : `共 ${filtered.length} 个账号`
        }}<span class="footer-dot">·</span>每页 10 条</span
      >
      <div class="pagination">
        <button class="button" :disabled="page <= 1" @click="page--">上一页</button
        ><span
          >{{ page }}<small>/ {{ pages }}</small></span
        ><button class="button" :disabled="page >= pages" @click="page++">下一页</button>
      </div>
    </footer>
  </section>
  <div class="pool-bottom-grid">
    <section class="routing-note">
      <span class="note-icon"><Waypoints /></span>
      <div>
        <strong>一个入口，自动找到可用账号</strong>
        <p>加权随机选号 + 会话粘性 + 全冷却兜底，按账号分池调度。</p>
        <button class="text-link" @click="emit('navigate', 'routing')">
          查看网关设置<ArrowRight :size="13" />
        </button>
      </div>
      <span class="note-decoration">↗</span>
    </section>
    <section class="endpoint-note">
      <span class="eyebrow">READY FOR YOUR CLIENT</span><strong>兼容你正在使用的工具</strong>
      <p>OpenAI & Anthropic 双协议，一份网关 Key。</p>
      <div>
        <span class="protocol-tag">OpenAI</span><span class="protocol-tag">Anthropic</span
        ><button class="text-link" @click="emit('navigate', 'access')">
          获取接入配置<ArrowUpRight :size="13" />
        </button>
      </div>
    </section>
  </div>
  <AccountDialog v-if="showEditor" :account="editingAccount" @close="showEditor = false" />
  <ClaimDetailsDialog
    v-if="detailsAccount"
    :account="detailsAccount"
    :initial-plan-id="detailsPlanId"
    :refreshing="!!refreshProgress"
    :busy="busy.has(detailsAccount.id)"
    @close="detailsAccountId = null"
    @refresh="refreshQualifications([detailsAccount.id])"
    @claim="claimFromDetails"
  />
  <OnboardDialog
    v-if="showOnboard"
    :target="onboardAccount"
    :initial-provider="onboardProvider"
    @close="showOnboard = false"
  />
  <ModalShell
    v-if="managing"
    :title="managing.name"
    :subtitle="managing.identity ?? managing.uid"
    @close="managingId = null"
    ><div class="modal-body account-actions-grid">
      <button @click="edit(managing)">
        <Pencil :size="19" /><strong>编辑账号</strong
        ><small>修改显示身份、备注与调度权重</small></button
      ><button :disabled="busy.has(managing.id)" @click="manageEnable">
        <CircleCheck v-if="!managing.enabled" :size="19" /><X v-else :size="19" /><strong>{{
          !managing.enabled ? '启用账号' : '停用账号'
        }}</strong
        ><small>{{
          !managing.enabled
            ? '允许账号参与自动调度'
            : '彻底退出调度（含全冷却兜底）'
        }}</small></button
      ><button
        :disabled="busy.has(managing.id)"
        @click="manageAction('quota')"
      >
        <Wallet :size="19" /><strong>活动与套餐详情</strong
        ><small>查看账号、活动时间与额度，再选择领取</small></button
      ><button
        :disabled="busy.has(managing.id) || !managing.enabled"
        @click="manageAction('probe')"
      >
        <Activity :size="19" /><strong>连通自检</strong
        ><small>真实调用一次上游推理</small></button
      ><button @click="startOnboard(managing)">
        <Cloud :size="19" /><strong>重新登录授权</strong
        ><small>更新授权并自动刷新资格与额度</small></button
      >
    </div></ModalShell
  >
</template>

