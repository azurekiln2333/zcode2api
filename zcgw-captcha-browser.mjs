const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
const captchaError = (message, code = 'captcha_unavailable') => Object.assign(new Error(message), { code });

/** Use the same official SDK as zcode-switch. Interactive challenges are left for the user. */
export function createCaptchaBrowser({ executablePath = process.env.ZCGW_CHROMIUM_PATH || '',
  endpoint = process.env.ZCGW_BROWSER_CDP_URL || '', launch, connect } = {}) {
  let browser;
  let generation = 0;
  const contexts = new Set();
  const mode = endpoint ? 'remote' : executablePath || launch ? 'local' : 'panel';
  async function perform(config) {
    if (!config.enabled || !config.sceneId) throw captchaError('上游验证码配置不可用，请稍后重试');
    const epoch = generation;
    let context;
    try {
      if (!browser || browser.isConnected?.() === false) {
        if (mode === 'panel') throw captchaError('请保持面板浏览器在线，或配置 ZCGW_BROWSER_CDP_URL', 'browser_unavailable');
        if (mode === 'remote') {
          try {
            const url = new URL(endpoint);
            if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !url.hostname || endpoint.length > 8192) throw new Error();
          } catch { throw captchaError('外部浏览器地址无效，请检查 ZCGW_BROWSER_CDP_URL（支持 HTTP/HTTPS/WS/WSS）'); }
        }
        let start = mode === 'remote' ? connect : launch;
        if (!start) {
          try {
            const { chromium } = await import('playwright-core');
            start = mode === 'remote' ? (url, options) => chromium.connectOverCDP(url, options) : (options) => chromium.launch(options);
          } catch { throw captchaError('缺少浏览器连接组件，请运行 npm ci 或更新镜像'); }
        }
        let connection;
        try {
          connection = mode === 'remote' ? await start(endpoint, { timeout: 15000 })
            : await start({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 15000 });
        } catch { throw captchaError(mode === 'remote'
          ? '无法连接外部浏览器，请检查 ZCGW_BROWSER_CDP_URL 和浏览器服务状态'
          : '已有浏览器启动失败，请检查 ZCGW_CHROMIUM_PATH 指向的可执行文件'); }
        // Cancellation can arrive while a connection is being established.
        if (epoch !== generation) {
          await connection.close().catch(() => {});
          throw captchaError('自动验证已取消', 'captcha_cancelled');
        }
        browser = connection;
      }
      context = await browser.newContext();
      if (epoch !== generation) throw captchaError('自动验证已取消', 'captcha_cancelled');
      contexts.add(context);
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
      if (epoch !== generation) throw captchaError('自动验证已取消', 'captcha_cancelled');
      if (!result.param) throw captchaError('需要人工验证，请到账号管理中点击领取完成验证', 'captcha_interactive');
      return { param: result.param, region: config.region };
    } catch (error) {
      if (['captcha_unavailable', 'captcha_interactive', 'captcha_cancelled', 'browser_unavailable'].includes(error.code)) throw error;
      throw captchaError('自动验证未完成，请检查验证码网络或到账号管理中手动领取');
    } finally { contexts.delete(context); await context?.close().catch(() => {}); }
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
  async function close() {
    generation++;
    const current = browser;
    browser = null;
    const owned = [...contexts];
    contexts.clear();
    await Promise.allSettled(owned.map((context) => context.close()));
    // For connectOverCDP, close disconnects this client; the external browser stays running.
    await current?.close();
  }
  return { verify, close, mode };
}
