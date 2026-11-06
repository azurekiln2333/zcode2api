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
  Coins,
  Wallet,
} from '@lucide/vue'
import { number, compact, useConsole, accountState, time } from '../console'
import { abbreviateCount } from '../format'
import { summarizeQuota, visibleQuotaSources } from '../quota'
import type { TokenTotals } from '../types'
import QuotaDetails from '../components/QuotaDetails.vue'
const emit = defineEmits<{ navigate: [page: 'accounts'] }>()
const { overview, accounts, lastUpdated, refreshQualifications, refreshProgress } = useConsole()
const tokenPeriod = ref<'today' | 'total'>('today')
const credits = computed(() => summarizeQuota(accounts.value))
const quotaAccounts = computed(() => accounts.value.filter((account) =>
  visibleQuotaSources(account.quotaSources || []).length > 0,
))
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
  if (!credits.value.organizations) return '点击刷新资格，读取各账号的套餐额度。'
  return `已读取 ${credits.value.organizations} 个账号的套餐额度 · 后台每 10 分钟查询`
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
const ranked = computed(() =>
  accounts.value
    .map((a) => ({
      ...a,
      today:
        overview.value?.hourly
          .filter((b) => Date.parse(b.at) >= today.value)
          .reduce((n, b) => n + (b.accounts[a.id] || 0), 0) ?? 0,
    }))
    .sort((a, b) => b.today - a.today)
    .slice(0, 5),
)
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
        <h2 id="overview-credits-summary-heading">账号剩余额度</h2>
        <span class="stat-icon amber"><Wallet :size="19" /></span>
      </div>
      <div class="overview-summary-value">
        <strong>{{ credits.plans }}</strong><span>个套餐 · {{ credits.organizations }} 个账号</span>
      </div>
      <button class="text-link" :disabled="!!refreshProgress || !accounts.length" @click="refreshQualifications()">
        {{ refreshProgress ? `刷新中 ${refreshProgress.done}/${refreshProgress.total}` : '刷新资格与额度' }}
      </button>
      <div v-if="quotaAccounts.length" class="overview-quota-list">
        <details v-for="account in quotaAccounts" :key="account.id">
          <summary>{{ account.name }}</summary>
          <QuotaDetails :sources="account.quotaSources || []" />
        </details>
      </div>
      <p class="overview-summary-state">{{ creditSummaryStatus }}</p>
      <p class="overview-summary-note">{{ credits.errors ? `${credits.errors} 个来源查询失败，请查看账号明细` : '各来源、套餐、模型与周期分别展示' }}</p>
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
</template>
