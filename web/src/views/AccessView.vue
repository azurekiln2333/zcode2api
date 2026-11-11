<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Braces,
  Copy,
  Eye,
  EyeOff,
  ShieldCheck,
  ArrowRight,
  Terminal,
  Plug,
  Check,
  LoaderCircle,
} from '@lucide/vue'
import { api } from '../api'
import { useConsole, copy, notify } from '../console'
const { accounts } = useConsole()
const profile = ref<{ publicUrl: string; maskedKey: string; gatewayKeySet: boolean; models: Array<{ id: string }> }>({
  publicUrl: '',
  maskedKey: '未配置主密钥',
  gatewayKeySet: false,
  models: [],
})
const actualKey = ref('')
const reveal = ref(false)
const keyLoading = ref(false)
const protocol = ref<'openai' | 'anthropic' | 'claudecode'>('openai')
const baseUrl = computed(() => profile.value.publicUrl || location.origin)
const model = computed(() => profile.value.models[0]?.id || 'GLM-5.3-Flash')
const keyHint = computed(() =>
  profile.value.gatewayKeySet
    ? '由主机 GATEWAY_KEY 环境变量配置，修改后重启容器生效。'
    : '未配置主密钥；请在「密钥」页创建密钥，没有可用密钥时网关会拒绝所有调用。',
)
const example = computed(() =>
  protocol.value === 'openai'
    ? `curl ${baseUrl.value}/v1/chat/completions \\\n  -H "Authorization: Bearer zck_xxxxxxxx" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${model.value}",\n    "reasoning_effort": "high",\n    "messages": [{"role": "user", "content": "你好"}],\n    "stream": true\n  }'`
    : protocol.value === 'claudecode'
      ? `export ANTHROPIC_BASE_URL="${baseUrl.value}"\nexport ANTHROPIC_AUTH_TOKEN="zck_xxxxxxxx"\nexport ANTHROPIC_MODEL="${model.value}"\n\nclaude`
      : `curl ${baseUrl.value}/v1/messages \\\n  -H "x-api-key: zck_xxxxxxxx" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${model.value}",\n    "max_tokens": 4096,\n    "thinking": {"type": "enabled", "budget_tokens": 32768},\n    "messages": [{"role": "user", "content": "你好"}]\n  }'`,
)
onMounted(async () => {
  try {
    profile.value = await api('/access')
  } catch (error) {
    notify(error instanceof Error ? error.message : '接入配置加载失败', true)
  }
})
async function getKey() {
  if (!actualKey.value)
    actualKey.value = (await api<{ key: string }>('/access/key', 'POST', {})).key
  return actualKey.value
}
async function showKey() {
  if (reveal.value) {
    reveal.value = false
    actualKey.value = ''
    return
  }
  keyLoading.value = true
  try {
    await getKey()
    reveal.value = true
  } catch (e) {
    notify(e instanceof Error ? e.message : '读取失败', true)
  } finally {
    keyLoading.value = false
  }
}
async function copyKey() {
  keyLoading.value = true
  try {
    await copy(await getKey())
    if (!reveal.value) actualKey.value = ''
  } catch (e) {
    notify(e instanceof Error ? e.message : '读取失败', true)
  } finally {
    keyLoading.value = false
  }
}
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />ONE ENDPOINT</div>
      <h1>接入配置</h1>
      <p>在客户端填入固定地址和网关 Key，账号切换由网关自动处理。</p>
    </div>
    <span class="protocol-label"><ShieldCheck :size="15" />标准协议兼容</span>
  </div>
  <section class="access-hero">
    <div class="access-hero-icon"><Braces :size="29" /></div>
    <div>
      <span class="eyebrow">YOUR UNIFIED ENDPOINT</span>
      <h2>一个地址，连起整个号池。</h2>
      <p>兼容 OpenAI 客户端与 Claude Code，支持流式响应、工具调用和思考强度。</p>
    </div>
    <div class="access-hero-tags">
      <span><Check :size="12" />OpenAI</span><span><Check :size="12" />Anthropic</span>
    </div>
  </section>
  <div class="access-grid">
    <section class="section-panel">
      <header class="section-heading">
        <Plug :size="20" />
        <div>
          <h2>连接信息</h2>
          <p>双协议同一域名，Key 在「密钥」里分发或用 GATEWAY_KEY。</p>
        </div>
      </header>
      <div class="connection-fields">
        <label
          >OpenAI Base URL
          <div class="copy-field">
            <code>{{ baseUrl }}/v1</code
            ><button
              class="icon-button"
              aria-label="复制 OpenAI 地址"
              @click="copy(`${baseUrl}/v1`)"
            >
              <Copy :size="15" />
            </button></div></label
        ><label
          >Anthropic Base URL
          <div class="copy-field">
            <code>{{ baseUrl }}</code
            ><button class="icon-button" aria-label="复制 Anthropic 地址" @click="copy(baseUrl)">
              <Copy :size="15" />
            </button></div></label
        ><label
          >统一网关 API Key
          <div class="copy-field">
            <code>{{ reveal ? actualKey : profile.maskedKey }}</code
            ><button
              class="icon-button"
              :disabled="keyLoading || !profile.gatewayKeySet"
              :aria-label="reveal ? '隐藏网关密钥' : '显示网关密钥'"
              :title="profile.gatewayKeySet ? '' : '未设置 GATEWAY_KEY'"
              @click="showKey"
            >
              <LoaderCircle v-if="keyLoading" :size="15" class="spin" /><EyeOff
                v-else-if="reveal"
                :size="15"
              /><Eye v-else :size="15" /></button
            ><button
              class="icon-button"
              :disabled="keyLoading || !profile.gatewayKeySet"
              aria-label="复制网关密钥"
              @click="copyKey"
            >
              <Copy :size="15" />
            </button>
          </div>
          <small>{{ keyHint }}</small></label
        >
      </div>
      <div class="access-security">
        <ShieldCheck :size="16" /><span
          >客户端使用网关 Key。面板登录（PANEL_KEY）与网关 Key 相互独立，请设置不同的值。</span
        >
      </div>
    </section>
    <section class="section-panel client-guide">
      <header class="section-heading">
        <Terminal :size="20" />
        <div>
          <h2>快速开始</h2>
          <p>选择客户端，复制对应配置。</p>
        </div>
      </header>
      <div class="client-tabs" role="tablist" aria-label="客户端类型">
        <button
          role="tab"
          :aria-selected="protocol === 'openai'"
          :class="{ active: protocol === 'openai' }"
          @click="protocol = 'openai'"
        >
          OpenAI / cURL</button
        ><button
          role="tab"
          :aria-selected="protocol === 'anthropic'"
          :class="{ active: protocol === 'anthropic' }"
          @click="protocol = 'anthropic'"
        >
          Anthropic / cURL</button
        ><button
          role="tab"
          :aria-selected="protocol === 'claudecode'"
          :class="{ active: protocol === 'claudecode' }"
          @click="protocol = 'claudecode'"
        >
          Claude Code
        </button>
      </div>
      <div class="code-block">
        <div class="code-header">
          <span><Terminal :size="13" />Terminal</span
          ><button class="icon-button" aria-label="复制调用示例" @click="copy(example)">
            <Copy :size="14" />
          </button>
        </div>
        <pre>{{ example }}</pre>
      </div>
      <p class="inline-hint">
        把 zck_xxxxxxxx 替换为「API 密钥」里创建的 Key 或 GATEWAY_KEY。思考强度：OpenAI 传
        reasoning_effort（low/high/max），Anthropic 传 thinking.budget_tokens（自动分档）。
      </p>
    </section>
  </div>
  <section class="section-panel access-flow">
    <span class="eyebrow">HOW IT CONNECTS</span>
    <div>
      <span
        ><span class="flow-step">01</span><strong>你的客户端</strong
        ><small>固定域名 + 网关 Key</small></span
      ><ArrowRight :size="20" /><span
        ><span class="flow-step">02</span><strong>zcgw 统一网关</strong
        ><small>选号 / 冷却 / 故障切换</small></span
      ><ArrowRight :size="20" /><span
        ><span class="flow-step">03</span><strong>ZCode 账号池</strong
        ><small>OAuth JWT / 自动领取</small></span
      ><ArrowRight :size="20" /><span
        ><span class="flow-step">04</span><strong>上游推理通道</strong
        ><small>GLM 模型家族</small></span
      >
    </div>
  </section>
</template>
