const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
const captchaError = (message, code = 'captcha_unavailable') => Object.assign(new Error(message), { code });

/** Use the same official SDK as zcode-switch. Interactive challenges are left for the user. */
export function createCaptchaBrowser({ executablePath = process.env.ZCGW_CHROMIUM_PATH || '/usr/bin/chromium', launch } = {}) {
  let browser;
  async function perform(config) {
    if (!config.enabled || !config.sceneId) throw captchaError('上游验证码配置不可用，请稍后重试');
    let context;
    try {
      if (!browser) {
        let start = launch;
        if (!start) {
          try { const { chromium } = await import('playwright-core'); start = (options) => chromium.launch(options); }
          catch { throw captchaError('缺少浏览器依赖，请运行 npm ci 或更新到包含定时领取的 Docker 镜像'); }
        }
        try { browser = await start({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 15000 }); }
        catch { throw captchaError('自动验证浏览器启动失败，请检查 Chromium 安装或 ZCGW_CHROMIUM_PATH'); }
      }
      context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      // A local page carries only captcha configuration. Account credentials never enter the browser.
      await page.route('http://127.0.0.1/zcgw-auto-captcha', (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="holder"></div><button id="verify">验证</button></body></html>',
      }));
      await page.goto('http://127.0.0.1/zcgw-auto-captcha');
      // addScriptTag has no timeout option; bound the entire SDK load explicitly.
      await page.evaluate(({ url }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SDK load timeout')), 20000);
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => { clearTimeout(timer); resolve(true); };
        script.onerror = () => { clearTimeout(timer); reject(new Error('SDK load failed')); };
        document.head.appendChild(script);
      }), { url: SDK_URL });
      const result = await page.evaluate((cfg) => new Promise((resolve) => {
        let finished = false;
        let instance;
        const finish = (value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try { instance?.destroy?.(); } catch {}
          resolve(value);
        };
        const timer = setTimeout(() => finish({ interactive: true }), 8000);
        window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix };
        try {
          window.initAliyunCaptcha({ SceneId: cfg.sceneId, mode: 'popup', language: 'zh-CN', showErrorTip: false,
            element: '#holder', button: '#verify',
            getInstance: (value) => {
              instance = value;
              if (finished) { value.destroy?.(); return; }
              if (typeof value.startTracelessVerification === 'function') value.startTracelessVerification();
              else finish({ interactive: true });
            },
            success: (value) => {
              const param = typeof value === 'string' ? value : value?.captchaVerifyParam;
              finish(param?.trim() ? { param: param.trim() } : { interactive: true });
            },
            fail: () => finish({ interactive: true }), onError: () => finish({ interactive: true }),
          });
        } catch { finish({ interactive: true }); }
      }), config);
      if (!result.param) throw captchaError('需要人工验证，请到账号管理中点击领取完成验证', 'captcha_interactive');
      return { param: result.param, region: config.region };
    } catch (error) {
      if (error.code) throw error;
      throw captchaError('自动验证未完成，请检查验证码网络或到账号管理中手动领取');
    } finally { await context?.close().catch(() => {}); }
  }
  async function verify(config) {
    let timer;
    try {
      return await Promise.race([perform(config), new Promise((_, reject) => {
        timer = setTimeout(() => {
          void close().catch(() => {});
          reject(captchaError('自动验证超时，请稍后重试或手动领取'));
        }, 50000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function close() { const current = browser; browser = null; await current?.close(); }
  return { verify, close };
}
