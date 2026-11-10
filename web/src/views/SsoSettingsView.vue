<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { KeyRound, LoaderCircle, Save, ShieldCheck } from '@lucide/vue'
import { api, ApiError } from '../api'
import { notify } from '../console'

interface SsoSettings {
  ssoEnabled: boolean
  keyLoginEnabled: boolean
  issuer: string
  clientId: string
  hasClientSecret: boolean
  scope: string
  providerName: string
  allowedSubjects: string[]
  allowedEmails: string[]
  callbackUrl: string
}

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const stored = ref<SsoSettings | null>(null)

const form = ref({
  ssoEnabled: false,
  keyLoginEnabled: true,
  issuer: '',
  clientId: '',
  clientSecret: '',
  scope: 'openid profile email',
  providerName: '',
  allowedSubjects: '',
  allowedEmails: '',
})

const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

const apply = (settings: SsoSettings) => {
  stored.value = settings
  form.value = {
    ssoEnabled: settings.ssoEnabled,
    keyLoginEnabled: settings.keyLoginEnabled,
    issuer: settings.issuer,
    clientId: settings.clientId,
    // The stored secret is never returned; an empty field keeps it.
    clientSecret: '',
    scope: settings.scope,
    providerName: settings.providerName,
    allowedSubjects: settings.allowedSubjects.join('\n'),
    allowedEmails: settings.allowedEmails.join('\n'),
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    apply(await api<SsoSettings>('/auth/settings'))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取 SSO 设置失败'
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const payload: Record<string, unknown> = {
      ssoEnabled: form.value.ssoEnabled,
      keyLoginEnabled: form.value.keyLoginEnabled,
      issuer: form.value.issuer,
      clientId: form.value.clientId,
      scope: form.value.scope,
      providerName: form.value.providerName,
      allowedSubjects: lines(form.value.allowedSubjects),
      allowedEmails: lines(form.value.allowedEmails),
    }
    // Only send the secret when the operator typed a new one.
    if (form.value.clientSecret.trim()) payload.clientSecret = form.value.clientSecret.trim()
    apply(await api<SsoSettings>('/auth/settings', 'PATCH', payload))
    notify('SSO 设置已保存，立即生效')
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : '保存 SSO 设置失败'
  } finally {
    saving.value = false
  }
}

const secretHint = computed(() =>
  stored.value?.hasClientSecret ? '留空保留已保存的密钥' : '在 SSO 提供方登记的客户端密钥',
)

const bothOff = computed(() => !form.value.ssoEnabled && !form.value.keyLoginEnabled)

onMounted(load)
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />ACCESS CONTROL</div>
      <h1>登录与 SSO</h1>
      <p>管理密钥登录与 OIDC 单点登录，设置保存在数据目录，改完立即生效，无需重启。</p>
    </div>
    <div class="heading-actions">
      <button class="button primary" :disabled="saving || loading" @click="save">
        <LoaderCircle v-if="saving" :size="16" class="spin" /><Save v-else :size="16" />保存
      </button>
    </div>
  </div>

  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <p v-if="bothOff" class="form-error" role="alert">
    密钥登录与 SSO 不能同时关闭，否则将无法进入控制台。
  </p>

  <section class="section-panel">
    <header class="section-heading">
      <span class="section-number">01</span>
      <div>
        <h2>登录方式</h2>
        <p>至少保留一种可用方式。</p>
      </div>
    </header>
    <div class="form-grid">
      <label>
        <input v-model="form.keyLoginEnabled" type="checkbox" :disabled="loading" />
        允许管理密钥登录<small>关闭前需先通过 SSO 登录验证一次。</small>
      </label>
      <label>
        <input v-model="form.ssoEnabled" type="checkbox" :disabled="loading" />
        启用 SSO 单点登录<small>需要提供方地址、客户端与至少一条白名单。</small>
      </label>
    </div>
  </section>

  <section class="section-panel">
    <header class="section-heading">
      <span class="section-number">02</span>
      <div>
        <h2>OIDC 提供方</h2>
        <p>保存时先做一次 discovery 校验，地址不可用则不会写入。</p>
      </div>
    </header>
    <div class="form-grid">
      <label
        >颁发者地址（Issuer）<input
          v-model.trim="form.issuer"
          placeholder="https://sso.example.com"
          autocomplete="off"
      /></label>
      <label
        >客户端 ID<input v-model.trim="form.clientId" placeholder="客户端编号" autocomplete="off"
      /></label>
      <label
        >客户端密钥<input
          v-model="form.clientSecret"
          type="password"
          :placeholder="secretHint"
          autocomplete="new-password"
      /><small v-if="stored?.hasClientSecret">已保存，留空则保持不变。</small></label>
      <label
        >授权 scope<input v-model.trim="form.scope" placeholder="openid profile email"
      /></label>
      <label
        >提供方名称<input
          v-model.trim="form.providerName"
          placeholder="登录页按钮上显示的名字"
      /><small>留空显示 SSO。</small></label>
      <label
        >回调地址<input :value="stored?.callbackUrl || ''" readonly /><small
          >在提供方登记这个地址；由 PANEL_PUBLIC_URL 推导。</small
        ></label
      >
    </div>
  </section>

  <section class="section-panel">
    <header class="section-heading">
      <span class="section-number">03</span>
      <div>
        <h2>准入白名单</h2>
        <p>每行一条。邮箱只有在提供方标记为已验证时才算数。</p>
      </div>
    </header>
    <div class="form-grid">
      <label
        >管理员 subject<textarea v-model="form.allowedSubjects" rows="4" placeholder="每行一个 subject" /></label>
      <label
        >管理员邮箱<textarea v-model="form.allowedEmails" rows="4" placeholder="每行一个邮箱" /></label>
    </div>
  </section>

  <section class="section-panel">
    <header class="section-heading">
      <KeyRound :size="20" />
      <div>
        <h2>服务间调用</h2>
        <p>
          统一平台面板用 <code>Authorization: Bearer &lt;PANEL_ADMIN_KEY&gt;</code> 调用本服务管理接口。
          即使关闭密钥登录，这条通路仍然有效。
        </p>
      </div>
      <ShieldCheck :size="18" />
    </header>
  </section>
</template>
