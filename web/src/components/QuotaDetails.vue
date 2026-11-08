<script setup lang="ts">
import { computed } from 'vue'
import { number, time } from '../console'
import { visibleQuotaSources } from '../quota'
import type { QuotaSource } from '../types'
const props = defineProps<{ sources: QuotaSource[]; refreshing?: boolean }>()
const emit = defineEmits<{ reauthorize: [provider: 'zai' | 'bigmodel'] }>()
const visibleSources = computed(() => visibleQuotaSources(props.sources))
const queriedSources = computed(() => props.sources.filter((source) => source.status !== 'pending'))
const hasFailure = computed(() => queriedSources.value.some((source) => source.status === 'error' || source.status === 'unconfigured'))
const recoveries = computed(() => props.sources.flatMap((source) => source.recovery ? [source.recovery] : []))
const shortDate = (value: string) => new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
</script>

<template>
  <div v-for="recovery in recoveries" :key="recovery.provider" class="quota-auth-notice" role="status">
    <span>{{ recovery.message }}</span>
    <button type="button" class="text-link small-link" :disabled="refreshing" @click="emit('reauthorize', recovery.provider)">
      {{ refreshing ? '正在刷新额度…' : '重新授权' }}
    </button>
  </div>
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
        <div class="quota-items" :class="{ 'quota-percent-items': plan.items.every(item => item.display === 'percent') }">
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
  <details v-if="queriedSources.length" class="quota-query-details quota-updated">
    <summary>额度查询详情<span v-if="hasFailure"> · 有项目未查到</span></summary>
    <section v-for="source in queriedSources" :key="source.id">
      <strong>{{ source.name }}</strong>
      <div v-if="source.error">{{ source.error }}</div>
      <div v-else-if="!source.plans.some(plan => plan.items.length)">本次查询未返回额度项</div>
      <div v-else>已读取 {{ source.plans.reduce((count, plan) => count + plan.items.length, 0) }} 项额度</div>
      <template v-if="source.diagnostics">
        <div>OAuth {{ source.diagnostics.credentials.oauth ? '已保存' : '缺失' }} · 自动 Key {{ source.diagnostics.credentials.savedKey ? '已保存' : '无历史记录' }} · 手填 Key {{ source.diagnostics.credentials.manualKey ? '已配置' : '未配置' }}</div>
        <div v-for="(step, index) in source.diagnostics.steps" :key="index">
          {{ step.resource }}<span v-if="step.credential">（{{ step.credential }}）</span>：
          {{ step.status === 'ready' ? '成功' : step.status === 'skipped' ? '未执行' : '失败' }}
          <span v-if="step.httpStatus != null"> · HTTP {{ step.httpStatus }}</span>
          <span v-if="step.code != null"> · 业务码 {{ step.code }}</span>
          <span v-if="step.count != null"> · {{ step.count }} 项</span>
          <span v-if="step.error"> · {{ step.error }}</span>
        </div>
        <div>额度查询于 {{ time(source.diagnostics.checkedAt, true) }}</div>
      </template>
    </section>
  </details>
</template>
