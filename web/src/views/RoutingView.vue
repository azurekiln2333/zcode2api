<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  Waypoints,
  Scale,
  Check,
  Save,
  ShieldCheck,
  Timer,
  ArrowRight,
  Server,
  LoaderCircle,
  Info,
  RefreshCw,
} from '@lucide/vue'
import { api } from '../api'
import { notify, useConsole, accountState } from '../console'
import type { Settings } from '../types'

const { overview, accounts, refresh } = useConsole()

type NumericFields =
  | 'topN'
  | 'maxInFlight'
  | 'breakerThreshold'
  | 'breakerCooldownMin'
  | 'blockedCooldownMin'
  | 'quotaCooldownMin'
  | 'busyCooldownSec'
  | 'minPickGapMs'
  | 'idleWeightPerHour'
  | 'idleWeightMax'
  | 'weightBalFactor'
  | 'weightSuccFactor'
  | 'stickyTtlMin'

const NUMERIC: NumericFields[] = [
  'topN', 'maxInFlight', 'breakerThreshold', 'breakerCooldownMin', 'blockedCooldownMin',
  'quotaCooldownMin', 'busyCooldownSec', 'minPickGapMs', 'idleWeightPerHour', 'idleWeightMax',
  'weightBalFactor', 'weightSuccFactor', 'stickyTtlMin',
]
const DEFAULTS: Record<NumericFields, number> = {
  topN: 3, maxInFlight: 5, breakerThreshold: 3, breakerCooldownMin: 30, blockedCooldownMin: 10,
  quotaCooldownMin: 30, busyCooldownSec: 90, minPickGapMs: 120, idleWeightPerHour: 0.5,
  idleWeightMax: 5, weightBalFactor: 10, weightSuccFactor: 3, stickyTtlMin: 30,
}

function normalize(settings?: Settings | null) {
  const out = {} as Settings
  for (const key of NUMERIC) out[key] = Number(settings?.[key] ?? DEFAULTS[key])
  out.sessionAffinity = (settings?.stickyTtlMin ?? 30) > 0
  out.strategy = 'weighted'
  out.weekendGrab = (settings as Settings | undefined)?.weekendGrab ?? true
  out.limits = (settings as Settings | undefined)?.limits ?? {}
  return out
}
function routingFields(s: Settings) {
  const out = {} as Settings
  for (const key of NUMERIC) out[key] = s[key]
  out.sessionAffinity = s.sessionAffinity
  out.strategy = s.strategy
  out.weekendGrab = s.weekendGrab
  out.limits = s.limits
  return out
}

const saved = ref(normalize(overview.value?.settings))
const form = reactive(routingFields(saved.value))
const saving = ref(false)
const error = ref('')
const dirty = computed(
  () =>
    NUMERIC.some((key) => form[key] !== saved.value[key]) ||
    form.sessionAffinity !== saved.value.sessionAffinity,
)
watch(
  () => overview.value?.settings,
  (value) => {
    if (!value || saving.value) return
    const wasDirty = dirty.value
    saved.value = normalize(value)
    if (!wasDirty) Object.assign(form, routingFields(saved.value))
  },
)
const eligible = computed(() =>
  accounts.value
    .filter((a) => accountState(a) === 'healthy')
    .sort((a, b) => b.weight - a.weight),
)
const numericField = (key: NumericFields, label: string, hint: string, unit = '', step = '1') => {
  const [lo, hi] = (saved.value.limits?.[key] ?? [0, 99999]) as [number, number]
  return `
  <label><span>${label}<small>${hint} · 范围 ${lo}~${hi}</small></span>
  <div class="unit-input"><input data-key="${key}" type="number" min="${lo}" max="${hi}" step="${step}" required /><span>${unit}</span></div></label>`
}
// 模板通过 v-model 双绑；用显式字段声明保持类型检查通过。
const topN = computed({
  get: () => form.topN,
  set: (v: number) => (form.topN = v),
})
const maxInFlight = computed({
  get: () => form.maxInFlight,
  set: (v: number) => (form.maxInFlight = v),
})
const weightBalFactor = computed({
  get: () => form.weightBalFactor,
  set: (v: number) => (form.weightBalFactor = v),
})
const weightSuccFactor = computed({
  get: () => form.weightSuccFactor,
  set: (v: number) => (form.weightSuccFactor = v),
})
const idleWeightPerHour = computed({
  get: () => form.idleWeightPerHour,
  set: (v: number) => (form.idleWeightPerHour = v),
})
const idleWeightMax = computed({
  get: () => form.idleWeightMax,
  set: (v: number) => (form.idleWeightMax = v),
})
const minPickGapMs = computed({
  get: () => form.minPickGapMs,
  set: (v: number) => (form.minPickGapMs = v),
})
const busyCooldownSec = computed({
  get: () => form.busyCooldownSec,
  set: (v: number) => (form.busyCooldownSec = v),
})
const quotaCooldownMin = computed({
  get: () => form.quotaCooldownMin,
  set: (v: number) => (form.quotaCooldownMin = v),
})
const blockedCooldownMin = computed({
  get: () => form.blockedCooldownMin,
  set: (v: number) => (form.blockedCooldownMin = v),
})
const breakerThreshold = computed({
  get: () => form.breakerThreshold,
  set: (v: number) => (form.breakerThreshold = v),
})
const breakerCooldownMin = computed({
  get: () => form.breakerCooldownMin,
  set: (v: number) => (form.breakerCooldownMin = v),
})
const stickyTtlMin = computed({
  get: () => form.stickyTtlMin,
  set: (v: number) => (form.stickyTtlMin = v),
})
const sessionAffinity = computed({
  get: () => form.sessionAffinity,
  set: (v: boolean) => (form.sessionAffinity = v),
})

