<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  Check,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Terminal,
  Cloud,
  ArrowRight,
  CircleAlert,
} from '@lucide/vue'
import { api } from '../api'
import { notify, useConsole } from '../console'
import ModalShell from './ModalShell.vue'

const props = defineProps<{
  target?: { id: string; name: string; identity: string | null } | null
  initialProvider?: 'zai' | 'bigmodel'
}>()
const emit = defineEmits<{ close: [] }>()
const { syncAuthorizedAccount } = useConsole()
interface OnboardResult { status: string; label?: string; hasAccessToken?: boolean }

interface Flow {
  flowId: string
  authorizeUrl: string
  expiresAt: number
  pollIntervalSec: number
  provider: 'zai' | 'bigmodel'
}

const provider = ref<'zai' | 'bigmodel' | null>(null)
const starting = ref(false)
const flow = ref<Flow | null>(null)
const stateText = ref('')
const finished = ref(false)
const checking = ref(false)
const pasteUrl = ref('')
const terminal = ref(false)
let pollTimer: number | undefined

const providerMeta = {
  zai: { title: '国际账号 · z.ai 登录', desc: '跳转 chat.z.ai 登录页，邮箱注册的账号走这里。' },
  bigmodel: { title: '国内账号 · bigmodel 登录', desc: '跳转 bigmodel.cn 登录页，手机号注册的账号走这里。' },
} as const

function stopPoll() {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
}
let disposed = false
onBeforeUnmount(() => { disposed = true; stopPoll() })
onMounted(() => { if (props.initialProvider) void start(props.initialProvider) })

async function start(p: 'zai' | 'bigmodel') {
  if (starting.value || checking.value || disposed) return
  stopPoll()
  provider.value = p
  starting.value = true
  flow.value = null
  finished.value = false
  terminal.value = false
  pasteUrl.value = ''
  stateText.value = '正在创建授权链接…'
  try {
    flow.value = await api<Flow>('/onboard/start', 'POST', {
      provider: p, ...(props.target ? { accountId: props.target.id } : {}),
    })
    if (disposed) return
    stateText.value = '自动等待授权结果…'
    const interval = Math.max(2, flow.value.pollIntervalSec || 2) * 1000
    pollTimer = window.setInterval(() => void pollOnce(), interval)
  } catch (e) {
    stateText.value = e instanceof Error ? e.message : '无法发起登录授权'
  } finally {
    starting.value = false
  }
}

function handleFlowError(error: unknown, prefix: string) {
  const status = (error as { status?: number }).status
  const message = error instanceof Error ? error.message : '未知错误'
  if (status === 409 || status === 410 || status === 422) {
    stopPoll()
    terminal.value = true
    stateText.value = message
  } else stateText.value = `${prefix}：${message}`
}

async function pollOnce() {
  if (!flow.value || finished.value || checking.value || terminal.value || disposed) return
  checking.value = true
  try {
    const r = await api<OnboardResult>(
      `/onboard/poll/${encodeURIComponent(flow.value.flowId)}`,
    )
    if (r.status === 'pending') {
      stateText.value = '等待你在浏览器点击确认授权…'
      return
    }
    if (r.status !== 'ready') {
      stateText.value = `当前状态：${r.status}`
      return
    }
    finish(r)
  } catch (e) {
    handleFlowError(e, '等待重连')
  } finally { checking.value = false }
}

async function submitPaste() {
  if (!flow.value || finished.value || checking.value || terminal.value || disposed) return
  const url = pasteUrl.value.trim()
  if (!url) {
    stateText.value = '请先粘贴授权完成后浏览器地址栏的链接'
    return
  }
  checking.value = true
  try {
    const r = await api<OnboardResult>('/onboard/redeem', 'POST', {
      flowId: flow.value.flowId,
      url,
    })
    if (r.status === 'ready') return finish(r)
    if (r.status === 'pending')
      stateText.value =
        '提交了但还没生效：确认浏览器已走到授权最后一步；若 code 已被浏览器消费过，稍等自动轮询即可'
    else stateText.value = `当前状态：${r.status}`
  } catch (e) {
    handleFlowError(e, '提交失败')
  } finally { checking.value = false }
}

