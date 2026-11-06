<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ArrowUpRight,
  Activity,
  Timer,
  CircleCheck,
  UsersRound,
  Radio,
  ArrowRight,
  RefreshCw,
  Coins,
  Wallet,
} from '@lucide/vue'
import { number, compact, useConsole, accountState, time } from '../console'
import { abbreviateCount } from '../format'
import { summarizeQuota } from '../quota'
import { summarizeOverviewQuota } from '../overview-quota'
import type { TokenTotals } from '../types'
import AccountQuotaCard from '../components/AccountQuotaCard.vue'
const emit = defineEmits<{ navigate: [page: 'accounts'] }>()
const { overview, accounts, lastUpdated, refreshQualifications, refreshProgress } = useConsole()
const tokenPeriod = ref<'today' | 'total'>('today')
const credits = computed(() => summarizeQuota(accounts.value))
const quotaAccounts = computed(() => accounts.value.map((account) => ({
  account, quota: summarizeOverviewQuota(account.quotaSources || []),
})))
const poolQuota = computed(() => summarizeOverviewQuota(accounts.value.flatMap((account) => account.quotaSources || [])))
const short = (value: number | null) => value === null ? '—' : abbreviateCount(value) || number(value, 1)
const tokens = computed(() => overview.value?.stats.tokenUsage?.[tokenPeriod.value])
const todayTokens = computed(() => overview.value?.stats.tokenUsage?.today)
const tokenNumber = (usage: TokenTotals | null | undefined, key: keyof TokenTotals) =>
  number(usage?.[key])
// Short magnitude beside the exact count, e.g. 23,019,762 → 23.02M.
const tokenShort = (usage: TokenTotals | null | undefined, key: keyof TokenTotals) =>
  abbreviateCount(usage?.[key])
