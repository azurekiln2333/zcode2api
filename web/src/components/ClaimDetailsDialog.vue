<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDown, Gift, RefreshCw, Zap } from '@lucide/vue'
import type { Account } from '../types'
import { claimDetails, claimGroups, formatClaimTime } from '../claim-details'
import ModalShell from './ModalShell.vue'

const props = defineProps<{ account: Account; initialPlanId?: string; refreshing: boolean; busy: boolean }>()
const emit = defineEmits<{ close: []; refresh: []; claim: [planId: string] }>()
const rows = computed(() => claimDetails(props.account.eligibility))
const selected = ref('')
watch(rows, (value) => {
  if (!value.some((row) => row.key === selected.value)) {
    selected.value = (value.find((row) => row.planId === props.initialPlanId) ?? value[0])?.key ?? ''
  }
}, { immediate: true })
const groups = computed(() => claimGroups.map((group) => ({ ...group, rows: rows.value.filter((row) => row.status === group.id) })).filter((group) => group.rows.length))
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
const periodText = (period: string) => ({ one_time: '一次性', daily: '每日', weekly: '每周', monthly: '每月' }[period] || period)
const positionText = (position: string) => ({ banner: '横幅', popup: '弹窗' }[position] || position)
</script>

<template>
  <ModalShell title="活动与套餐详情" :subtitle="`${account.name} · ${account.identity || account.label}`" wide @close="emit('close')">
    <div class="modal-body claim-details-body">
      <div class="claim-details-context">
        <span>{{ account.eligibility ? `查询于 ${formatClaimTime(account.eligibility.checkedAt)}` : '尚未查询套餐资格' }}</span>
        <span>时间：{{ timezone }}</span>
      </div>
      <p v-if="refreshing" class="claim-message" role="status"><RefreshCw :size="14" class="spin" />正在刷新资格与额度…</p>
      <p v-if="account.eligibility?.error" class="form-error" role="alert">{{ account.eligibility.error }}</p>
      <p v-if="account.eligibility?.currentError" class="form-error" role="alert">已领套餐查询失败：{{ account.eligibility.currentError }}</p>
      <p v-if="account.eligibility?.activation?.error" class="form-error">{{ account.eligibility.activation.error }}</p>
      <div v-if="!rows.length && !refreshing" class="claim-empty">
        <Gift :size="28" />
        <strong>{{ account.eligibility ? '本次没有可展示的活动或套餐' : '先查询该账号的套餐资格' }}</strong>
        <p>点击「刷新资格与额度」获取查询结果。</p>
      </div>
      <section v-for="group in groups" :key="group.id" class="claim-group">
        <h3>{{ group.label }}<span>{{ group.rows.length }}</span></h3>
        <article v-for="row in group.rows" :key="row.key" class="claim-card" :class="{ expanded: selected === row.key }">
          <button class="claim-card-heading" :aria-expanded="selected === row.key" @click="selected = selected === row.key ? '' : row.key">
            <span class="claim-card-title">{{ row.title }}</span>
            <span class="claim-state" :class="row.status">{{ row.statusText }}</span>
            <ChevronDown :size="16" :class="{ rotated: selected === row.key }" />
          </button>
          <div v-if="selected === row.key" class="claim-card-body">
            <dl class="claim-fields">
              <div><dt>状态</dt><dd>{{ row.statusText }}</dd></div>
              <div><dt>账号</dt><dd>{{ account.name }}<small>{{ account.identity || account.label }}</small></dd></div>
              <div><dt>套餐</dt><dd>{{ row.name }}</dd></div>
              <div><dt>活动开始</dt><dd>{{ formatClaimTime(row.startsAt) }}</dd></div>
              <div><dt>生效时间</dt><dd>{{ row.effectiveText }}</dd></div>
              <div><dt>结束时间</dt><dd>{{ formatClaimTime(row.endsAt) }}</dd></div>
            </dl>
            <div class="claim-rewards">
              <h4>套餐额度</h4>
              <ul v-if="row.entitlements.length">
                <li v-for="(grant, index) in row.entitlements" :key="index">
                  <span>{{ grant.model }}</span><strong>{{ grant.grant.toLocaleString('zh-CN') }} <small>Token · {{ periodText(grant.period) }}</small></strong>
                </li>
              </ul>
              <p v-else>上游未提供额度明细</p>
            </div>
            <div v-if="row.description" class="claim-copy"><h4>活动说明</h4><p>{{ row.description }}</p></div>
            <details class="claim-identifiers">
              <summary>更多信息</summary>
              <dl class="claim-fields">
                <div><dt>活动 ID</dt><dd>{{ row.campaignId }}</dd></div>
                <div><dt>套餐 ID</dt><dd>{{ row.planId }}</dd></div>
                <div><dt>展示位</dt><dd>{{ positionText(row.position) }}</dd></div>
              </dl>
            </details>
            <div v-if="row.status === 'claimable'" class="claim-confirm">
              <span>领取到 {{ account.name }}</span>
              <button class="button primary" :disabled="busy || refreshing" @click="emit('claim', row.planId)"><Zap :size="15" />领取此套餐</button>
            </div>
          </div>
        </article>
      </section>
    </div>
    <footer class="modal-footer">
      <button class="button" :disabled="refreshing || busy" @click="emit('refresh')"><RefreshCw :size="14" :class="{ spin: refreshing }" />刷新资格与额度</button>
      <button class="button" @click="emit('close')">关闭</button>
    </footer>
  </ModalShell>
