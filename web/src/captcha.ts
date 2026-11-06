/**
 * 阿里云验证码集成（对齐 zcode-switch src/captcha.js）：
 * 上游 billing/claim 强制人机验证（缺失/过期 → 3007），验证参数（captchaVerifyParam）
 * 由前端跑阿里云 SDK 生成，服务端带 X-Aliyun-Captcha-Verify-Param 头转发。
 *
 * 流程：loadSdk → initAliyunCaptcha → startTracelessVerification（无痕，多数情况直接过）
 *      → 8s 未回调解参数则转弹窗交互 → success 回调拿 param。
 */
import { ref } from 'vue'
import { api } from './api'

const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'

export const captchaState = ref<'idle' | 'verifying' | 'interactive' | 'ready'>('idle')
export const captchaMessage = ref('')

interface CaptchaConfig {
  enabled: boolean
  region: string
  prefix: string
  sceneId: string
}

export interface CaptchaProof { param: string; region: string }

let configCache: CaptchaConfig | null = null
let configFetchedAt = 0
let verificationId = 0
let instance: { destroy?: () => void } | null = null
let pendingResolve: ((proof: CaptchaProof) => void) | null = null
let pendingReject: ((err: Error) => void) | null = null
let tracelessTimer = 0
let preparationTimer = 0

function loadSdk(): Promise<void> {
  if (typeof (window as any).initAliyunCaptcha === 'function') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SDK_URL
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('验证码 SDK 加载失败，请检查网络（o.alicdn.com 可达性）'))
    document.head.appendChild(s)
  })
}

async function ensureConfig(): Promise<CaptchaConfig> {
  if (configCache && Date.now() - configFetchedAt < 600_000) return configCache
  configCache = await api<CaptchaConfig>('/captcha/config')
  configFetchedAt = Date.now()
  return configCache
}

function cleanup() {
  clearTimeout(tracelessTimer)
  clearTimeout(preparationTimer)
  try {
    instance?.destroy?.()
  } catch {}
  instance = null
  const holder = document.getElementById('zcgw-captcha-holder')
  if (holder) holder.style.display = 'none'
}

function initCaptcha(cfg: CaptchaConfig, current: () => boolean, onFail: (why: unknown) => void) {
  cleanup()
  const holder = document.getElementById('zcgw-captcha-holder')
  if (holder) holder.style.display = ''
  tracelessTimer = window.setTimeout(() => { if (current()) onFail('init-timeout') }, 15000)
  ;(window as any).AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix }
  ;(window as any).initAliyunCaptcha({
    SceneId: cfg.sceneId,
    mode: 'popup',
    language: 'zh-CN',
    showErrorTip: false,
    element: '#zcgw-captcha-holder',
    button: '#zcgw-captcha-btn',
    getInstance: (i: any) => {
      if (!current()) { i.destroy?.(); return }
      clearTimeout(tracelessTimer)
      instance = i
      if (typeof i.startTracelessVerification === 'function') {
        i.startTracelessVerification()
        // 无痕验证 8 秒不回调 → 需要人工点一下（zcode-switch 同款兜底）
        if (!current()) return
        tracelessTimer = window.setTimeout(() => {
          if (!current()) return
          captchaState.value = 'interactive'
          captchaMessage.value = '需要人工验证：请点击下方按钮完成拼图'
          onFail('traceless-timeout')
        }, 8000)
      } else {
        captchaState.value = 'interactive'
        captchaMessage.value = '需要人工验证：请点击下方按钮完成拼图'
        onFail('no-traceless')
      }
    },
    success: (param: string | { captchaVerifyParam: string }) => {
      if (!current()) return
      clearTimeout(tracelessTimer)
      const p = typeof param === 'string' ? param : param?.captchaVerifyParam
      if (!p?.trim()) { onFail('empty-param'); return }
      captchaState.value = 'ready'
      captchaMessage.value = ''
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        pendingReject = null
        cleanup()
        resolve({ param: p.trim(), region: cfg.region })
      }
    },
    fail: (p: unknown) => {
      if (!current()) return
      clearTimeout(tracelessTimer)
      onFail(p)
    },
    onError: (p: unknown) => {
      if (!current()) return
      clearTimeout(tracelessTimer)
      onFail(p)
    },
  })
}

/**
 * 跑一次人机验证，resolve 出 captchaVerifyParam。
 * 无痕验证失败/超时会转交互模式，由用户点按钮完成。
 */
export function runCaptcha(options: { interactive?: boolean } = {}): Promise<CaptchaProof> {
  if (pendingResolve) return Promise.reject(new Error('上一次验证还没完成，请先完成或取消'))
  const id = ++verificationId
  const current = () => id === verificationId && pendingResolve !== null
  captchaState.value = 'verifying'
  captchaMessage.value = '正在准备人机验证…'
  return new Promise<CaptchaProof>((resolve, reject) => {
    pendingResolve = resolve
    pendingReject = reject
    preparationTimer = window.setTimeout(() => {
      if (!current()) return
      pendingResolve = null
      pendingReject = null
      captchaState.value = 'idle'
      captchaMessage.value = ''
      cleanup()
      reject(new Error('人机验证准备超时，请检查网络后重试'))
    }, 30000)
    void (async () => {
      const cfg = await ensureConfig()
      if (!current()) return
      if (!cfg.enabled || !cfg.sceneId) throw new Error('上游未开启验证码配置，无法领取（可稍后重试）')
      await loadSdk()
      if (!current()) return
      ensureHolder()
      initCaptcha(cfg, current, () => {
        if (!current()) return
        if (options.interactive === false) {
          pendingResolve = null
          pendingReject = null
          captchaState.value = 'idle'
          captchaMessage.value = ''
          cleanup()
          reject(Object.assign(new Error('需要人工验证，请点击该账号的领取按钮完成验证'), { code: 'captcha_interactive' }))
          return
        }
        captchaState.value = 'interactive'
        captchaMessage.value = '需要人工验证：请点击下方按钮完成拼图'
      })
    })().catch((error) => {
      if (!current()) return
      pendingResolve = null
      pendingReject = null
      captchaState.value = 'idle'
      cleanup()
      reject(error)
    })
  })
}

function ensureHolder() {
  if (document.getElementById('zcgw-captcha-holder')) return
  const holder = document.createElement('div')
  holder.id = 'zcgw-captcha-holder'
  // 阿里云弹窗模式自己渲染遮罩；容器定位到角落避免撑开布局
  holder.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:300;width:0;height:0;overflow:visible'
  const btn = document.createElement('button')
  btn.id = 'zcgw-captcha-btn'
  btn.textContent = '点击完成验证'
  btn.style.cssText = 'position:absolute;right:0;bottom:0;padding:8px 14px'
  holder.appendChild(btn)
  document.body.appendChild(holder)
}

/** 取消会结束等待中的调用，释放账号操作状态。 */
export function cancelCaptcha() {
  verificationId++
  const reject = pendingReject
  pendingResolve = null
  pendingReject = null
  captchaState.value = 'idle'
  captchaMessage.value = ''
  cleanup()
  reject?.(new Error('已取消人机验证'))
}

declare global {
  interface Window {
    initAliyunCaptcha?: (options: Record<string, unknown>) => void
    AliyunCaptchaConfig?: { region: string; prefix: string }
  }
}