const tokenSummaryStatus = computed(() => {
  const usage = todayTokens.value
  if (!usage || (!usage.reportedRequests && !usage.missingRequests && !usage.total))
    return '今日暂无请求，调用统一入口后自动统计。'
  return `${number(usage.reportedRequests)} 次请求已计入统计。`
})
const creditSummaryStatus = computed(() => {
  if (poolQuota.value.stale) return '部分账号更新失败，当前显示上次额度。'
  if (!credits.value.organizations) return '点击刷新资格，读取各账号的套餐额度。'
  return `已查询 ${credits.value.organizations} 个账号 · ${poolQuota.value.plans} 个套餐`
})
const tokenMetrics = [
  { key: 'input', label: '输入 Tokens', hint: '包含缓存读取与写入' },
  { key: 'output', label: '输出 Tokens', hint: '模型生成的内容' },
  { key: 'cacheRead', label: '缓存读取', hint: '输入中命中缓存的部分' },
  { key: 'cacheWrite', label: '缓存写入', hint: '输入中创建缓存的部分' },
  { key: 'total', label: 'Tokens 合计', hint: '输入 + 输出' },
] as const
const today = computed(() => {
  const now = lastUpdated.value?.getTime() ?? Date.now()
  return Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
})
const buckets = computed(() =>
  Array.from({ length: 24 }, (_, i) => {
    const b = overview.value?.hourly.find((h) => Date.parse(h.at) === today.value + i * 3600000)
    return { hour: i, requests: b?.requests ?? 0, errors: b?.errors ?? 0 }
  }),
)
const metric = ref<'requests' | 'errors'>('requests')
const max = computed(() => Math.max(4, ...buckets.value.map((b) => b[metric.value])))
const points = computed(() =>
  buckets.value.map((b, i) => `${42 + i * 35},${205 - (b[metric.value] / max.value) * 170}`),
)
const line = computed(() => `M${points.value.join(' L')}`)
const area = computed(() => `${line.value} L847,205 L42,205 Z`)
const chartHasData = computed(() => buckets.value.some((b) => b.requests > 0))
const states = computed(() => [
  {
    label: '可用',
    count: accounts.value.filter((a) => accountState(a) === 'healthy').length,
    class: 'green',
  },
  {
    label: '待接入 / 离线',
    count: accounts.value.filter((a) => ['pending', 'offline'].includes(accountState(a))).length,
    class: 'gray',
  },
  {
    label: '冷却中',
    count: accounts.value.filter((a) => accountState(a) === 'cooling').length,
    class: 'amber',
  },
  { label: '已停用', count: accounts.value.filter((a) => !a.enabled).length, class: 'slate' },
])
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />AT A GLANCE</div>
      <h1>
        运行概览<span class="live-label"><i class="status-dot green" />实时同步</span>
      </h1>
    </div>
    <button class="button" @click="emit('navigate', 'accounts')">
      管理账号池<ArrowUpRight :size="15" />
    </button>
  </div>
  <div class="overview-summary-grid">
    <section
      class="stat-card overview-summary-card token-summary-card"
      aria-labelledby="overview-token-summary-heading"
    >
      <div class="stat-top">
        <h2 id="overview-token-summary-heading">今日 Token 用量</h2>
        <span class="stat-icon blue"><Coins :size="19" /></span>
      </div>
      <div class="overview-summary-value">
        <strong>{{ tokenNumber(todayTokens, 'total') }}</strong
        ><span>Tokens</span>
        <small v-if="tokenShort(todayTokens, 'total')">约 {{ tokenShort(todayTokens, 'total') }}</small>
      </div>
      <dl class="overview-summary-breakdown">
        <div>
          <dt>输入</dt>
          <dd>{{ tokenNumber(todayTokens, 'input') }}</dd>
          <small v-if="tokenShort(todayTokens, 'input')" class="usage-short">约 {{ tokenShort(todayTokens, 'input') }}</small>
        </div>
        <div>
          <dt>输出</dt>
          <dd>{{ tokenNumber(todayTokens, 'output') }}</dd>
          <small v-if="tokenShort(todayTokens, 'output')" class="usage-short">约 {{ tokenShort(todayTokens, 'output') }}</small>
        </div>
        <div>
          <dt>缓存读取</dt>
          <dd>{{ tokenNumber(todayTokens, 'cacheRead') }}</dd>
          <small v-if="tokenShort(todayTokens, 'cacheRead')" class="usage-short">约 {{ tokenShort(todayTokens, 'cacheRead') }}</small>
        </div>
        <div>
          <dt>缓存写入</dt>
          <dd>{{ tokenNumber(todayTokens, 'cacheWrite') }}</dd>
          <small v-if="tokenShort(todayTokens, 'cacheWrite')" class="usage-short">约 {{ tokenShort(todayTokens, 'cacheWrite') }}</small>
        </div>
      </dl>
      <p class="overview-summary-state">{{ tokenSummaryStatus }}</p>
      <p class="overview-summary-note">缓存已包含在输入中 · 今日按 UTC+8 统计</p>
    </section>
    <section
      class="stat-card overview-summary-card credits-summary-card"
      aria-labelledby="overview-credits-summary-heading"
    >
      <div class="stat-top">
        <h2 id="overview-credits-summary-heading">{{ poolQuota.mode === 'percent' ? '综合剩余额度' : '剩余总额度' }}</h2>
        <span class="stat-icon amber"><Wallet :size="19" /></span>
      </div>
      <div class="overview-summary-value">
        <strong :title="poolQuota.mode === 'amount' ? number(poolQuota.remaining, 1) : undefined">{{
          poolQuota.mode === 'amount' ? short(poolQuota.remaining) : poolQuota.percent === null ? '—' : number(poolQuota.percent, 1)
        }}</strong>
        <span>{{ poolQuota.mode === 'amount' ? poolQuota.unit : poolQuota.percent === null ? '' : '%' }}</span>
        <span v-if="poolQuota.mode === 'amount' && poolQuota.percent !== null">剩余 {{ number(poolQuota.percent, 1) }}%</span>
      </div>
      <dl class="overview-summary-breakdown">
        <div>
          <dt>{{ poolQuota.mode === 'percent' ? '额度项' : '已使用' }}</dt>
          <dd :title="poolQuota.mode === 'amount' ? number(poolQuota.used, 1) : undefined">{{ poolQuota.mode === 'percent' ? poolQuota.items : short(poolQuota.used) }}</dd>
        </div>
        <div>
          <dt>{{ poolQuota.mode === 'percent' ? '总套餐数' : poolQuota.partial ? '已知总额度' : '总额度' }}</dt>
          <dd :title="poolQuota.mode === 'amount' ? number(poolQuota.total, 1) : undefined">{{ poolQuota.mode === 'percent' ? poolQuota.plans : short(poolQuota.total) }}</dd>
        </div>
        <div><dt>已查询账号</dt><dd>{{ credits.organizations }}</dd></div>
        <div><dt>账号总数</dt><dd>{{ accounts.length }}</dd></div>
      </dl>
      <p class="overview-summary-state" :class="{ 'quota-error-text': poolQuota.stale }">{{ creditSummaryStatus }}</p>
      <p class="overview-summary-note">{{ poolQuota.mode === 'percent' ? '综合比例为各额度项剩余比例的平均值' : poolQuota.partial ? '当前汇总已知额度，完整明细见账号管理' : '全部账号与套餐合计 · 后台每 10 分钟更新' }}</p>
    </section>
  </div>
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-top">
        <span>今日请求</span><span class="stat-icon blue"><Activity :size="17" /></span>
      </div>
      <div class="stat-value">{{ compact(overview!.stats.requests) }}<small>次</small></div>
      <div class="stat-bottom">{{ overview!.stats.activeRequests }} 个请求正在处理</div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>请求成功率</span><span class="stat-icon green"><CircleCheck :size="17" /></span>
      </div>
      <div class="stat-value">{{ number(overview!.stats.successRate, 1) }}<small>%</small></div>
      <div class="stat-bottom">{{ number(overview!.stats.errors) }} 次未成功完成</div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>平均请求耗时</span><span class="stat-icon amber"><Timer :size="17" /></span>
      </div>
      <div class="stat-value">{{ number(overview!.stats.averageDurationMs) }}<small>ms</small></div>
      <div class="stat-bottom">含完整流式响应时长</div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>可用账号</span><span class="stat-icon violet"><UsersRound :size="17" /></span>
      </div>
      <div class="stat-value">
        {{ overview!.stats.ready }}<small>/ {{ accounts.length }}</small>
      </div>
      <div class="stat-bottom">启用且未在冷却/降级中的账号</div>
    </div>
  </div>
  <section class="section-panel token-panel" aria-labelledby="token-usage-heading">
    <header class="chart-heading">
      <div>
        <h2 id="token-usage-heading"><Coins :size="17" />Token 用量</h2>
        <p>网关本地记录 · 今日以 UTC+8 为界</p>
      </div>
      <div class="segmented" aria-label="Token 统计范围">
        <button
          :class="{ active: tokenPeriod === 'today' }"
          :aria-pressed="tokenPeriod === 'today'"
          @click="tokenPeriod = 'today'"
        >
          今日
        </button>
        <button
          :class="{ active: tokenPeriod === 'total' }"
          :aria-pressed="tokenPeriod === 'total'"
          @click="tokenPeriod = 'total'"
        >
          累计
        </button>
      </div>
    </header>
    <div class="token-metrics">
      <div v-for="item in tokenMetrics" :key="item.key" class="token-metric">
        <span>{{ item.label }}</span>
        <strong>{{ tokenNumber(tokens, item.key) }}</strong>
        <em v-if="tokenShort(tokens, item.key)" class="usage-short">约 {{ tokenShort(tokens, item.key) }}</em>
        <small>{{ item.hint }}</small>
      </div>
    </div>
    <div class="token-accounting-note">
      <span>{{ number(tokens?.reportedRequests) }} 次请求已计入。</span>
      <span>缓存已包含在输入中，不重复相加。</span>
      <span v-if="overview?.stats.tokenUsage?.startedAt"
        >累计自 {{ time(overview.stats.tokenUsage.startedAt, true) }} 开始记录，重启后保留。</span
      >
    </div>
  </section>
  <div class="overview-main-grid">
    <section class="section-panel chart-panel">
      <header class="chart-heading">
        <div>
          <h2>请求流量</h2>
          <p>今日每小时请求量 · UTC+8</p>
        </div>
        <div class="segmented">
          <button :class="{ active: metric === 'requests' }" @click="metric = 'requests'">
            全部请求</button
          ><button :class="{ active: metric === 'errors' }" @click="metric = 'errors'">
            失败请求
          </button>
        </div>
      </header>
      <div class="traffic-chart">
        <svg
          viewBox="0 0 890 250"
          role="img"
          :aria-label="`今日${metric === 'requests' ? '全部' : '失败'}请求，最高每小时 ${max} 次`"
        >
          <defs>
            <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--primary)" stop-opacity=".14" />
              <stop offset="100%" stop-color="var(--primary)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <g v-for="i in 5" :key="i">
            <line
              x1="42"
              x2="847"
              :y1="35 + (i - 1) * 42.5"
              :y2="35 + (i - 1) * 42.5"
              class="chart-grid"
            />
            <text x="28" :y="39 + (i - 1) * 42.5" text-anchor="end">
              {{ Math.round((max * (5 - i)) / 4) }}
            </text>
          </g>
          <template v-if="chartHasData">
            <path :d="area" fill="url(#chart-fill)" />
            <path
              :d="line"
              fill="none"
              stroke="var(--primary)"
              stroke-width="2.5"
              stroke-linejoin="round"
            />
            <circle
              v-for="(point, i) in points"
              :key="i"
              :cx="point.split(',')[0]"
              :cy="point.split(',')[1]"
              r="3"
              fill="var(--surface)"
              stroke="var(--primary)"
              stroke-width="1.5"
            >
              <title>{{ i }}:00 · {{ buckets[i]![metric] }} 次</title>
            </circle>
          </template>
          <text
            v-for="i in [0, 4, 8, 12, 16, 20, 23]"
            :key="i"
            :x="42 + i * 35"
            y="236"
            text-anchor="middle"
          >
            {{ String(i).padStart(2, '0') }}:00
          </text>
        </svg>
        <div v-if="!chartHasData" class="chart-empty">
          <Activity :size="23" /><strong>还没有请求流量</strong
          ><span>客户端通过统一入口调用后，这里会开始记录。</span>
        </div>
      </div>
      <footer class="chart-footer">
        <span><i class="blue-dot" />{{ metric === 'requests' ? '全部请求' : '失败请求' }}</span
        ><span>每 15 秒更新</span>
      </footer>
    </section>
    <section class="section-panel pool-health">
      <header class="chart-heading">
        <div>
          <h2>号池健康度</h2>
          <p>当前账号状态分布</p>
        </div>
        <Radio :size="17" />
      </header>
      <div class="health-number">
        {{ accounts.length ? Math.round((overview!.stats.ready / accounts.length) * 100) : '—'
        }}<small>%</small><span>可用比例</span>
      </div>
      <div class="health-distribution">
        <i
          v-for="state in states"
          :key="state.label"
          :class="state.class"
          :style="{ width: `${accounts.length ? (state.count / accounts.length) * 100 : 0}%` }"
        />
      </div>
      <div class="health-legend">
        <div v-for="state in states" :key="state.label">
          <i class="status-dot" :class="state.class" /><span>{{ state.label }}</span
          ><strong>{{ state.count }}</strong>
        </div>
      </div>
      <button class="text-link" @click="emit('navigate', 'accounts')">
        查看全部账号<ArrowRight :size="13" />
      </button>
    </section>
  </div>
  <section class="overview-account-quotas" aria-labelledby="account-quotas-heading">
    <header class="account-quotas-heading">
      <div>
        <h2 id="account-quotas-heading">账号额度<span>{{ accounts.length }}</span></h2>
        <p>每个账号汇总显示，套餐明细在账号管理中查看</p>
      </div>
      <div class="account-quota-actions">
        <button class="button" :disabled="!!refreshProgress || !accounts.length" @click="refreshQualifications()">
          <RefreshCw :size="14" :class="{ spin: !!refreshProgress }" />
          {{ refreshProgress ? `刷新中 ${refreshProgress.done}/${refreshProgress.total}` : '刷新资格与额度' }}
        </button>
        <button class="text-link" @click="emit('navigate', 'accounts')">管理账号<ArrowUpRight :size="14" /></button>
      </div>
    </header>
    <div v-if="quotaAccounts.length" class="account-quota-grid">
      <AccountQuotaCard v-for="({ account, quota }, index) in quotaAccounts" :key="account.id"
        :account="account" :quota="quota" :index="index" @details="emit('navigate', 'accounts')" />
    </div>
    <div v-else class="account-quotas-empty">
      <Wallet :size="22" /><span>添加账号后，在这里查看每个账号的总额度。</span>
      <button class="text-link" @click="emit('navigate', 'accounts')">添加账号<ArrowRight :size="13" /></button>
    </div>
  </section>
