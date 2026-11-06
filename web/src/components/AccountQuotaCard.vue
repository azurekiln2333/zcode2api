<script setup lang="ts">
import { ArrowUpRight } from '@lucide/vue'
import { number, time } from '../console'
import { abbreviateCount } from '../format'
import type { OverviewQuota } from '../overview-quota'
import type { Account } from '../types'
import StatusBadge from './StatusBadge.vue'

defineProps<{ account: Account; quota: OverviewQuota; index: number }>()
const emit = defineEmits<{ details: [] }>()
const short = (value: number | null) => value === null ? '—' : abbreviateCount(value) || number(value, 1)
</script>

<template>
  <article class="account-quota-card" :aria-label="`${account.name} 额度概览`">
    <header class="account-quota-heading">
      <span class="account-avatar" :class="`avatar-${index % 5}`" aria-hidden="true">
        {{ account.name.slice(0, 1).toUpperCase() }}
      </span>
      <div class="account-quota-identity">
        <h3 :title="account.name">{{ account.name }}</h3>
        <span :title="account.identity || account.label">{{ account.identity || account.label }}</span>
      </div>
      <StatusBadge :account="account" />
    </header>
    <div class="account-quota-label">
      <span>{{ quota.mode === 'percent' ? '综合剩余额度' : '剩余总额度' }}</span>
      <span v-if="quota.partial && quota.percent !== null" class="quota-partial">部分数据</span>
    </div>
    <div class="account-quota-value">
      <strong :title="quota.mode === 'amount' ? number(quota.remaining, 1) : undefined">
        {{ quota.mode === 'amount' ? short(quota.remaining) : quota.percent === null ? '—' : number(quota.percent, 1) }}
      </strong>
      <span>{{ quota.mode === 'amount' ? quota.unit : quota.percent === null ? '' : '%' }}</span>
      <span v-if="quota.mode === 'amount' && quota.percent !== null" class="account-quota-percent">
        {{ number(quota.percent, 1) }}%
      </span>
    </div>
    <div class="account-quota-track" :class="{ low: quota.percent !== null && quota.percent < 15 }"
      role="progressbar" :aria-label="`${account.name} 总额度剩余比例`"
      :aria-valuenow="quota.percent ?? undefined" :aria-valuemin="0" :aria-valuemax="100"
      :aria-valuetext="quota.percent === null ? '额度比例未知' : `${number(quota.percent, 1)}%`"
      :title="quota.mode === 'percent' ? '各额度项剩余比例的平均值' : '全部套餐已知剩余额度 / 已知总额度'">
      <i v-if="quota.percent !== null" :style="{ width: `${quota.percent}%` }" />
    </div>
    <div class="account-quota-meta">
      <span v-if="quota.mode === 'amount'" :title="number(quota.total, 1)">
        {{ quota.partial ? '已知总额度' : '总额度' }} {{ short(quota.total) }} {{ quota.unit }}
      </span>
      <span v-else>{{ quota.mode === 'empty' ? '暂无额度数据' : quota.percent === null ? '等待额度数据' : '按额度比例汇总' }}</span>
      <span v-if="quota.plans">{{ quota.plans }} 个套餐</span>
    </div>
    <footer class="account-quota-footer">
      <span :class="{ stale: quota.stale }" :title="quota.syncedAt ? `更新于 ${time(quota.syncedAt, true)}` : undefined">
        {{ quota.stale ? '上次额度 · 待更新' : quota.syncedAt ? `更新于 ${time(quota.syncedAt, true)}` : '刷新后显示额度' }}
      </span>
      <button class="text-link" @click="emit('details')">额度明细<ArrowUpRight :size="12" /></button>
    </footer>
  </article>
</template>

<style scoped>
.account-quota-card {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
}
.account-quota-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 17px; }
.account-avatar { width: 33px; height: 33px; font-size: 13px; flex-shrink: 0; }
.account-quota-identity { min-width: 0; flex: 1; }
.account-quota-identity h3,
.account-quota-identity > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-quota-identity h3 { font-size: 13px; font-weight: 600; margin: 0 0 3px; }
.account-quota-identity > span { display: block; font-size: 11px; color: var(--muted); }
.account-quota-heading :deep(.status-badge) { flex-shrink: 0; padding: 3px 6px; font-size: 10px; }
.account-quota-label,
.account-quota-meta,
.account-quota-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--muted); }
.quota-partial { color: var(--amber); }
.account-quota-value { display: flex; align-items: baseline; gap: 6px; margin-top: 5px; font-variant-numeric: tabular-nums; }
.account-quota-value > strong { font-size: 26px; font-weight: 650; line-height: 1.3; letter-spacing: -.6px; }
.account-quota-value > span { color: var(--muted); font-size: 11px; }
.account-quota-value > .account-quota-percent { margin-left: auto; font-size: 13px; font-weight: 550; color: var(--primary); }
.account-quota-track { height: 6px; border-radius: var(--radius-full); overflow: hidden; margin-top: 11px; background: var(--line); }
.account-quota-track > i { display: block; height: 100%; background: var(--primary); border-radius: inherit; }
.account-quota-track.low > i { background: var(--amber); }
.account-quota-meta { margin-top: 7px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.account-quota-footer { border-top: 1px solid var(--line); margin-top: 13px; padding-top: 10px; flex-wrap: wrap; }
.account-quota-footer .text-link { font-size: 11px; flex-shrink: 0; margin-left: auto; }
.account-quota-footer .stale { color: var(--amber); }
</style>
