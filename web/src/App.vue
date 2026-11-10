<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import {
  LayoutDashboard,
  UsersRound,
  Waypoints,
  ScrollText,
  Braces,
  ArrowUpRight,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Sun,
  Moon,
  LogOut,
  ArrowRight,
  Check,
  CircleAlert,
  LoaderCircle,
  ShieldCheck,
  Cloud,
  Layers,
  UserRound,
  X,
} from '@lucide/vue'
import { api, formatApiDiagnostics, type ApiDiagnostics } from './api'
import { copy, notify, useConsole } from './console'
import type { Page } from './types'
import AccountsView from './views/AccountsView.vue'
import OverviewView from './views/OverviewView.vue'
import RoutingView from './views/RoutingView.vue'
import ActivityView from './views/ActivityView.vue'
import AccessView from './views/AccessView.vue'
import ModelsView from './views/ModelsView.vue'
import SsoSettingsView from './views/SsoSettingsView.vue'
import ModalShell from './components/ModalShell.vue'

const appVersion = __APP_VERSION__

interface SessionUser {
  name: string
  email: string
  picture: string
  provider: 'key' | 'oidc'
}
interface AuthConfig {
  keyLoginEnabled: boolean
  sso: { enabled: boolean; providerName: string; loginUrl: string }
}

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  keyLoginEnabled: true,
  sso: { enabled: false, providerName: '', loginUrl: '' },
}

const {
  overview,
  loading,
  refreshError,
  refreshDiagnostics,
  lastUpdated,
  toasts,
  refresh,
  reset,
  pollAutomaticClaimBrowser,
} = useConsole()
const nav = [
  { id: 'overview', label: '运行概览', icon: LayoutDashboard },
  { id: 'accounts', label: '账号管理', icon: UsersRound },
  { id: 'models', label: '模型列表', icon: Layers },
  { id: 'routing', label: '网关设置', icon: Waypoints },
  { id: 'activity', label: '请求日志', icon: ScrollText },
  { id: 'access', label: '接入配置', icon: Braces },
  { id: 'security', label: '登录与 SSO', icon: ShieldCheck },
] as const
const initialPage = location.hash.slice(1)
const page = ref<Page>(nav.some((n) => n.id === initialPage) ? (initialPage as Page) : 'accounts')
const title = computed(() => nav.find((n) => n.id === page.value)?.label)
const authenticated = ref(false)
const checkingSession = ref(true)
const loginKey = ref('')
const ssoError = new URLSearchParams(location.search).get('auth_error') || ''
const loginError = ref('')
const signingIn = ref(false)
const authConfig = ref<AuthConfig>(DEFAULT_AUTH_CONFIG)
const sessionUser = ref<SessionUser | null>(null)
const userMenuOpen = ref(false)
const diagnostics = ref<ApiDiagnostics | null>(null)
const mobileOpen = ref(false)
const collapsed = ref(false)
const contentPane = ref<HTMLElement | null>(null)
const dark = ref(localStorage.getItem('zcgw-theme') === 'dark')
let poll: number | undefined
let browserPoll: number | undefined
let lastLifecycleRefresh = -Infinity

// SSO 回跳失败时服务端会带上 ?auth_error=xxx，登录页直接告知原因。
const AUTH_ERRORS: Record<string, string> = {
  sso_disabled: 'SSO 已关闭，请使用管理密钥登录。',
  discovery_failed: '无法连接 SSO 提供方，请检查颁发者地址。',
  transaction_expired: '登录超时，请重新发起。',
  state_mismatch: '登录状态校验失败，请重试。',
  not_allowed: '当前账号不在管理员白名单中。',
  userinfo_mismatch: 'SSO 返回的身份信息不一致，已拒绝登录。',
  provider_error: 'SSO 提供方返回了错误。',
}
const ssoErrorText = computed(() =>
  ssoError ? AUTH_ERRORS[ssoError] || 'SSO 登录失败，请重试。' : '',
)
const loginHint = computed(() =>
  authConfig.value.sso.enabled
    ? '使用管理密钥或单点登录进入控制台。'
    : '使用主机上配置的管理密钥登录。',
)
const userInitial = computed(() => {
  const name = sessionUser.value?.name.trim()
  return name ? Array.from(name)[0]!.toUpperCase() : ''
})
const identityName = computed(() => sessionUser.value?.name.trim() || '管理面板')
const identityDetail = computed(() => '密钥登录')

function refreshPage() {
  if (!authenticated.value || document.hidden) return
  void refresh()
  if (page.value === 'activity') void refresh()
}
function resumeRefresh() {
  if (!authenticated.value || document.hidden) return
  const now = Date.now()
  if (now - lastLifecycleRefresh < 250) return
  lastLifecycleRefresh = now
  refreshPage()
}
watch(
  page,
  () => {
    if (authenticated.value && !document.hidden) void refresh()
    contentPane.value?.scrollTo({ top: 0, left: 0 })
  },
  { flush: 'post' },
)