</template>

<style scoped>
.overview-summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 13px;
}
.overview-summary-card {
  min-width: 0;
  padding: 12px 15px 11px;
  border-top: 2px solid var(--primary);
}
.credits-summary-card { border-top-color: var(--amber); }
.overview-summary-card h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text); }
.overview-summary-value { display: flex; align-items: baseline; flex-wrap: wrap; gap: 7px; margin: 6px 0 9px; }
.overview-summary-value strong { font-size: 30px; line-height: 1.2; font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.overview-summary-value > span { font-size: 12px; color: var(--muted); }
.overview-summary-breakdown { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px 12px; margin: 0 0 8px; }
.overview-summary-breakdown > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.overview-summary-breakdown dt { font-size: 12px; color: var(--secondary); }
.overview-summary-breakdown dd { margin: 0; font-size: 14px; font-weight: 550; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.usage-short,
.overview-summary-value > small { font-size: 11px; font-weight: 500; color: var(--secondary); font-variant-numeric: tabular-nums; }
.token-metric > em.usage-short { font-style: normal; }
.overview-summary-state { margin: 0; font-size: 12px; color: var(--secondary); line-height: 1.5; }
.overview-summary-note { margin: 3px 0 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
.overview-summary-state.quota-error-text { color: var(--amber); }
.page-heading { align-items: flex-end; gap: 12px; margin-bottom: 14px; }
.page-heading h1 { margin-top: 3px; margin-bottom: 2px; gap: 9px; font-size: 24px; letter-spacing: -.5px; }
.page-heading .eyebrow { font-size: 11px; letter-spacing: 1.3px; }
.page-heading > .button { min-height: 32px; padding: 6px 11px; font-size: 13px; }
.stats-grid { gap: 10px; margin-bottom: 13px; }
.stat-card { min-height: 0; padding: 12px 14px 11px; }
.stat-top { font-size: 12px; }
.stat-icon { width: 24px; height: 24px; }
.stat-icon svg { width: 14px; }
.stat-value { gap: 5px; margin-top: 4px; font-size: 24px; letter-spacing: -.7px; }
.stat-bottom { gap: 5px; margin-top: 6px; }
.section-panel { margin-bottom: 13px; }
.chart-heading { padding: 13px 16px 9px; gap: 12px; }
.chart-heading p { margin-top: 3px; line-height: 1.5; }
.token-metrics { gap: 12px; padding: 2px 16px 13px; }
.token-metric { gap: 5px; }
.token-metric > span { font-size: 12px; }
.token-metric > strong { font-size: clamp(20px, 1.7vw, 26px); }
.token-metric > small { font-size: 12px; }
.token-accounting-note { gap: 3px; padding: 9px 16px; font-size: 12px; line-height: 1.5; }
.traffic-chart { padding: 6px 14px 0; min-height: 184px; }
.traffic-chart > svg { min-height: 184px; }
.chart-footer { padding: 9px 16px 13px; }
.pool-health .health-number { font-size: 34px; padding: 6px 16px 10px; }
.health-number small { font-size: 17px; }
.health-number span { margin-top: 2px; }
.health-distribution { margin: 0 16px 12px; }
.health-legend { padding: 0 16px; gap: 8px 12px; }
.pool-health > .text-link { margin: 12px 16px 13px; }
.overview-main-grid { gap: 13px; }
.overview-account-quotas { margin-top: 4px; }
.account-quotas-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.account-quotas-heading h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 600; }
.account-quotas-heading h2 > span { padding: 1px 7px; background: var(--primary-soft); color: var(--primary); border-radius: var(--radius-xs); font-size: 11px; }
.account-quotas-heading p { font-size: 12px; color: var(--muted); margin: 4px 0 0; }
.account-quota-actions { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
.account-quota-actions > .button { min-height: 32px; font-size: 12px; padding: 6px 10px; }
.account-quota-actions > .text-link { font-size: 12px; }
.account-quota-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 270px), 1fr)); gap: 12px; }
.account-quotas-empty { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 12px; padding: 32px 16px; border: 1px dashed var(--line-strong); border-radius: var(--radius); color: var(--muted); font-size: 13px; }
@media (max-width: 900px) {
  .overview-summary-breakdown { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
}
@media (max-width: 600px) {
  .overview-summary-grid { grid-template-columns: minmax(0, 1fr); gap: 8px; margin-bottom: 12px; }
  .page-heading { align-items: flex-start; gap: 10px; margin-bottom: 16px; }
  .page-heading > .button { padding: 6px 9px; font-size: 12px; }
  .stat-card { padding: 11px 12px 10px; }
  .stat-value { font-size: 22px; }
  .overview-summary-value strong { font-size: 26px; }
  .overview-summary-note { font-size: 11px; }
  .account-quotas-heading { align-items: flex-start; flex-direction: column; }
  .account-quota-actions { width: 100%; justify-content: space-between; }
  .account-quota-grid { gap: 10px; }
  .chart-heading { flex-wrap: wrap; }
}
</style>