function finish(result: OnboardResult) {
  if (finished.value || disposed) return
  stopPoll()
  if (result.hasAccessToken === false) {
    terminal.value = true
    stateText.value = '授权服务未返回完整授权凭证，请重新发起授权'
    return
  }
  finished.value = true
  notify('授权成功，正在自动刷新资格与额度…')
  if (result.label) void syncAuthorizedAccount(result.label)
  emit('close')
}
const expireAt = () =>
  flow.value ? new Date(flow.value.expiresAt * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : ''
</script>

<template>
  <ModalShell
    :title="target ? `重新授权 · ${target.name}` : '登录新账号'"
    :subtitle="target ? `请使用该账号原有的手机号或邮箱登录${target.identity ? `（${target.identity}）` : ''}，完成后自动刷新资格与额度。` : '国际号走 z.ai 登录页，国内号走 bigmodel 登录页，选错会卡在授权页。'"
    wide
    @close="emit('close')"
    ><div class="modal-body onboard-body">
      <template v-if="!flow">
        <div class="onboard-provider-grid">
          <button
            v-for="(meta, key) in providerMeta"
            :key="key"
            type="button"
            class="onboard-provider-card"
            :disabled="starting"
            @click="start(key)"
          >
            <span class="onboard-provider-icon"><Cloud :size="22" /></span>
            <strong>{{ meta.title }}</strong>
            <small>{{ meta.desc }}</small>
            <span class="eyebrow">{{ key === 'zai' ? 'CHAT.Z.AI' : 'BIGMODEL.CN' }}</span>
          </button>
        </div>
        <p v-if="stateText" class="onboard-state" :role="starting ? 'status' : 'alert'">
          <LoaderCircle v-if="starting" :size="14" class="spin" />{{ stateText }}
        </p>
      </template>
      <template v-else-if="terminal">
        <p class="onboard-state" role="alert"><CircleAlert :size="16" />{{ stateText }}</p>
        <div class="onboard-actions">
          <button type="button" class="button primary" :disabled="checking || starting" @click="start(provider!)">
            <RefreshCw :size="15" />重新发起授权
          </button>
        </div>
      </template>
      <template v-else>
        <div class="success-callout">
          <span><CircleAlert :size="19" /></span>
          <div>
            <strong>第一步：在浏览器完成 ZCode 登录授权（{{ providerMeta[provider!].title }}）</strong>
            <p>链接有效至 {{ expireAt() }} · 授权后自动识别身份并刷新资格与额度；领取套餐需查看详情并完成验证。</p>
          </div>
        </div>
        <div class="onboard-actions">
          <a class="button primary" :href="flow.authorizeUrl" target="_blank" rel="noopener noreferrer">
            <ExternalLink :size="15" />打开 ZCode 授权页
          </a>
          <button type="button" class="button" :disabled="checking" @click="pollOnce">
            <RefreshCw :size="15" />我已授权，立即检查
          </button>
        </div>
        <p class="onboard-state" role="status">{{ stateText }}</p>
        <div class="step-label">
          <b>02</b>
          <div>
            <strong>自动等待失败时：粘贴授权完成后的链接</strong>
            <p>浏览器授权完成后最后停留的地址（含 code= 与 state=），交给服务端代访兑付。</p>
          </div>
        </div>
        <div class="code-block">
          <div class="code-header">
            <span><Terminal :size="14" />回调链接</span
            ><button
              class="icon-button"
              aria-label="提交授权链接"
              :disabled="checking"
              @click="submitPaste"
            >
              <ArrowRight :size="15" />
            </button>
          </div>
          <input
            v-model="pasteUrl"
            class="onboard-paste"
            placeholder="https://zcode.z.ai/api/v1/oauth/cli/callback/...?code=...&state=..."
          />
        </div>
      </template>
    </div>
    <footer class="modal-footer">
      <span class="subtle">授权完成后 20 分钟内有效，过期请重新发起</span
      ><button class="button primary" @click="emit('close')">
        {{ finished ? '完成' : '稍后再说' }}<Check v-if="finished" :size="15" />
      </button></footer
  ></ModalShell>
</template>

<style scoped>
.onboard-provider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.onboard-provider-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  align-items: flex-start;
  text-align: left;
  border: 1.5px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-subtle);
  padding: 16px;
  transition: border-color 0.12s, background 0.12s;
}
.onboard-provider-card:hover:not(:disabled) {
  border-color: var(--primary);
  background: var(--primary-soft);
}
.onboard-provider-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--primary-soft);
  color: var(--primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.onboard-provider-card strong {
  font-size: 14.5px;
}
.onboard-provider-card small {
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.6;
}
.onboard-state {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--secondary);
  font-size: 13px;
}
.onboard-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
}
.onboard-paste {
  width: 100%;
  font-family: 'JetBrains Mono Variable', ui-monospace, monospace;
  font-size: 12px;
}
</style>
