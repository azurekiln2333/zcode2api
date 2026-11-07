<script setup lang="ts">
import { computed } from 'vue'
import { number, time } from '../console'
import { visibleQuotaSources } from '../quota'
import type { QuotaSource } from '../types'
const props = defineProps<{ sources: QuotaSource[] }>()
const visibleSources = computed(() => visibleQuotaSources(props.sources))
const shortDate = (value: string) => new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
</script>

<template>
  <div v-if="visibleSources.length" class="quota-details">
    <section v-for="source in visibleSources" :key="source.id" class="quota-source">
      <strong class="quota-source-name">{{ source.name }}</strong>
      <span v-if="source.status === 'pending'" class="quota-sync-state">等待查询，可点击刷新资格</span>
      <span v-if="source.error" class="quota-sync-state" :class="{ error: source.status === 'error' }">
        {{ source.error }}{{ source.syncedAt ? ' · 查询失败的项目保留上次数据' : '' }}
      </span>
      <div v-for="plan in source.plans" :key="plan.id" class="quota-plan">
        <div class="quota-plan-name" :title="plan.id">{{ plan.name }}</div>
        <div v-if="plan.campaign || plan.endsAt" class="quota-plan-meta">
          <span v-if="plan.campaign" class="quota-campaign" :title="plan.campaign.description">{{ plan.campaign.label }}</span>
          <span v-if="plan.endsAt" class="quota-updated" :title="time(plan.endsAt)">到期 {{ source.id === 'coding' ? shortDate(plan.endsAt) : time(plan.endsAt, true) }}</span>
        </div>
        <div class="quota-items" :class="{ 'quota-windows': source.id === 'coding' }">
          <div v-for="item in plan.items" :key="item.id" class="quota-item">
            <div class="quota-item-header">
              <span class="quota-item-name">{{ item.name }}</span>
              <span class="quota-item-percent">{{ item.remainingPercent === null ? '比例未知' : `${number(item.remainingPercent, 1)}%` }}</span>
            </div>
            <div v-if="item.display !== 'percent' && (item.remaining !== null || item.total !== null)" class="quota-numbers">
              <strong>{{ number(item.remaining, 1) }}</strong>
              <span>/ {{ number(item.total, 1) }} {{ item.unit }}</span>
            </div>
            <div v-if="item.remainingPercent !== null" class="quota-track" role="progressbar"
              :aria-label="`${source.name} ${plan.name} ${item.name} 剩余比例`"
              :aria-valuenow="item.remainingPercent" :aria-valuemin="0" :aria-valuemax="100">
              <i :class="{ low: item.remainingPercent < 15 }" :style="{ width: `${item.remainingPercent}%` }" />
            </div>
            <span v-if="item.resetAt" class="quota-updated" :title="`重置 ${time(item.resetAt)}`">重置 {{ item.resetTimeFormat === 'date' ? shortDate(item.resetAt) : time(item.resetAt, true) }}</span>
          </div>
        </div>
      </div>
      <span v-if="source.syncedAt" class="quota-updated">更新于 {{ time(source.syncedAt, true) }}</span>
    </section>
  </div>
</template>