function setTheme() {
  document.documentElement.dataset.theme = dark.value ? 'dark' : 'light'
  localStorage.setItem('zcgw-theme', dark.value ? 'dark' : 'light')
}
function toggleTheme() {
  dark.value = !dark.value
  setTheme()
}
setTheme()
function navigate(id: Page) {
  if (page.value === id) refreshPage()
  page.value = id
  location.hash = id
  mobileOpen.value = false
}
function hashChanged() {
  const id = location.hash.slice(1)
  if (nav.some((n) => n.id === id)) page.value = id as Page
}
async function loadAuthConfig() {
  try {
    const config = await api<AuthConfig>('/auth/config')
    if (!config || typeof config.keyLoginEnabled !== 'boolean' || !config.sso) return
    authConfig.value = {
      keyLoginEnabled: config.keyLoginEnabled,
      sso: {
        enabled: config.sso.enabled === true,
        providerName: typeof config.sso.providerName === 'string' ? config.sso.providerName : '',
        loginUrl: typeof config.sso.loginUrl === 'string' ? config.sso.loginUrl : '',
      },
    }
  } catch {
    authConfig.value = DEFAULT_AUTH_CONFIG
  }
}
function expired() {
  authenticated.value = false
  sessionUser.value = null
  userMenuOpen.value = false
  diagnostics.value = null
  reset()
  void loadAuthConfig()
}
async function establishSession() {
  const session = await api<{ authenticated: boolean; user?: SessionUser }>('/session')
  sessionUser.value = session.user ?? null
  authenticated.value = true
  checkingSession.value = false
  void refresh()
  void pollAutomaticClaimBrowser()
}
async function signIn() {
  signingIn.value = true
  loginError.value = ''
  try {
    await api('/session', 'POST', { key: loginKey.value })
    loginKey.value = ''
    await establishSession()
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : '登录失败'
  } finally {
    signingIn.value = false
  }
}
async function signOut() {
  userMenuOpen.value = false
  try {
    await api('/session', 'DELETE')
    expired()
  } catch (error) {
    notify(error instanceof Error ? error.message : '退出失败', true)
  }
}
function toggleUserMenu() {
  userMenuOpen.value = !userMenuOpen.value
}
function closeUserMenu() {
  userMenuOpen.value = false
}
function shortcuts(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    mobileOpen.value = false
    userMenuOpen.value = false
  }
}
onMounted(async () => {
  void loadAuthConfig()
  window.addEventListener('hashchange', hashChanged)
  window.addEventListener('session-expired', expired)
  window.addEventListener('keydown', shortcuts)
  window.addEventListener('click', closeUserMenu)
  document.addEventListener('visibilitychange', resumeRefresh)
  window.addEventListener('focus', resumeRefresh)
  window.addEventListener('online', resumeRefresh)
  poll = window.setInterval(refreshPage, 15000)
  browserPoll = window.setInterval(() => {
    if (authenticated.value) void pollAutomaticClaimBrowser()
  }, 3000)
  try {
    await establishSession()
  } catch {
    /* login form handles an absent session */
  } finally {
    checkingSession.value = false
  }
})
onBeforeUnmount(() => {
  clearInterval(poll)
  clearInterval(browserPoll)
  reset()
  window.removeEventListener('hashchange', hashChanged)
  window.removeEventListener('session-expired', expired)
  window.removeEventListener('keydown', shortcuts)
  window.removeEventListener('click', closeUserMenu)
  document.removeEventListener('visibilitychange', resumeRefresh)
  window.removeEventListener('focus', resumeRefresh)
  window.removeEventListener('online', resumeRefresh)
})
</script>