</template>

<style scoped>
.claim-details-body { display: grid; gap: 18px; }
.claim-details-context { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; color: var(--muted); font-size: 12px; }
.claim-message { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--secondary); }
.claim-empty { display: grid; justify-items: center; gap: 12px; padding: 26px 0; text-align: center; color: var(--muted); }
.claim-empty strong { font-size: 14px; color: var(--text); }
.claim-empty p { font-size: 13px; }
.claim-group { display: grid; gap: 10px; }
.claim-group h3 { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--secondary); }
.claim-group h3 span { font-size: 12px; color: var(--muted); font-weight: 400; }
.claim-card { border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; }
.claim-card.expanded { border-color: var(--line-strong); }
.claim-card-heading { display: flex; align-items: center; gap: 10px; width: 100%; padding: 14px 16px; text-align: left; background: var(--surface-subtle); }
.claim-card-title { flex: 1; min-width: 0; font-weight: 550; font-size: 14px; overflow-wrap: anywhere; }
.claim-card-heading svg { flex-shrink: 0; color: var(--muted); transition: transform 0.15s; }
.claim-card-heading svg.rotated { transform: rotate(180deg); }
.claim-state { flex-shrink: 0; font-size: 11px; padding: 3px 7px; border-radius: 4px; background: var(--surface); color: var(--muted); }
.claim-state.claimable { color: var(--primary); background: color-mix(in srgb, var(--primary) 9%, var(--surface)); }
.claim-state.claimed { color: var(--secondary); }
.claim-card-body { padding: 16px; display: grid; gap: 18px; }
.claim-fields { display: grid; gap: 12px; margin: 0; }
.claim-fields > div { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 12px; font-size: 13px; line-height: 1.6; }
.claim-fields dt { color: var(--muted); }
.claim-fields dd { margin: 0; overflow-wrap: anywhere; }
.claim-fields small { display: block; color: var(--muted); font-size: 12px; }
.claim-card h4 { margin: 0 0 9px; font-size: 12px; color: var(--secondary); font-weight: 500; }
.claim-rewards ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.claim-rewards li { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; font-size: 13px; }
.claim-rewards strong { font-weight: 550; }
.claim-rewards small { color: var(--muted); font-size: 11px; font-weight: 400; }
.claim-rewards p, .claim-copy p { font-size: 13px; color: var(--secondary); line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.claim-copy { padding: 12px; background: var(--surface-subtle); border-radius: 6px; }
.claim-identifiers summary { color: var(--muted); cursor: pointer; font-size: 12px; }
.claim-identifiers .claim-fields { margin-top: 12px; }
.claim-confirm { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--line); padding-top: 14px; }
.claim-confirm > span { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.claim-confirm .button { flex-shrink: 0; }
@media (max-width: 520px) {
  .claim-card-heading, .claim-card-body { padding: 12px; }
  .claim-card-heading { flex-wrap: wrap; }
  .claim-card-title { flex-basis: 100%; }
  .claim-card-heading svg { margin-left: auto; }
  .claim-fields > div { grid-template-columns: 62px minmax(0, 1fr); gap: 8px; }
}
</style>
