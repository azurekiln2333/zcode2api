<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { Gift, LoaderCircle, Save } from '@lucide/vue'
import { api } from '../api'
import { notify, useConsole } from '../console'
import type { ClaimAutomation } from '../types'

const { overview, refresh, batchClaim, captchaState } = useConsole()
const defaults = { enabled: false, time: '09:00', timezone: 'Asia/Shanghai' }
const state = computed(() => overview.value?.claimAutomation)
const saved = ref({ ...(state.value?.settings ?? defaults) })
const form = reactive({ ...saved.value })
const saving = ref(false)
const operating = ref(false)
const error = ref('')
const dirty = computed(() => form.enabled !== saved.value.enabled || form.time !== saved.value.time || form.timezone !== saved.value.timezone)
const run = computed(() => state.value?.lastRun)
const labels = { running: '执行中', stopping: '正在停止', completed: '已完成', cancelled: '已停止', interrupted: '重启中断', failed: '执行失败' }
let timer: number | undefined
watch(state, (value) => {
  if (!value) return
  const changed = dirty.value
  saved.value = { ...value.settings }
  if (!changed) Object.assign(form, saved.value)
  clearInterval(timer)
  timer = value.running ? window.setInterval(() => void refresh(), 3000) : undefined
}, { immediate: true })
onUnmounted(() => clearInterval(timer))
const date = (value: string | null | undefined) => {
  if (!value) return '—'
  try { return new Intl.DateTimeFormat('zh-CN', { timeZone: saved.value.timezone, dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)) }
  catch { return value }
}
function update(value: ClaimAutomation) {
  if (overview.value) overview.value = { ...overview.value, claimAutomation: value }
}
async function save() {
  saving.value = true
  error.value = ''
  try {
    const value = await api<ClaimAutomation>('/claim-automation', 'PATCH', { ...form })
    saved.value = { ...value.settings }
    Object.assign(form, value.settings)
    update(value)
    notify('每日定时领取设置已保存')
  } catch (e) { error.value = e instanceof Error ? e.message : '保存失败' }
  finally { saving.value = false }
}
async function operate(operation: 'run' | 'cancel') {
  operating.value = true
  error.value = ''
  try { update(await api<ClaimAutomation>(`/claim-automation/${operation}`, 'POST', {})) }
  catch (e) { error.value = e instanceof Error ? e.message : '操作失败' }
  finally { operating.value = false }
}
</script>

<template>
  <section class="section-panel auto-claim-panel">
    <header class="section-heading">
      <Gift :size="20" />
      <div><h2>每日定时领取</h2><p>每天检测已启用账号的套餐资格，有可领取套餐时自动领取。关闭网页后继续执行。</p></div>
    </header>
    <form @submit.prevent="save">
      <label class="affinity-toggle">
        <input v-model="form.enabled" type="checkbox" />
        <span><strong>开启每日检测与领取</strong><small>使用官方无感验证；需要人工验证的账号会记入结果，可到账号管理中领取。</small></span>
      </label>
      <div class="auto-claim-fields">
        <label><span>每天执行时间</span><input v-model="form.time" aria-label="每天执行时间" type="time" required /></label>
        <label><span>执行时区</span><input v-model="form.timezone" aria-label="执行时区" list="claim-timezones" required maxlength="80" /></label>
        <datalist id="claim-timezones"><option value="Asia/Shanghai" /><option value="UTC" /><option value="Asia/Tokyo" /><option value="America/New_York" /><option value="Europe/London" /></datalist>
      </div>
      <p class="subtle">每个时区日期最多执行一轮；开启或重启时若已过设定时间且当天未执行，将补跑一次。</p>
      <div class="claim-batch-heading">
        <span class="subtle">下次执行：{{ state?.settings.enabled ? date(state.nextRunAt) : '未开启' }} · {{ saved.timezone }}</span>
        <div class="auto-claim-actions">
          <button v-if="state?.running" type="button" class="button" :disabled="operating || run?.status === 'stopping'" @click="operate('cancel')">停止本轮</button>
          <button v-else type="button" class="button" :disabled="operating || saving || dirty || !!batchClaim?.running || captchaState !== 'idle' || !overview?.accounts.some(a => a.enabled)" @click="operate('run')">立即检测并领取</button>
          <button class="button primary" :disabled="saving || !dirty"><LoaderCircle v-if="saving" :size="15" class="spin" /><Save v-else :size="15" />保存定时领取</button>
        </div>
      </div>
    </form>
    <p v-if="error || state?.error" class="form-error" role="alert">{{ error || state?.error }}</p>
    <details v-if="run" class="claim-run-results" :open="state?.running || undefined">
      <summary>{{ run.source === 'scheduled' ? '定时任务' : '立即执行' }} · {{ labels[run.status] }} · {{ run.done }}/{{ run.total }} 个账号 · 成功领取 {{ run.results.filter(r => r.status === 'claimed').length }} 个套餐</summary>
      <p class="subtle">开始于 {{ date(run.startedAt) }}<template v-if="run.finishedAt"> · 结束于 {{ date(run.finishedAt) }}</template><template v-if="run.accountName"> · 正在处理 {{ run.accountName }}</template></p>
      <p v-if="run.error" class="form-error">{{ run.error }}</p>
      <div class="claim-result-list">
        <div v-for="(result, index) in run.results" :key="index" class="claim-result-row">
          <strong>{{ result.accountName }}</strong><span>{{ result.planName || '资格检测' }}</span><span :class="{ 'success-text': result.status === 'claimed' }">{{ result.message }}</span>
        </div>
      </div>
    </details>
  </section>
</template>
