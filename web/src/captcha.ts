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

let configCache: CaptchaConfig | null = null
let instance: { destroy?: () => void } | null = null
let pendingResolve: ((param: string) => void) | null = null
let pendingReject: ((err: Error) => void) | null = null
let tracelessTimer = 0

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
  if (configCache) return configCache
  configCache = await api<CaptchaConfig>('/captcha/config')
  return configCache
}

function cleanup() {
  clearTimeout(tracelessTimer)
  try {
    instance?.destroy?.()
  } catch {}
  instance = null
}

function initCaptcha(cfg: CaptchaConfig, onFail: (why: unknown) => void) {
  cleanup()
  ;(window as any).AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix }
  ;(window as any).initAliyunCaptcha({
    SceneId: cfg.sceneId,
    mode: 'popup',
    language: 'zh-CN',
    showErrorTip: false,
    element: '#zcgw-captcha-holder',
    button: '#zcgw-captcha-btn',
    getInstance: (i: any) => {
      instance = i
      if (typeof i.startTracelessVerification === 'function') {
        i.startTracelessVerification()
        // 无痕验证 8 秒不回调 → 需要人工点一下（zcode-switch 同款兜底）
        tracelessTimer = window.setTimeout(() => {
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
      clearTimeout(tracelessTimer)
      const p = typeof param === 'string' ? param : param?.captchaVerifyParam
      captchaState.value = 'ready'
      captchaMessage.value = ''
      if (p?.trim() && pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        pendingReject = null
        cleanup()
        resolve(p.trim())
      }
    },
    fail: (p: unknown) => {
      clearTimeout(tracelessTimer)
      onFail(p)
    },
    onError: (p: unknown) => {
      clearTimeout(tracelessTimer)
      onFail(p)
    },
  })
}

/**
 * 跑一次人机验证，resolve 出 captchaVerifyParam。
 * 无痕验证失败/超时会转交互模式，由用户点按钮完成。
 */
export async function runCaptcha(): Promise<string> {
  if (pendingResolve) {
    throw new Error('上一次验证还没完成，请先完成或稍候重试')
  }
  captchaState.value = 'verifying'
  captchaMessage.value = '正在准备人机验证…'
  const cfg = await ensureConfig()
  if (!cfg.enabled || !cfg.sceneId) {
    captchaState.value = 'idle'
    throw new Error('上游未开启验证码配置，无法领取（可稍后重试）')
  }
  await loadSdk()
  return new Promise<string>((resolve, reject) => {
    pendingResolve = resolve
    pendingReject = reject
    const start = () =>
      initCaptcha(cfg, (why) => {
        // 首次无痕失败自动重建一次（zcode-switch：3007/参数无效时换新参数重试一轮）
        if (captchaState.value === 'verifying') {
          captchaState.value = 'interactive'
        }
        if (why && captchaMessage.value === '') {
          captchaMessage.value =
            '需要人工验证：请点击下方按钮完成拼图'
        }
      })
    // 容器节点必须已挂载 —— 用隐藏容器常驻 body
    ensureHolder()
    start()
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

/** 测试钩子：pending 状态复位（组件卸载时用） */
export function cancelCaptcha() {
  pendingResolve = null
  pendingReject = null
  captchaState.value = 'idle'
  cleanup()
}

declare global {
  interface Window {
    initAliyunCaptcha?: (options: Record<string, unknown>) => void
    AliyunCaptchaConfig?: { region: string; prefix: string }
  }
}
