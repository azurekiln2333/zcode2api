import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const jwt = (id) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ user_id: id })).toString('base64url')}.test`;

test('console API client completes both OAuth flows through the production routes', { timeout: 25000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-onboard-test-'));
  const flows = new Map();
  const callbacks = [];
  let initFailure = false;
  let pollExpired = false;
  let oauthCalls = 0;
  let slowProfile;
  let profileStarted = false;
  let profileGate;
  let profileRequests = 0;
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (data, code = 0, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code, data, ...(code ? { msg: '授权服务暂时不可用' } : {}) }));
    };
    if (url.pathname.includes('/oauth/')) oauthCalls++;
    if (url.pathname.endsWith('/oauth/cli/init')) {
      if (initFailure) return send(null, 3001, 503);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { provider } = JSON.parse(Buffer.concat(chunks));
      const id = `${provider}:${flows.size + 1}`;
      flows.set(id, { provider, pollToken: req.headers.authorization, ready: false });
      return send({ flow_id: id, authorize_url: `https://example.invalid/authorize?state=${encodeURIComponent(id)}`,
        expires_at: Math.floor(Date.now() / 1000) + 1200, poll_interval_sec: 2 });
    }
    const poll = url.pathname.match(/\/oauth\/cli\/poll\/(.+)$/);
    if (poll) {
      if (pollExpired) return send(null, 3004, 410);
      const id = decodeURIComponent(poll[1]);
      const flow = flows.get(id);
      if (!flow || req.headers.authorization !== flow.pollToken) return send(null, 3004, 410);
      return send(flow.ready
        ? { status: 'ready', token: flow.token || jwt(id), user: { user_id: `profile:${id}`, name: 'OAuth user' },
          ...(flow.oauth || (slowProfile ? { zai: { access_token: 'test-slow-profile' } } : {})) }
        : { status: 'pending' });
    }
    const callback = url.pathname.match(/\/oauth\/cli\/callback\/(zai|bigmodel)$/);
    if (callback) {
      const id = url.searchParams.get('state');
      const flow = flows.get(id);
      if (!flow || flow.provider !== callback[1]) return send(null, 3004, 410);
      callbacks.push({ provider: callback[1], code: url.searchParams.get('code'), state: id });
      flow.ready = true;
      return send({ ok: true });
    }
    if (url.pathname.endsWith('/billing/balance')) return send({ plans: [], balances: [] });
    if (url.pathname === '/api/auth/z/login') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { token } = JSON.parse(Buffer.concat(chunks));
      return token === 'onboard-zai-raw' ? send({ access_token: 'onboard-zai-business' }, 200) : send(null, 401);
    }
    if (url.pathname.endsWith('/customer/getCustomerInfo')) {
      profileStarted = true;
      profileRequests++;
      if (profileGate) await profileGate;
      await slowProfile;
      return send({ email: 'oauth@example.invalid', id: 'customer-profile' }, 200);
    }
    if (url.pathname.endsWith('/quota/limit')) return send({ limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 6 },
    ] }, 200);
    if (url.pathname.endsWith('/subscription/list')) return send([{
      productId: 'trial-coding', productName: 'GLM Coding Plan 优享体验卡', status: 'VALID', inCurrentPeriod: true,
      expireTime: '2026-11-11T15:59:59Z',
    }], 200);
    if (url.pathname.endsWith('/mcp/usage')) return send({ server_time: 1794000000, next_refresh_at: 1794144000,
      total_usage: { used: 0, limit: 500, remaining: 500 } });
    if (url.pathname.endsWith('/client/configs')) return send({ configs: {} });
    if (url.pathname.endsWith('/event/report')) return send({});
    if (/\/billing\/(preview|current)$/.test(url.pathname)) return send({ plans: [] });
    if (url.pathname.endsWith('/marketing/touch')) return send({ deliveries: [] });
    return send(null, 404, 404);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['zcgw-server.mjs'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PANEL_KEY: 'test-panel', GATEWAY_KEY: '',
      ZCGW_DATA_DIR: dataDir, ZCODE_HOME: path.join(dataDir, 'empty'), ZCODE_UPSTREAM_ORIGIN: upstreamUrl,
      ZCODE_ZAI_ORIGIN: upstreamUrl, ZCODE_BIGMODEL_ORIGIN: upstreamUrl, ZCGW_WEEKEND_GRAB: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const realFetch = globalThis.fetch;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await realFetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
    await delay(40);
  }
  assert.ok(ready, logs);

  // Execute the browser's actual API helper so its /api prefix is part of the test.
  const source = stripTypeScriptTypes(await readFile(path.join(root, 'web/src/api.ts'), 'utf8'), { mode: 'transform' });
  const { api, ApiError } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const originalWindow = globalThis.window;
  const events = new EventTarget();
  globalThis.window = { setTimeout, clearTimeout, dispatchEvent: events.dispatchEvent.bind(events) };
  t.after(() => { if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; });
  let cookie = '';
  const clientRequests = [];
  t.mock.method(globalThis, 'fetch', (url, options = {}) => {
    clientRequests.push({ path: url, method: options.method || 'GET' });
    return realFetch(new URL(url, base), { ...options, headers: { ...options.headers, ...(cookie ? { cookie } : {}) } });
  });

  await t.test('all console onboarding routes require a panel session', async () => {
    const before = oauthCalls;
    for (const [route, method, body] of [
      ['/onboard/start', 'POST', { provider: 'zai' }],
      ['/onboard/poll/missing', 'GET'],
      ['/onboard/redeem', 'POST', { flowId: 'missing' }],
    ]) {
      await assert.rejects(api(route, method, body), (error) => error instanceof ApiError && error.status === 401);
    }
    assert.equal(oauthCalls, before);
    const login = await realFetch(`${base}/api/session`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'test-panel' }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
  });

  for (const provider of ['zai', 'bigmodel']) {
    await t.test(`${provider}: start, pending poll, callback redemption and account persistence`, async () => {
      const flow = await api('/onboard/start', 'POST', { provider });
      flows.get(flow.flowId).oauth = provider === 'zai'
        ? { zai: { access_token: 'onboard-zai-raw' } } : { bigmodel: { accessToken: 'onboard-bigmodel-raw' } };
      assert.equal(flow.provider, provider);
      assert.ok(flow.authorizeUrl.startsWith('https://example.invalid/authorize?'));
      assert.ok(flow.expiresAt > Date.now() / 1000);
      const pollPath = `/onboard/poll/${encodeURIComponent(flow.flowId)}`;
      assert.deepEqual(await api(pollPath), { status: 'pending' });
      const code = 'test code +/&';
      const result = await api('/onboard/redeem', 'POST', { flowId: flow.flowId,
        url: `https://example.invalid/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(flow.flowId)}` });
      assert.equal(result.status, 'ready');
      assert.equal(result.added, true);
      assert.equal(result.claim.code, 'captcha_required');
      assert.deepEqual(callbacks.at(-1), { provider, code, state: flow.flowId });
      const overview = await api('/overview');
      assert.ok(overview.accounts.some((a) => a.id === result.label));
      assert.ok(!JSON.stringify(overview).includes(`profile:${flow.flowId}`));
      assert.ok(!JSON.stringify(overview).includes(jwt(flow.flowId)));
      let refreshed;
      for (let i = 0; i < 100; i++) {
        refreshed = (await api('/overview')).accounts.find((a) => a.id === result.label);
        if (!refreshed.eligibilityRefreshing) break;
        await delay(10);
      }
      assert.equal(refreshed.eligibilityRefreshing, false);
      // Profile enrichment writes the same file in the background; inspect it after completion.
      const saved = JSON.parse(await readFile(path.join(dataDir, 'accounts.json')));
      const account = saved.find((a) => a.label === result.label);
      assert.equal(account.jwt, jwt(flow.flowId));
      assert.equal(account.activationUserId, `profile:${flow.flowId}`);
      assert.equal(account.oauthProvider, provider);
      assert.equal(account.codingPlanProvider, provider);
      assert.equal(account[provider === 'zai' ? 'zaiAccessToken' : 'bigmodelAccessToken'], `onboard-${provider}-raw`);
      assert.equal(account[provider === 'zai' ? 'bigmodelAccessToken' : 'zaiAccessToken'], undefined);
      const coding = refreshed.quotaSources.find((source) => source.id === 'coding');
      assert.equal(coding.status, 'ready');
      assert.equal(coding.plans[0].name, 'GLM Coding Plan 优享体验卡');
      assert.deepEqual(coding.plans[0].items.map((item) => item.remainingPercent), [100, 94, 100]);
      assert.ok(!JSON.stringify(refreshed).includes(`onboard-${provider}-raw`));
      await assert.rejects(api(pollPath), (error) => error.status === 410 && /flow 不存在/.test(error.message));
    });
  }

  await t.test('browser-completed authorization is accepted by the console poll endpoint', async () => {
    const flow = await api('/onboard/start', 'POST', { provider: 'zai' });
    flows.get(flow.flowId).ready = true;
    const result = await api(`/onboard/poll/${encodeURIComponent(flow.flowId)}`);
    assert.equal(result.status, 'ready');
    assert.ok((await api('/overview')).accounts.some((a) => a.id === result.label));
  });

  await t.test('a slow customer lookup cannot hold the ready response or consume the flow before the browser gets it', async () => {
    let releaseProfile;
    slowProfile = new Promise((resolve) => { releaseProfile = resolve; });
    try {
      const flow = await api('/onboard/start', 'POST', { provider: 'zai' });
      flows.get(flow.flowId).ready = true;
      const result = await Promise.race([
        api(`/onboard/poll/${encodeURIComponent(flow.flowId)}`),
        delay(1000).then(() => { throw new Error('ready response waited for customer lookup'); }),
      ]);
      assert.equal(result.status, 'ready');
      assert.equal(result.eligibilityRefreshing, true);
      for (let i = 0; i < 100 && !profileStarted; i++) await delay(10);
      assert.ok(profileStarted);
      releaseProfile();
      let account;
      for (let i = 0; i < 100; i++) {
        account = (await api('/overview')).accounts.find((a) => a.id === result.label);
        if (!account.eligibilityRefreshing) break;
        await delay(10);
      }
      assert.equal(account.eligibilityRefreshing, false);
      assert.equal(account.eligibility.activation.status, 'ready');
      assert.equal(account.email, 'oauth@example.invalid');
    } finally { releaseProfile(); slowProfile = null; }
  });

  await t.test('upstream failures and expired flows preserve actionable error messages', async () => {
    initFailure = true;
    await assert.rejects(api('/onboard/start', 'POST', { provider: 'zai' }),
      (error) => error.status === 502 && /授权服务暂时不可用/.test(error.message));
    initFailure = false;
    const flow = await api('/onboard/start', 'POST', { provider: 'zai' });
    pollExpired = true;
    await assert.rejects(api(`/onboard/poll/${encodeURIComponent(flow.flowId)}`),
      (error) => error.status === 410 && /重新发起登录/.test(error.message));
    pollExpired = false;
    await assert.rejects(api('/onboard/redeem', 'POST', { flowId: 'unknown-flow' }),
      (error) => error.status === 410 && /没有匹配的授权流程/.test(error.message));
    assert.ok(clientRequests.every((req) => req.path.startsWith('/api/')));
  });

  await t.test('a profile lookup started before reauthorization cannot overwrite the renewed credentials', async () => {
    let release;
    profileGate = new Promise((resolve) => { release = resolve; });
    slowProfile = Promise.resolve();
    const before = profileRequests;
    try {
      const first = await api('/onboard/start', 'POST', { provider: 'zai' });
      flows.get(first.flowId).ready = true;
      const added = await api(`/onboard/poll/${encodeURIComponent(first.flowId)}`);
      for (let i = 0; i < 100 && profileRequests === before; i++) await delay(10);
      assert.ok(profileRequests > before);
      const second = await api('/onboard/start', 'POST', { provider: 'zai' });
      const renewed = jwt(first.flowId) + '-renewed';
      Object.assign(flows.get(second.flowId), { ready: true, token: renewed });
      const loggedIn = await api(`/onboard/poll/${encodeURIComponent(second.flowId)}`);
      assert.equal(loggedIn.added, false);
      assert.equal(loggedIn.label, added.label);
      release();
      let account;
      for (let i = 0; i < 150; i++) {
        account = (await api('/overview')).accounts.find((a) => a.id === added.label);
        if (!account.eligibilityRefreshing) break;
        await delay(10);
      }
      assert.equal(account.eligibilityRefreshing, false);
      assert.equal(account.eligibility.activation.status, 'ready');
      const saved = JSON.parse(await readFile(path.join(dataDir, 'accounts.json')));
      assert.equal(saved.find((a) => a.label === added.label).jwt, renewed);
      assert.equal(saved.find((a) => a.label === added.label).activationUserId, `profile:${second.flowId}`);
    } finally { release(); profileGate = null; slowProfile = null; }
  });

  await t.test('legacy root onboarding routes remain compatible', async () => {
    const request = async (route, method = 'GET', body) => {
      const response = await realFetch(`${base}${route}`, { method,
        headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const flow = await request('/onboard/start', 'POST', { provider: 'bigmodel' });
    assert.deepEqual(await request(`/onboard/poll/${encodeURIComponent(flow.flowId)}`), { status: 'pending' });
    const result = await request('/onboard/redeem', 'POST', {
      flowId: flow.flowId, code: 'legacy-code', state: flow.flowId,
    });
    assert.equal(result.status, 'ready');
  });
});
