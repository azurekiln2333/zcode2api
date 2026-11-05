<script setup lang="ts">
import { number, time } from '../console'
import type { QuotaSource } from '../types'
defineProps<{ sources: QuotaSource[] }>()
</script>

<template>
  <div class="quota-details">
    <section v-for="source in sources" :key="source.id" class="quota-source">
      <strong class="quota-source-name">{{ source.name }}</strong>
      <span v-if="source.status === 'pending'" class="quota-sync-state">等待查询，可点击刷新资格</span>
      <span v-if="source.error" class="quota-sync-state" :class="{ error: source.status === 'error' }">
        {{ source.error }}{{ source.syncedAt ? ' · 以下为上次成功数据' : '' }}
      </span>
      <span v-if="source.status === 'ready' && !source.plans.length" class="quota-sync-state">未返回生效套餐</span>
      <div v-for="plan in source.plans" :key="plan.id" class="quota-plan">
        <div class="quota-plan-name" :title="plan.id">{{ plan.name }}</div>
        <span v-if="plan.endsAt" class="quota-updated">到期 {{ time(plan.endsAt, true) }}</span>
        <span v-if="!plan.items.length" class="quota-sync-state">未返回额度明细</span>
        <div v-for="item in plan.items" :key="item.id" class="quota-item">
          <span class="quota-item-name">{{ item.name }}</span>
          <div class="quota-numbers">
            <strong>{{ number(item.remaining, 1) }}</strong>
            <span>/ {{ number(item.total, 1) }} {{ item.unit }}</span>
            <span>{{ item.remainingPercent === null ? '比例未知' : `${number(item.remainingPercent, 1)}%` }}</span>
          </div>
          <div v-if="item.remainingPercent !== null" class="quota-track" role="progressbar"
            :aria-label="`${source.name} ${plan.name} ${item.name} 剩余比例`"
            :aria-valuenow="item.remainingPercent" :aria-valuemin="0" :aria-valuemax="100">
            <i :class="{ low: item.remainingPercent < 15 }" :style="{ width: `${item.remainingPercent}%` }" />
          </div>
          <span v-if="item.resetAt" class="quota-updated">重置 {{ time(item.resetAt, true) }}</span>
        </div>
      </div>
      <span v-if="source.syncedAt" class="quota-updated">更新于 {{ time(source.syncedAt, true) }}</span>
    </section>
  </div>
</template>