<template>
  <div v-if="checkingSession" class="boot-screen">
    <span class="brand-icon"><Braces :size="22" /></span
    ><LoaderCircle :size="20" class="spin" /><span>正在连接控制台</span>
  </div>
  <div v-else-if="!authenticated" class="login-shell">
    <section class="login-story">
      <a class="brand" href="#overview"
        ><span class="brand-icon"><Braces :size="23" /></span
        ><span>zc<span class="brand-two">gw</span></span
        ><span class="brand-tag">CONSOLE</span></a
      >
      <div class="login-story-content">
        <span class="eyebrow"><i class="blue-dot" /> ONE ENDPOINT. YOUR WHOLE POOL.</span>
        <h1>把分散的账号，<br />连成一条稳定的路。</h1>
        <div class="network-art" aria-hidden="true">
          <div class="network-center"><Braces :size="26" /><span>统一网关</span></div>
          <svg viewBox="0 0 440 200">
            <path
              d="M110 100H210Q240 100 240 50T280 25H335M210 100H335M210 100Q240 100 240 150T280 175H335"
            />
          </svg>
          <div class="network-node node-1"><Cloud :size="19" />账号 01<i /></div>
          <div class="network-node node-2"><Cloud :size="19" />账号 02<i /></div>
          <div class="network-node node-3"><Cloud :size="19" />账号 03<i /></div>
        </div>
      </div>
      <div class="login-story-footer">
        <span>少一点维护，多一点专注。↗</span>
      </div>
    </section>
    <main class="login-main">
      <button class="icon-button login-theme" aria-label="切换明暗主题" @click="toggleTheme">
        <Sun v-if="dark" :size="20" /><Moon v-else :size="20" />
      </button>
      <form class="login-form" @submit.prevent="signIn">
        <span class="login-lock"><ShieldCheck :size="25" /></span
        ><span class="eyebrow">GATEWAY CONSOLE</span>
        <h2>欢迎回到控制台</h2>
        <p>{{ loginHint }}</p>
        <p v-if="ssoErrorText" class="form-error" role="alert">{{ ssoErrorText }}</p>
        <template v-if="authConfig.keyLoginEnabled">
          <label for="admin-key"
            >管理密钥<input
              id="admin-key"
              v-model="loginKey"
              type="password"
              required
              autofocus
              autocomplete="current-password"
              placeholder="输入 PANEL_ADMIN_KEY"
          /></label>
          <p v-if="loginError" class="form-error" role="alert">{{ loginError }}</p>
          <button class="button primary login-submit" :disabled="signingIn">
            <LoaderCircle v-if="signingIn" :size="17" class="spin" /><span>{{
              signingIn ? '正在验证' : '进入控制台'
            }}</span
            ><ArrowRight :size="17" />
          </button>
        </template>
        <p v-else class="form-error" role="alert">
          登录方式未配置，请在服务器环境变量中设置 PANEL_ADMIN_KEY，或在服务器上启用 SSO。
        </p>
        <template v-if="authConfig.sso.enabled && authConfig.sso.loginUrl">
          <div class="login-divider"><span>或</span></div>
          <a class="button login-sso" :href="authConfig.sso.loginUrl">
            <ShieldCheck :size="17" /><span
              >使用 {{ authConfig.sso.providerName || 'SSO' }} 登录</span
            >
          </a>
        </template>
      </form>
    </main>
  </div>
  <div v-else class="app-shell" :class="{ 'sidebar-collapsed': collapsed }">
    <header class="topbar">
      <div class="topbar-leading">
        <button
          class="icon-button collapse-button"
          :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
          :aria-expanded="!collapsed"
          @click="collapsed = !collapsed"
        >
          <PanelLeftOpen v-if="collapsed" :size="19" /><PanelLeftClose v-else :size="19" />
        </button>
        <button
          class="icon-button mobile-toggle"
          aria-label="展开导航"
          :aria-expanded="mobileOpen"
          @click="mobileOpen = !mobileOpen"
        >
          <PanelLeftOpen :size="19" />
        </button>
        <a href="#overview" class="brand topbar-brand" @click="navigate('overview')">
          <span class="brand-icon"><Braces :size="20" /></span>
          <span>zc<span class="brand-two">gw</span></span>
        </a>
        <div class="breadcrumbs">
          <span>控制台</span><ChevronRight :size="13" /><strong>{{ title }}</strong>
        </div>
      </div>
      <div class="topbar-actions">
        <button
          class="icon-button"
          :aria-label="dark ? '切换浅色主题' : '切换深色主题'"
          @click="toggleTheme"
        >
          <Sun v-if="dark" :size="18" /><Moon v-else :size="18" /></button
        ><span class="topbar-separator" />
        <div class="user-menu" @click.stop>
          <button
            class="user-trigger"
            aria-label="用户菜单"
            :aria-expanded="userMenuOpen"
            aria-haspopup="menu"
            @click="toggleUserMenu"
          >
            <span class="user-avatar"
              ><img
                v-if="sessionUser?.picture"
                :src="sessionUser.picture"
                alt=""
                referrerpolicy="no-referrer" /><template v-else-if="userInitial">{{
                userInitial
              }}</template
              ><UserRound v-else :size="15" /></span
            ><ChevronDown :size="14" />
          </button>
          <div v-if="userMenuOpen" class="user-panel" role="menu">
            <div class="user-identity">
              <span class="user-avatar large"><UserRound :size="17" /></span>
              <span class="user-identity-text"
                ><strong>{{ identityName }}</strong
                ><small>{{ identityDetail }}</small></span
              >
            </div>
            <div class="user-menu-sep" />
            <button class="user-logout" role="menuitem" @click="signOut">
              <LogOut :size="15" /><span>退出登录</span>
            </button>
          </div>
        </div>
      </div>
    </header>
    <button
      v-if="mobileOpen"
      class="mobile-backdrop"
      aria-label="关闭导航"
      @click="mobileOpen = false"
    />
    <aside class="sidebar" :class="{ 'mobile-open': mobileOpen }">
      <div class="nav-caption">控制台<span>CONSOLE</span></div>
      <nav class="main-nav" aria-label="主导航">
        <a
          v-for="item in nav.slice(0, 4)"
          :key="item.id"
          :href="`#${item.id}`"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          :title="item.label"
          @click="navigate(item.id)"
          ><component :is="item.icon" :size="17" /><span>{{ item.label }}</span
          ><small v-if="item.id === 'accounts'">{{ overview?.stats.total ?? 0 }}</small></a
        >
      </nav>
      <div class="nav-caption">管理与接入</div>
      <nav class="main-nav" aria-label="管理导航">
        <a
          v-for="item in nav.slice(4)"
          :key="item.id"
          :href="`#${item.id}`"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          :title="item.label"
          @click="navigate(item.id)"
          ><component :is="item.icon" :size="17" /><span>{{ item.label }}</span></a
        >
      </nav>
      <div class="sidebar-bottom">
        <a
          href="https://github.com/azurekiln2333/zcode2api"
          target="_blank"
          rel="noopener noreferrer"
          class="sidebar-help"
          ><Braces :size="16" /><span>项目与文档</span><ArrowUpRight :size="14"
        /></a>
      </div>
    </aside>
    <div ref="contentPane" class="main-shell">
      <main class="main-content" id="main-content">
        <div v-if="refreshError" class="error-banner" role="alert">
          <CircleAlert :size="16" /><span
            >{{ refreshError }}。{{ overview ? '当前显示上次成功更新的数据。' : '' }}</span
          ><button v-if="refreshDiagnostics" @click="diagnostics = refreshDiagnostics">
            诊断详情</button
          ><button @click="refresh">重试</button>
        </div>
        <ActivityView v-if="page === 'activity'" :key="page" channel="requests" />
        <ModelsView v-else-if="page === 'models'" />
        <!-- 登录/SSO 设置不依赖账号池，单独渲染，overview 拉取失败时也能打开 -->
        <SsoSettingsView v-else-if="page === 'security'" />
        <div v-else-if="!overview && loading" class="page-loading">
          <LoaderCircle :size="24" class="spin" /><span>正在读取账号池…</span>
        </div>
        <template v-else-if="overview"
          ><AccountsView v-if="page === 'accounts'" @navigate="navigate" /><OverviewView
            v-else-if="page === 'overview'" @navigate="navigate" /><RoutingView v-else-if="page === 'routing'"
          /><AccessView v-else
        /></template>
        <div v-else-if="!refreshError" class="page-loading">等待网关数据</div>
      </main>
      <footer class="page-footer">
        <span
          ><i class="blue-dot" /><span class="footer-gateway">ZCODE GATEWAY</span
          ><span class="footer-dot">·</span
          ><span class="footer-product"
            >zcgw <small>v{{ appVersion }}</small></span
          ><span class="footer-dot">·</span
          >{{ overview ? `调度 Top-${overview.settings.topN}` : '—' }}</span
        ><button @click="refresh">
          <RefreshCw :size="12" :class="{ spin: loading }" /><span>{{
            lastUpdated
              ? `每15秒刷新 · ${lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}`
              : '等待同步'
          }}</span>
        </button>
      </footer>
    </div>
  </div>
  <ModalShell
    v-if="diagnostics"
    title="接口诊断详情"
    subtitle="包含错误说明、请求路径和响应信息，可复制给服务器维护者排查。"
    @close="diagnostics = null"
  >
    <div class="modal-body">
      <pre class="api-diagnostics" data-testid="api-diagnostics">{{
        formatApiDiagnostics(diagnostics)
      }}</pre>
    </div>
    <footer class="modal-footer">
      <span />
      <div class="button-group">
        <button class="button" @click="diagnostics = null">关闭</button
        ><button class="button primary" @click="copy(formatApiDiagnostics(diagnostics))">
          复制诊断
        </button>
      </div>
    </footer>
  </ModalShell>
  <div class="toast-stack" aria-live="polite">
    <div v-for="toast in toasts" :key="toast.id" class="toast" :class="{ error: toast.error }">
      <CircleAlert v-if="toast.error" :size="17" /><Check v-else :size="17" /><span>{{
        toast.text
      }}</span
      ><button
        v-if="toast.diagnostics"
        class="text-link toast-diagnostics"
        @click="diagnostics = toast.diagnostics"
      >
        诊断详情</button
      ><button
        class="icon-button"
        aria-label="关闭通知"
        @click="toasts = toasts.filter((t) => t.id !== toast.id)"
      >
        <X :size="14" />
      </button>
    </div>
  </div>
</template>
