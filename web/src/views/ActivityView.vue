<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  Search,
  RefreshCw,
  ArrowUpRight,
  ScrollText,
  X,
  LoaderCircle,
  Download,
} from '@lucide/vue'
import { api } from '../api'
import { useConsole, time, number, copy, logPath, LOG_PAGE_SIZE } from '../console'
import type { LogChannel, LogEntry } from '../types'
import ModalShell from '../components/ModalShell.vue'
const props = withDefaults(defineProps<{ channel?: LogChannel }>(), { channel: 'requests' })
const { logStreams, logPages, refreshLogs } = useConsole()
const logs = computed(() => logStreams[props.channel].value)
const total = computed(() => logPages[props.channel].value.total)
const pageInfo = computed(() => ({
  title: '请求日志',
  english: 'API REQUESTS',
  description: '仅显示经过网关的 API 请求，保留最近记录。',
}))
const search = ref('')
const searchQuery = ref('')
let searchTimer: number | undefined
const kind = ref('all')
const outcome = ref<'all' | 'success' | 'failure'>('all')
const page = ref(1)
const selected = ref<LogEntry | null>(null)
const refreshing = computed(
  () => logPages[props.channel].value.loading || search.value !== searchQuery.value,
)
const successful = (log: LogEntry) => log.ok === true || (log.status >= 200 && log.status < 400)
const pages = computed(() => Math.max(1, Math.ceil(total.value / LOG_PAGE_SIZE)))
const rows = logs
const query = computed(() => ({
  offset: (page.value - 1) * LOG_PAGE_SIZE,
  q: searchQuery.value,
  outcome: outcome.value,
  kind: kind.value,
}))
function bytes(value: number) {
  if (value < 1024) return `${number(value)} B`
  const unit = value < 1024 * 1024 ? 'KiB' : 'MiB'
  const divisor = unit === 'KiB' ? 1024 : 1024 * 1024
  return `${(value / divisor).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${unit}`
}
function copyDetails() {
  if (!selected.value) return
  void copy(JSON.stringify(selected.value, null, 2))
}
function exportLogs() {
  if (!total.value || refreshing.value) return
  const link = document.createElement('a')
  link.href = `/api${logPath(props.channel, query.value, true)}`
  link.download = `${props.channel}-logs-${new Date().toISOString().replaceAll(':', '-')}.json`
  document.body.append(link)
  link.click()
  link.remove()
}
function closeDetails() {
  selected.value = null
}
function openDetails(log: LogEntry) {
  selected.value = log
}
watch(search, (value) => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchQuery.value = value
  }, 200)
})
onBeforeUnmount(() => window.clearTimeout(searchTimer))
watch(
  [searchQuery, kind, outcome],
  () => {
    page.value = 1
  },
  { flush: 'sync' },
)
async function refresh() {
  await refreshLogs(props.channel, query.value)
}
watch([query, () => props.channel], refresh, { immediate: true })
watch([pages, refreshing], ([count, busy]) => {
  if (!busy && page.value > count) page.value = count
})
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />{{ pageInfo.english }}</div>
      <h1>{{ pageInfo.title }}</h1>
      <p>{{ pageInfo.description }}</p>
    </div>
    <button class="button" :disabled="refreshing" @click="refresh">
      <RefreshCw :size="15" :class="{ spin: refreshing }" />刷新记录
    </button>
  </div>
  <section class="pool-panel">
    <div class="table-toolbar">
      <div class="search-field">
        <Search :size="16" /><input
          v-model="search"
          placeholder="搜索账号、模型、密钥、IP 或消息…"
          aria-label="搜索事件"
        /><button v-if="search" class="icon-button" aria-label="清空搜索" @click="search = ''">
          <X :size="13" />
        </button>
      </div>
      <select v-model="outcome" class="filter-select" aria-label="请求结果">
        <option value="all">全部请求</option>
        <option value="success">成功请求</option>
        <option value="failure">失败请求</option>
      </select>
      <button
        class="button"
        :disabled="refreshing || !total"
        :title="`导出当前筛选的 ${total} 条记录`"
        @click="exportLogs"
      >
        <Download :size="15" />导出筛选记录
      </button>
    </div>
    <div v-if="rows.length" class="table-scroll">
      <table class="activity-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>账号 / 模型</th>
            <th>结果</th>
            <th>详情</th>
            <th class="right-align">耗时</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in rows" :key="log.id">
            <td class="mono">{{ time(log.at, true) }}</td>
            <td>
              <span class="event-type request">API 请求</span>
            </td>
            <td>
              <strong>{{ log.accountName }}</strong
              ><span v-if="log.model" class="cell-secondary mono">{{ log.model }}</span>
            </td>
            <td>
              <span class="http-status" :class="successful(log) ? 'ok' : 'failed'"
                ><i />{{ log.status }}</span
              >
            </td>
            <td class="event-message" :title="log.message">
              {{ log.message }}
              <span v-if="log.tokenUsage" class="cell-secondary"
                >入 {{ number(log.tokenUsage.input) }} / 出 {{ number(log.tokenUsage.output) }} /
                缓存 {{ number(log.tokenUsage.cacheRead) }}</span
              >
            </td>
            <td class="right-align mono">
              {{ log.durationMs != null ? `${number(log.durationMs)} ms` : '—' }}
            </td>
            <td>
              <button class="icon-button" aria-label="查看事件详情" @click="openDetails(log)">
                <ArrowUpRight :size="16" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="refreshing" class="empty-filter" role="status">
      <LoaderCircle :size="30" class="spin" />
      <h3>正在读取日志</h3>
    </div>
    <div v-else class="empty-filter">
      <ScrollText :size="30" />
      <h3>{{ search || outcome !== 'all' ? '没有匹配的记录' : '暂无请求日志' }}</h3>
      <p>
        {{
          search || outcome !== 'all' ? '试试其他关键词或筛选条件。' : pageInfo.description
        }}
      </p>
    </div>
    <footer class="table-footer">
      <span>共 {{ total }} 条记录</span>
      <div class="pagination">
        <button class="button" :disabled="page <= 1" @click="page--">上一页</button
        ><span
          >{{ page }}<small>/ {{ pages }}</small></span
        ><button class="button" :disabled="page >= pages" @click="page++">下一页</button>
      </div>
    </footer>
  </section>
  <ModalShell
    v-if="selected"
    title="API 请求详情"
    :subtitle="time(selected.at, true)"
    @close="closeDetails"
    ><div class="modal-body">
      <dl class="detail-list">
        <div>
          <dt>事件类型</dt>
          <dd>API 请求</dd>
        </div>
        <div>
          <dt>账号</dt>
          <dd>{{ selected.accountName }}</dd>
        </div>
        <div>
          <dt>HTTP 状态</dt>
          <dd>{{ selected.status }}</dd>
        </div>
        <div v-if="selected.model">
          <dt>模型</dt>
          <dd class="mono">{{ selected.model }}</dd>
        </div>
        <div v-if="selected.ip">
          <dt>来源 IP</dt>
          <dd class="mono wrap-anywhere">{{ selected.ip }}</dd>
        </div>
        <div v-if="selected.durationMs != null">
          <dt>完整耗时</dt>
          <dd>{{ number(selected.durationMs) }} ms</dd>
        </div>
        <div v-if="selected.err">
          <dt>错误</dt>
          <dd class="mono wrap-anywhere">{{ selected.err }}</dd>
        </div>
        <div v-if="selected.tokenUsage" class="detail-wide">
          <dt>Token 用量</dt>
          <dd>
            输入 {{ number(selected.tokenUsage.input) }} · 输出
            {{ number(selected.tokenUsage.output) }} · 缓存读
            {{ number(selected.tokenUsage.cacheRead) }} · 缓存写
            {{ number(selected.tokenUsage.cacheWrite) }} · 合计
            {{ number(selected.tokenUsage.total) }}
          </dd>
        </div>
        <div class="detail-wide">
          <dt>事件说明</dt>
          <dd>{{ selected.message }}</dd>
        </div>
      </dl>
    </div>
    <footer class="modal-footer">
      <span />
      <div class="button-group">
        <button class="button" @click="copyDetails">复制详情</button
        ><button class="button primary" @click="closeDetails">关闭</button>
      </div>
    </footer></ModalShell
  >
</template>