function resetDefaults() {
  for (const key of NUMERIC) form[key] = DEFAULTS[key]
  notify('已填入默认值，点「保存配置」后生效')
}
async function save() {
  error.value = ''
  saving.value = true
  try {
    const body: Record<string, number> = {}
    for (const key of NUMERIC) body[key] = Number(form[key])
    if (!form.sessionAffinity) body.stickyTtlMin = 0
    await api('/settings', 'PATCH', body)
    await refresh()
    notify('调度配置已保存并即时生效')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />TRAFFIC CONTROL</div>
      <h1>网关设置</h1>
      <p>调整选号权重、会话粘性、冷却熔断和并发节奏，保存后立即生效。</p>
    </div>
    <div class="heading-actions">
      <button class="button" :title="'恢复默认值（需再点保存）'" @click="resetDefaults">
        <RefreshCw :size="16" />默认值</button
      ><button class="button primary" :disabled="!dirty || saving" @click="save">
        <LoaderCircle v-if="saving" :size="16" class="spin" /><Save v-else :size="16" />{{
          saving ? '正在保存' : '保存配置'
        }}
      </button>
    </div>
  </div>
  <form @submit.prevent="save">
    <section class="section-panel">
      <header class="section-heading">
        <span class="section-number">01</span>
        <div>
          <h2>选号策略</h2>
          <p>按权重加权随机选取，Top-N 截断后随机，兼顾余额与成功率。</p>
        </div>
      </header>
      <div class="strategy-grid" role="radiogroup" aria-label="路由策略">
        <button
          type="button"
          class="strategy-card selected"
          role="radio"
          :aria-checked="true"
        >
          <span class="strategy-card-top"
            ><Scale :size="23" /><span class="radio-indicator"
              ><Check :size="12" /></span></span
          ><span class="eyebrow">WEIGHTED RANDOM</span
          ><strong>加权随机</strong>
          <p>
            权重 = 余额占比 × 系数 + 成功率 × 系数 + 闲置补偿，Top-N 内加权随机。
          </p>
          <span class="strategy-tag">当前唯一策略</span>
        </button>
      </div>
      <div class="affinity-settings">
        <label class="affinity-toggle">
          <input v-model="sessionAffinity" type="checkbox" />
          <span
            ><strong>会话粘性</strong
            ><small>同一会话优先沿用上次选中的账号，减少切换对上游缓存的影响。</small></span
          >
        </label>
        <label v-if="sessionAffinity">
          <span>粘性有效期<small>同一会话固定同号的时长（滚动续期）。</small></span>
          <div class="unit-input">
            <input v-model.number="stickyTtlMin" type="number" min="1" max="720" required /><span>分钟</span>
          </div>
        </label>
      </div>
    </section>
    <div class="routing-settings-grid">
      <section class="section-panel">
        <header class="section-heading">
          <Scale :size="20" />
          <div>
            <h2>选号权重</h2>
            <p>权重越高越优先参与加权随机。</p>
          </div>
        </header>
        <div class="settings-fields">
          <label
            ><span>余额占比系数<small>权重 = 余额占比 × 系数；0 = 不看余额。</small></span>
            <div class="unit-input">
              <input v-model.number="weightBalFactor" type="number" min="0" max="100" step="1" required /><span>×</span>
            </div></label
          ><label
            ><span>成功率系数<small>权重 = 成功率 × 系数；0 = 不看成功率。</small></span>
            <div class="unit-input">
              <input v-model.number="weightSuccFactor" type="number" min="0" max="100" step="1" required /><span>×</span>
            </div></label
          ><label
            ><span>闲置补偿 / 小时<small>闲置每小时额外加的权重。</small></span>
            <div class="unit-input">
              <input v-model.number="idleWeightPerHour" type="number" min="0" max="50" step="0.1" required /><span>权</span>
            </div></label
          ><label
            ><span>闲置补偿封顶<small>闲置补偿上限；0 = 关闭。</small></span>
            <div class="unit-input">
              <input v-model.number="idleWeightMax" type="number" min="0" max="100" step="1" required /><span>权</span>
            </div></label
          ><label
            ><span>Top-N 候选窗口<small>只从权重最高的 N 个号里加权随机。</small></span>
            <div class="unit-input">
              <input v-model.number="topN" type="number" min="1" max="20" required /><span>个</span>
            </div></label
          >
        </div>
      </section>
      <section class="section-panel">
        <header class="section-heading">
          <Timer :size="20" />
          <div>
            <h2>冷却与熔断</h2>
            <p>风控、限流、连败分别按不同时长冷却。</p>
          </div>
        </header>
        <div class="settings-fields">
          <label
            ><span>限流首次冷却<small>1005/3009 首次按并发瞬态处理。</small></span>
            <div class="unit-input">
              <input v-model.number="busyCooldownSec" type="number" min="5" max="600" required /><span>秒</span>
            </div></label
          ><label
            ><span>额度冷却<small>限流反复出现后的冷却。</small></span>
            <div class="unit-input">
              <input v-model.number="quotaCooldownMin" type="number" min="1" max="240" required /><span>分钟</span>
            </div></label
          ><label
            ><span>风控冷却<small>3012 内容指纹被拦时的冷却。</small></span>
            <div class="unit-input">
              <input v-model.number="blockedCooldownMin" type="number" min="1" max="240" required /><span>分钟</span>
            </div></label
          ><label
            ><span>熔断阈值<small>连续失败几次触发熔断。</small></span>
            <div class="unit-input">
              <input v-model.number="breakerThreshold" type="number" min="2" max="20" required /><span>次</span>
            </div></label
          ><label
            ><span>熔断基数<small>连败熔断起始时长（之后指数翻倍封顶 6h）。</small></span>
            <div class="unit-input">
              <input v-model.number="breakerCooldownMin" type="number" min="1" max="120" required /><span>分钟</span>
            </div></label
          >
          <div class="note-box">
            <Info :size="15" /><span
              >手动停用的账号不参与任何调度，也不参与全冷却兜底。</span
            >
          </div>
        </div>
      </section>
    </div>
    <section class="section-panel">
      <header class="section-heading">
        <Waypoints :size="20" />
        <div>
          <h2>并发与节奏</h2>
          <p>控制单号并发上限，避免单号被打爆。</p>
        </div>
      </header>
      <div class="settings-fields">
        <label
          ><span>单号在途上限<small>同一账号同时处理的请求数。</small></span>
          <div class="unit-input">
            <input v-model.number="maxInFlight" type="number" min="1" max="50" required /><span>个</span>
          </div></label
        ><label
          ><span>防惊群窗口<small>这段时间内刚被选过的号排到队尾而非剔除。</small></span>
          <div class="unit-input">
            <input v-model.number="minPickGapMs" type="number" min="0" max="5000" required /><span>ms</span>
          </div></label
        >
      </div>
    </section>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </form>
  <section class="section-panel route-map-panel">
    <header class="section-heading">
      <Waypoints :size="20" />
      <div>
        <h2>当前可用的路由路径</h2>
        <p>每次请求按权重在可用账号内加权随机。</p>
      </div>
      <span class="subtle">{{ eligible.length }} 个可用账号</span>
    </header>
    <div class="route-map">
      <div class="route-source">
        <span class="stat-icon blue"><Waypoints :size="22" /></span><strong>统一 API 入口</strong
        ><code>/v1/*</code>
      </div>
      <ArrowRight class="route-map-arrow" :size="25" />
      <div class="route-targets">
        <div v-for="a in eligible.slice(0, 6)" :key="a.id">
          <Server :size="17" /><strong>{{ a.name }}</strong
          ><span>权重 {{ a.weight }}</span
          ><i class="status-dot green" />
        </div>
        <p v-if="!eligible.length" class="subtle">账号启用后，路由路径会出现在这里。</p>
        <p v-if="eligible.length > 6" class="subtle">还有 {{ eligible.length - 6 }} 个可用账号</p>
      </div>
    </div>
  </section>
</template>
