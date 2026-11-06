import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

// Execute the real browser modules with minimal DOM/SDK boundaries, without npm dependencies.
async function loadModule(file, harness) {
  const key = `claimTest${Math.random().toString(36).slice(2)}`;
  globalThis[key] = harness;
  const source = stripTypeScriptTypes(await readFile(new URL(`../web/src/${file}.ts`, import.meta.url), 'utf8'), { mode: 'transform' })
    .replace(/^import \{([^}]+)\} from ['"][^'"]+['"];?\s*$/gm, (_, names) => `const { ${names} } = globalThis.${key};`);
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`); }
  finally { delete globalThis[key]; }
}
const ref = (value) => ({ value });
const computed = (get) => ({ get value() { return get(); } });

test('captcha proof includes region; cancellation and late SDK callbacks cannot hang or resolve another verification', async (t) => {
  const originalWindow = globalThis.window, originalDocument = globalThis.document;
  t.after(() => { globalThis.window = originalWindow; globalThis.document = originalDocument; });
  const nodes = new Map();
  globalThis.document = {
    getElementById: (id) => nodes.get(id),
    createElement: () => ({ style: {}, appendChild() {} }),
    body: { appendChild: (node) => nodes.set(node.id, node) },
  };
  let sdkOptions, configCalls = 0, finishConfig;
  globalThis.window = {
    setTimeout: () => 0,
    initAliyunCaptcha: (options) => { sdkOptions = options; options.getInstance({ startTracelessVerification() {}, destroy() {} }); },
  };
  const captcha = await loadModule('captcha', { ref, api: () => {
    configCalls++;
    return new Promise((resolve) => { finishConfig = resolve; });
  } });
  const cancelled = captcha.runCaptcha();
  const rejection = assert.rejects(cancelled, /取消/);
  await assert.rejects(captcha.runCaptcha(), /上一次验证/);
  captcha.cancelCaptcha();
  await rejection;
  finishConfig({ enabled: true, region: 'sgp', prefix: 'test', sceneId: 'scene' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sdkOptions, undefined, 'cancelled config lookup cannot open a captcha later');
  const first = captcha.runCaptcha();
  await new Promise((resolve) => setImmediate(resolve));
  const oldOptions = sdkOptions;
  oldOptions.success({ captchaVerifyParam: ' first-proof ' });
  assert.deepEqual(await first, { param: 'first-proof', region: 'sgp' });
  const next = captcha.runCaptcha();
  await new Promise((resolve) => setImmediate(resolve));
  oldOptions.success('must-not-resolve-next');
  assert.equal(captcha.captchaState.value, 'verifying');
  sdkOptions.fail('interactive');
  assert.equal(captcha.captchaState.value, 'interactive');
  sdkOptions.success('second-proof');
  assert.deepEqual(await next, { param: 'second-proof', region: 'sgp' });
  assert.equal(configCalls, 1, 'successful config is cached');
  assert.equal(nodes.get('zcgw-captcha-holder').style.display, 'none');
});

test('console prepares before captcha, forwards region and stops on 3007 without another activation or verification', async (t) => {
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout: () => 0 };
  t.after(() => { globalThis.window = originalWindow; });
  const calls = [];
  let missingPlan = false, deferPreparation = false, finishPreparation;
  const module = await loadModule('console', {
    ref, computed, ApiError: class extends Error {}, captchaState: ref('idle'), captchaMessage: ref(''),
    cancelCaptcha: () => {},
    runCaptcha: async () => { calls.push({ path: 'captcha' }); return { param: 'proof', region: 'sgp' }; },
    api: async (path, method, body) => {
      calls.push({ path, method, body });
      if (path.endsWith('/claim/start')) {
        if (missingPlan) throw new Error('该套餐已不在可领取列表');
        if (deferPreparation) return new Promise((resolve) => { finishPreparation = resolve; });
        return { preparationId: 'prepared', plan: { planId: 'arbitrary', name: '随时改名的套餐' } };
      }
      if (path.endsWith('/claim')) return { results: [{ ok: false, code: 3007, msg: '验证码校验失败' }] };
      if (path === '/overview') return { accounts: [], stats: {}, settings: {} };
      throw new Error(`unexpected request ${path}`);
    },
  });
  const state = module.useConsole();
  await state.action('account/1', 'quota', 'arbitrary');
  assert.deepEqual(calls.map((c) => c.path), ['/accounts/account%2F1/claim/start', 'captcha', '/accounts/account%2F1/claim', '/overview']);
  assert.deepEqual(calls[2].body, { planId: 'arbitrary', preparationId: 'prepared', captchaParam: 'proof', captchaRegion: 'sgp' });
  assert.equal(state.toasts.value.at(-1).text, '验证码校验失败');
  assert.equal(state.busy.value.size, 0);
  calls.length = 0; missingPlan = true;
  await state.action('account/1', 'quota', 'gone');
  assert.deepEqual(calls.map((c) => c.path), ['/accounts/account%2F1/claim/start']);
  assert.equal(state.busy.value.size, 0);
  calls.length = 0; missingPlan = false; deferPreparation = true;
  const pending = state.action('account/1', 'quota', 'arbitrary');
  state.cancelClaim();
  finishPreparation({ preparationId: 'prepared', plan: { planId: 'arbitrary', name: '任意套餐' } });
  await pending;
  assert.deepEqual(calls.map((c) => c.path), ['/accounts/account%2F1/claim/start'], 'cancellation while preparing must not open captcha later');
  assert.equal(state.busy.value.size, 0);
});

test('console starts one probe and polls its result without resubmitting after a failed status request', async (t) => {
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout: (fn, ms) => { if (ms === 1000) queueMicrotask(fn); return 0; } };
  t.after(() => { globalThis.window = originalWindow; });
  const calls = [];
  let failPoll = false;
  const module = await loadModule('console', {
    ref, computed, ApiError: class extends Error {}, captchaState: ref('idle'), captchaMessage: ref(''), cancelCaptcha() {},
    api: async (path, method) => {
      calls.push({ path, method });
      if (path.endsWith('/selftest')) return { jobId: 'job-1', status: 'running', result: null };
      if (path.endsWith('/selftest/job-1')) {
        if (failPoll) throw new Error('Cloudflare 暂时不可达');
        return { jobId: 'job-1', status: 'completed', result: { ok: false, account: 'probe', code: 'upstream_http',
          error: '上游返回 HTTP 502', rayId: 'a5678101b9b51c0a-AMS' } };
      }
      if (path === '/overview') return { accounts: [], stats: {}, settings: {} };
      throw new Error(`unexpected request ${path}`);
    },
  });
  const state = module.useConsole();
  await state.action('probe', 'probe');
  assert.deepEqual(calls.map((c) => c.path), ['/accounts/probe/selftest', '/accounts/probe/selftest/job-1', '/overview']);
  assert.match(state.toasts.value.at(-1).text, /上游返回 HTTP 502.*上游 Ray ID/);
  assert.equal(state.toasts.value.at(-1).error, true);
  assert.equal(state.busy.value.size, 0);
  failPoll = true;
  calls.length = 0;
  await state.action('probe', 'probe');
  assert.deepEqual(calls.map((c) => c.path), ['/accounts/probe/selftest', '/accounts/probe/selftest/job-1']);
  assert.equal(state.busy.value.size, 0);
  assert.equal(state.toasts.value.at(-1).text, 'Cloudflare 暂时不可达');
});

test('authorization synchronization updates account state and stops on session reset without submitting refresh or claim again', async (t) => {
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout: (fn, ms) => { if (ms === 1000) queueMicrotask(fn); return 0; } };
  t.after(() => { globalThis.window = originalWindow; });
  let count = 0, defer = false, resolveRequest;
  const calls = [];
  const complete = { id: 'account-1', eligibilityRefreshing: false, quotaSources: [], eligibility: {
    status: 'ready', plans: [], activation: { status: 'ready', error: null } } };
  const module = await loadModule('console', {
    ref, computed, ApiError: class extends Error {}, captchaState: ref('idle'), captchaMessage: ref(''), cancelCaptcha() {},
    visibleQuotaSources: (sources) => sources,
    api: async (path, method) => {
      calls.push({ path, method });
      assert.equal(path, '/overview');
      if (defer) return new Promise((resolve) => { resolveRequest = resolve; });
      count++;
      return { accounts: [count === 1 ? { ...complete, eligibilityRefreshing: true, eligibility: null } : complete], stats: {}, settings: {} };
    },
  });
  const state = module.useConsole();
  await state.syncAuthorizedAccount('account-1');
  assert.equal(count, 2);
  assert.equal(state.accounts.value[0].eligibility.activation.status, 'ready');
  assert.equal(state.toasts.value.at(-1).text, '授权已更新，资格与额度已自动刷新');
  const notifications = state.toasts.value.length;
  defer = true;
  const waiting = state.syncAuthorizedAccount('account-1');
  state.reset();
  resolveRequest({ accounts: [complete], stats: {}, settings: {} });
  await waiting;
  assert.equal(state.accounts.value.length, 0);
  assert.equal(state.toasts.value.length, notifications);
  assert.ok(calls.every((call) => call.path === '/overview' && call.method === undefined));
});
