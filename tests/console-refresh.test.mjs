import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const jwt = (id) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ user_id: id })).toString('base64url')}.test`;

test('authenticated console refresh preserves distinct sources and partial failures', { timeout: 25000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-quota-test-'));
  const credentials = [
    { label: 'disabled-account', jwt: jwt('disabled'), disabled: true, codingPlanApiKey: 'test-coding-key', realm: 'intl' },
    { label: 'unconfigured', jwt: jwt('unconfigured'), realm: 'cn' },
    { label: 'activation-account', jwt: jwt('activation-account'), disabled: true, realm: 'cn', activationUserId: 'authorized-profile' },
    { label: 'activation-failure', jwt: jwt('activation-failure'), realm: 'cn', activationUserId: 'failed-profile' },
    { label: 'profile-account', jwt: jwt('profile-account'), realm: 'cn', zaiAccessToken: 'test-profile-token' },
  ];
  await writeFile(path.join(dataDir, 'accounts.json'), JSON.stringify(credentials));
  let failBalance = false;
  let failPreview = false;
  let emptyMarketing = false;
  let failMarketing = false;
  let previewReply;
  let marketingReply;
  let balanceReply;
  let claimCode = 0;
  const renewedJwt = jwt('unconfigured') + '-renewed';
  let claimReply;
  let currentReply;
  let claims = 0;
  let claimBody;
  let balanceCalls = 0;
  const activationEvents = [];
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const reply = ({ body, status = 200 }) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const send = (data, code = 0, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code, data }));
    };
    if (url.pathname === '/cn/changelog') return reply({ body: '<h2>Release v3.18.0</h2><h2>Release v3.17.2</h2>' });
    if (url.pathname.endsWith('/client/configs')) return send({ configs: { captcha: { enabled: true, region: 'sgp', prefix: 'test-prefix', sceneId: 'test-scene' } } });
    if (url.pathname.endsWith('/billing/current')) {
      if (currentReply) return reply(currentReply);
      return send({ plans: [{ plan_id: 'already-owned', user_plan_id: 'user-plan-1', name: '任意已领套餐', status: 'active',
        starts_at: 1770000000, ends_at: 1800000000, entitlements: [{ effective_at: 0 }] }] });
    }
    if (url.pathname.endsWith('/oauth/cli/init')) {
      return send({ flow_id: 'test-login', authorize_url: 'https://example.invalid/login?state=test-login', poll_interval_sec: 1 });
    }
    if (url.pathname.endsWith('/oauth/cli/poll/test-login')) {
      return send({ status: 'ready', token: renewedJwt, user: { id: 'reauthed-profile', user_id: 'different-namespace', name: 'Test user' } });
    }
    if (url.pathname.endsWith('/customer/getCustomerInfo')) {
      assert.equal(req.headers.authorization, 'Bearer test-profile-token');
      return send({ customerNumber: 'customer-profile-id', phoneNumber: '138****0000', countryCode: '+86' }, 200);
    }
    if (url.pathname.endsWith('/event/report')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      activationEvents.push({ body, headers: req.headers, requestIndex: requests.length - 1 });
      await delay(20);
      if (body.user_id === 'failed-profile') return send({ message: 'secret-upstream-detail' }, 3012, 403);
      return reply({ body: { code: 0 } });
    }
    if (url.pathname.endsWith('/billing/balance')) {
      balanceCalls++;
      if (balanceReply) return reply(balanceReply);
      if (failBalance) return send(null, 1006, 401);
      return send({
        plans: [
          { plan_id: 'start', name: 'Start Plan', status: 'active', ends_at: 1800000000 },
          { plan_id: 'promo', name: 'Z.ai 活动包', status: 'active', ends_at: 1800000000 },
        ],
        balances: [
          { plan_id: 'start', show_name: 'GLM A', total_units: 100, remaining_units: 30, period_end: 1800000000 },
          { plan_id: 'promo', show_name: 'GLM A', total_units: 400, remaining_units: 350 },
        ],
      });
    }
    if (url.pathname.endsWith('/quota/limit')) {
      assert.equal(req.headers.authorization, 'Bearer test-coding-key');
      return send({ level: 'Pro', limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 100, currentValue: 20 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 1000, currentValue: 200 },
      ] }, 200);
    }
    if (url.pathname.endsWith('/billing/preview')) {
      if (req.headers.authorization === `Bearer ${jwt('activation-account')}`) {
        const activated = activationEvents.filter((e) => e.body.user_id === 'authorized-profile').length === 2
          && req.headers['x-zcode-app-version'] === '3.18.0';
        return send({ plans: activated ? [{ plan_id: 'activated-offer', name: 'Activated offer' }] : [] });
      }
      if (previewReply) return reply(previewReply);
      if (failPreview) return send(null, 1006, 401);
      return send({ plans: [{ plan_id: 'gift', name: '注册礼包', priority: 10, entitlements: [] }] });
    }
    if (url.pathname.endsWith('/marketing/touch')) {
      if (marketingReply) return reply(marketingReply);
      if (failMarketing) return send(null, 500, 500);
      return send({ deliveries: emptyMarketing ? [] : [
        { buttons: [{ action: { type: 'claim_zcode_plan', args: { plan_id: 'gift' } } },
          { action: { type: 'claim_zcode_plan', args: { plan_id: 'campaign' } } }] },
      ] });
    }
    if (url.pathname.endsWith('/billing/claim')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      claimBody = JSON.parse(Buffer.concat(chunks));
      claims++;
      assert.equal(req.headers['x-aliyun-captcha-verify-param'], 'test-captcha');
      if (claimReply) return reply(claimReply);
      return send({ plan: { plan_id: claimBody.plan_id } }, claimCode);
    }
    send(null, 404, 404);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const portProbe = http.createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const child = spawn(process.execPath, ['zcgw-server.mjs'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PANEL_KEY: 'test-panel', GATEWAY_KEY: '',
      ZCGW_DATA_DIR: dataDir, ZCODE_HOME: path.join(dataDir, 'empty'), ZCODE_UPSTREAM_ORIGIN: upstreamUrl,
      ZCODE_ZAI_ORIGIN: upstreamUrl, ZCODE_BIGMODEL_ORIGIN: upstreamUrl, ZCGW_WEEKEND_GRAB: '0', ZCODE_HTTP_TRANSPORT: 'fetch', ZCODE_APP_VERSION: '3.16.3' },
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
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
    await delay(40);
  }
  assert.ok(ready, logs);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
  assert.equal((await (await fetch(`${base}/health`)).json()).version, pkg.version);
  assert.equal((await fetch(`${base}/api/accounts/disabled-account/refresh`, { method: 'POST' })).status, 401);
  const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'test-panel' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (route, method = 'GET', body) => {
    const r = await fetch(`${base}${route}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  // The initial internal refresh must work despite PANEL_KEY.
  for (let i = 0; i < 100 && balanceCalls < credentials.length; i++) await delay(40);
  assert.ok(balanceCalls >= credentials.length, 'background refresh bypasses HTTP session boundary');
  assert.equal(activationEvents.length, 0, 'background refresh never reports activation events');
  let result = (await api('/api/accounts/disabled-account/refresh', 'POST', {})).body;
  assert.equal(result.quotaSources.length, 2);
  assert.deepEqual(result.quotaSources.map((s) => s.status), ['ready', 'ready']);
  assert.deepEqual(result.quotaSources[0].plans.map((p) => p.name), ['Start Plan', 'Z.ai 活动包']);
  assert.equal(result.quotaSources[1].plans[0].items.length, 2);
  assert.deepEqual(result.eligibility.plans.map((p) => p.planId), ['gift', 'campaign']);
  assert.equal(claims, 0, 'refresh never claims a plan');
  let overview = (await api('/api/overview')).body;
  assert.equal(overview.accounts[0].enabled, false);
  assert.equal(overview.accounts[0].plans.length, 2);
  assert.equal(overview.accounts[1].quotaSources[1].status, 'unconfigured');
  assert.ok(!JSON.stringify(overview).includes('test-coding-key'), 'keys never reach overview');
  assert.ok(!JSON.stringify(overview).includes(credentials[0].jwt), 'JWT never reaches overview');
  const previous = result.quotaSources[0];
  failBalance = true;
  failPreview = true;
  result = (await api('/api/accounts/disabled-account/refresh', 'POST', {})).body;
  assert.equal(result.quotaSources[0].status, 'error');
  assert.deepEqual(result.quotaSources[0].plans, previous.plans);
  assert.equal(result.quotaSources[0].syncedAt, previous.syncedAt);
  assert.equal(result.quotaSources[1].status, 'ready');
  assert.equal(result.eligibility.status, 'partial');
  assert.equal(result.eligibility.plans.length, 2);
  emptyMarketing = true;
  result = (await api('/api/accounts/disabled-account/refresh', 'POST', {})).body;
  assert.equal(result.eligibility.status, 'partial', 'one failure is not no eligibility');
  assert.equal(result.eligibility.plans.length, 0);
  failMarketing = true;
  result = (await api('/api/accounts/disabled-account/refresh', 'POST', {})).body;
  assert.equal(result.eligibility.status, 'error');
  failBalance = failPreview = failMarketing = emptyMarketing = false;
  result = (await api('/api/accounts/disabled-account/claim', 'POST', { planId: 'campaign', captchaParam: 'test-captcha' })).body;
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].expired, undefined, 'successful claim must not be marked expired by a truthy empty array');
  assert.deepEqual(claimBody, { plan_id: 'campaign' });
  assert.equal(claims, 1);
  assert.equal((await api('/api/accounts/missing/refresh', 'POST', {})).status, 404);
  const legacy = (await api('/quota')).body;
  assert.equal(typeof legacy.accounts[0].balances[0].periodEnd, 'number');
  assert.equal((await api('/api/accounts/disabled-account', 'PATCH', { codingPlanApiKey: '' })).status, 200);
  overview = (await api('/api/overview')).body;
  assert.equal(overview.accounts[0].hasCodingPlanKey, false);
  assert.equal(overview.accounts[0].quotaSources[1].status, 'unconfigured');
  assert.equal(overview.accounts[0].enabled, false);

  const refreshEligibility = async () => (await api('/api/accounts/disabled-account/refresh', 'POST', {})).body.eligibility;
  await t.test('successful empty preview responses and preview 404 mean no eligible plans', async () => {
    marketingReply = { body: { code: 0, data: { deliveries: [] } } };
    for (const response of [
      { body: { code: 0 } },
      { body: { code: 0, data: null } },
      { body: { code: '0', data: {} } },
      { body: { code: 0, data: { plans: null } } },
      { body: { code: 0, data: { plans: [] } } },
      { body: '', status: 404 },
    ]) {
      previewReply = response;
      const state = await refreshEligibility();
      assert.equal(state.status, 'ready', JSON.stringify(response));
      assert.deepEqual(state.plans, []);
      assert.equal(state.error, null);
    }
    assert.equal(claims, 1, 'refresh must not submit a claim');
  });

  await t.test('successful empty marketing responses also mean no eligible plans', async () => {
    previewReply = { body: { code: 0, data: null } };
    for (const data of [undefined, null, {}, { deliveries: null }, { deliveries: [] }]) {
      marketingReply = { body: { code: 0, data } };
      const state = await refreshEligibility();
      assert.equal(state.status, 'ready');
      assert.deepEqual(state.plans, []);
      assert.equal(state.error, null);
    }
  });

  await t.test('empty eligibility compatibility does not hide upstream failures or invalid balances', async () => {
    marketingReply = { body: { code: 0, data: { deliveries: [] } } };
    for (const response of [
      { body: { code: 1006 }, status: 401 },
      { body: '<html>server error</html>', status: 500 },
      { body: { code: 3012 } },
      { body: { code: 0, success: false } },
      { body: '<html>not JSON</html>' },
      { body: null },
      { body: {} },
      { body: { code: 0, data: 'invalid' } },
      { body: { code: 0, data: { plans: {} } } },
    ]) {
      previewReply = response;
      const state = await refreshEligibility();
      assert.equal(state.status, 'partial', JSON.stringify(response));
      assert.match(state.error, /套餐资格/);
      if (response.status) assert.ok(state.error.includes(`HTTP ${response.status}`));
      if (response.body?.code === 3012) assert.match(state.error, /3012/);
      assert.deepEqual(state.plans, []);
    }
    previewReply = { body: { code: 0, data: null } };
    marketingReply = { body: '', status: 404 };
    assert.match((await refreshEligibility()).error, /活动资格.*404/);
    marketingReply = { body: { code: 0, data: { deliveries: [] } } };
    balanceReply = { body: { code: 0, data: null } };
    const current = (await api('/api/accounts/disabled-account/refresh', 'POST', {})).body;
    assert.equal(current.eligibility.status, 'ready');
    assert.equal(current.quotaSources[0].status, 'error', 'balance data must still be required');
    assert.deepEqual(current.quotaSources[0].plans, previous.plans);
    balanceReply = undefined;
  });

  await t.test('marketing discovers embedded plans, deduplicates buttons and preserves preview priority', async () => {
    const payload = { plan_id: 'payload-plan', name: 'GLOBAL BUILD', description: '活动说明', priority: 50,
      entitlements: [{ meter: 'model_usage', unit_type: 'token', show_name: 'GLM-5.3', grant_units: 123, period: 'one_time' }] };
    previewReply = { body: { code: 0, data: null } };
    marketingReply = { body: { code: 0, data: { deliveries: [{ banner: {
      background: { args: { zcode_plan: payload } },
      success_popup: { hero: { args: { zcode_plan: payload } } },
      side_panel: { hero: { args: { zcode_plan: { plan_id: 'embedded-only', name: 'Embedded offer', priority: 5 } } } },
      buttons: [
        { action: { type: 'claim_zcode_plan', args: { plan_id: 'payload-plan' } } },
        { action: { type: 'claim_plan', planId: 'button-only' } },
        { action: { type: 'navigate', args: { plan_id: 'ignore-me' } } },
      ],
    } }] } } };
    let state = await refreshEligibility();
    assert.equal(state.status, 'ready');
    assert.deepEqual(state.plans.map((p) => p.planId), ['payload-plan', 'embedded-only', 'button-only']);
    assert.equal(state.plans[0].name, 'GLOBAL BUILD');
    assert.deepEqual(state.plans[0].entitlements, [{ model: 'GLM-5.3', grant: 123, period: 'one_time' }]);
    previewReply = { body: { code: 0, data: { plans: [null, { planId: 'payload-plan', name: 'Preview name', priority: 10 }, { plan_id: '' }] } } };
    state = await refreshEligibility();
    assert.equal(state.plans[0].name, 'Preview name');
    assert.equal(state.plans[0].description, '活动说明');
    assert.equal(state.plans[0].priority, 10);
    assert.equal(state.plans.length, 3);
    previewReply = { body: { code: 1006 }, status: 401 };
    const fallback = (await api('/api/accounts/disabled-account/claim', 'POST', { captchaParam: 'test-captcha' })).body;
    assert.equal(fallback.results[0].ok, true, 'marketing plans remain claimable when preview fails');
    assert.equal(claimBody.plan_id, 'payload-plan');
    assert.equal(claims, 2);
  });

  await t.test('claim preserves lookup errors and does not equate already claimed with expired', async () => {
    marketingReply = { body: { code: 0, data: { deliveries: [] } } };
    const failure = (await api('/api/accounts/disabled-account/claim', 'POST', { captchaParam: 'test-captcha' })).body;
    assert.equal(failure.results[0].ok, false);
    assert.match(failure.results[0].msg, /套餐资格.*401/);
    assert.equal(claims, 2);
    previewReply = { body: { code: 0, data: null } };
    previewReply = { body: { code: 0, data: { plans: [{ plan_id: 'start', name: '任意套餐' }] } } };
    claimCode = 1003;
    const duplicate = (await api('/api/accounts/disabled-account/claim', 'POST', { planId: 'start', captchaParam: 'test-captcha' })).body;
    assert.equal(duplicate.results[0].alreadyClaimed, true);
    assert.equal(duplicate.results[0].ok, false);
    claimCode = 0;
    assert.equal(duplicate.results[0].expired, undefined);
  });

  await t.test('preview query and identity headers use the same client platform and version', () => {
    const req = requests.find((r) => r.path.endsWith('/billing/preview'));
    assert.equal(req.method, 'GET');
    assert.equal(req.query.platform, `${process.platform}-${process.arch}`);
    assert.equal(req.query.platform, req.headers['x-platform']);
    assert.equal(req.query.app_version, '3.18.0');
    assert.equal(req.headers['user-agent'], 'ZCode/3.18.0');
    assert.equal(req.headers['x-release-channel'], 'production');
    assert.equal(req.headers['x-os-version'], os.release());
    assert.equal(req.headers['x-client-timezone'], Intl.DateTimeFormat().resolvedOptions().timeZone);
    for (const key of ['x-api-key', 'anthropic-version', 'anthropic-beta']) assert.equal(req.headers[key], undefined);
    assert.equal(req.query.app_version, req.headers['x-zcode-app-version']);
    for (const key of ['authorization', 'x-device-mid', 'x-zcode-app-version', 'x-platform', 'x-os-category', 'x-client-language', 'x-client-timezone', 'x-title', 'user-agent']) {
      assert.ok(req.headers[key], `missing ${key}`);
    }
  });

  await t.test('manual refresh activates the authorized identity before discovery and deduplicates repeated requests', async () => {
    previewReply = marketingReply = undefined;
    const before = activationEvents.length;
    await api('/claimable');
    await api('/api/overview');
    assert.equal(activationEvents.length, before, 'read-only queries never activate an account');
    const requestStart = requests.length;
    const claimCount = claims;
    const [first, parallel] = await Promise.all([
      api('/api/accounts/activation-account/refresh', 'POST', {}),
      api('/api/accounts/activation-account/refresh', 'POST', {}),
    ]);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, parallel.body);
    const state = first.body.eligibility;
    assert.equal(state.activation.status, 'ready');
    assert.equal(state.version.reported, '3.18.0');
    assert.equal(state.version.configured, '3.16.3');
    assert.equal(state.version.latest, '3.18.0');
    assert.equal(state.diagnostics.preview.parsedCount, 1);
    assert.equal(state.currentPlans[0].effectiveAt, 0);
    assert.equal(state.activation.error, null);
    assert.ok(Date.parse(state.activation.retryAt) > Date.parse(state.activation.checkedAt));
    assert.ok(state.plans.some((p) => p.planId === 'activated-offer'));
    const events = activationEvents.slice(before);
    assert.deepEqual(events.map((e) => e.body.element_name), ['app_launch', 'app_daily_active']);
    assert.notEqual(events[0].body.event_id, events[1].body.event_id);
    const previewIndex = requests.findIndex((r, i) => i >= requestStart && r.path.endsWith('/billing/preview'));
    assert.ok(previewIndex > events[1].requestIndex, 'discovery must follow both activation events');
    const preview = requests[previewIndex];
    for (const event of events) {
      assert.equal(event.body.user_id, 'authorized-profile', 'use saved OAuth user info rather than the gateway JWT ID');
      assert.equal(event.body.device_mid, preview.headers['x-device-mid']);
      assert.equal(event.body.app_version, preview.headers['x-zcode-app-version']);
      assert.equal(event.body.device_os_category, preview.headers['x-os-category']);
      assert.equal(event.body.client_timezone, preview.headers['x-client-timezone']);
      assert.equal(event.headers.authorization, undefined, 'telemetry contains no login tokens');
    }
    const again = (await api('/api/accounts/activation-account/refresh', 'POST', {})).body;
    assert.deepEqual(again.eligibility.activation, state.activation);
    assert.equal(activationEvents.length, before + 2, 'activation is limited to once per minute');
    assert.equal(claims, claimCount, 'refresh must not claim an offer');
    const snapshot = (await api('/api/overview')).body.accounts.find((a) => a.id === 'activation-account');
    assert.equal(snapshot.enabled, false, 'disabled accounts can activate without rejoining scheduling');
    assert.equal(snapshot.eligibility.activation.status, 'ready');
  });

  await t.test('activation failure is visible and rate limited while independent discovery continues', async () => {
    const before = activationEvents.length;
    const current = (await api('/api/accounts/activation-failure/refresh', 'POST', {})).body;
    assert.equal(current.eligibility.status, 'ready');
    assert.ok(current.eligibility.plans.length > 0);
    assert.equal(current.eligibility.activation.status, 'error');
    assert.match(current.eligibility.activation.error, /403.*3012/);
    assert.ok(!JSON.stringify(current).includes('secret-upstream-detail'));
    assert.equal(activationEvents.length, before + 1, 'stop after the first rejected event');
    await api('/api/accounts/activation-failure/refresh', 'POST', {});
    assert.equal(activationEvents.length, before + 1, 'failed activation attempts also respect the cooldown');
  });

  await t.test('missing OAuth identity is explicit and existing authorized profiles are retained privately', async () => {
    const before = activationEvents.length;
    const missing = (await api('/api/accounts/unconfigured/refresh', 'POST', {})).body;
    assert.equal(missing.eligibility.status, 'ready');
    assert.equal(missing.eligibility.activation.status, 'unavailable');
    assert.match(missing.eligibility.activation.error, /重新登录/);
    assert.equal(activationEvents.length, before, 'never invent an activation user ID from the gateway JWT');
    const profile = (await api('/api/accounts/profile-account/refresh', 'POST', {})).body;
    assert.equal(profile.eligibility.activation.status, 'ready');
    assert.deepEqual(activationEvents.slice(before).map((e) => e.body.user_id), ['customer-profile-id', 'customer-profile-id']);
    const saved = JSON.parse(await readFile(path.join(dataDir, 'accounts.json')));
    assert.equal(saved.find((a) => a.label === 'profile-account').activationUserId, 'customer-profile-id');
    const overview = (await api('/api/overview')).body;
    assert.ok(!JSON.stringify(overview).includes('customer-profile-id'));
    assert.ok(!JSON.stringify(overview).includes('test-profile-token'));
  });

  await t.test('re-login persists the authorized profile and bypasses an unavailable activation cache', async () => {
    const before = activationEvents.length;
    const claimCount = claims;
    const started = await api('/api/onboard/start', 'POST', { provider: 'bigmodel' });
    assert.equal(started.status, 200);
    const loggedIn = await api(`/api/onboard/poll/${started.body.flowId}`);
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.body.status, 'ready');
    assert.equal(loggedIn.body.added, false);
    assert.equal(loggedIn.body.label, 'unconfigured');
    assert.equal(activationEvents.length, before, 'login alone does not trigger activation');
    const saved = JSON.parse(await readFile(path.join(dataDir, 'accounts.json')));
    assert.equal(saved.find((a) => a.label === 'unconfigured').activationUserId, 'reauthed-profile');
    assert.equal(saved.find((a) => a.label === 'unconfigured').jwt, renewedJwt, 're-login must replace the stored gateway JWT');
    const refreshed = (await api('/api/accounts/unconfigured/refresh', 'POST', {})).body;
    assert.equal(refreshed.eligibility.activation.status, 'ready');
    assert.deepEqual(activationEvents.slice(before).map((e) => e.body.user_id), ['reauthed-profile', 'reauthed-profile']);
    assert.equal(claims, claimCount);
    assert.ok(!JSON.stringify((await api('/api/overview')).body).includes('reauthed-profile'));

    const redeemStart = await api('/api/onboard/start', 'POST', { provider: 'bigmodel' });
    assert.equal(redeemStart.status, 200);
    const redeemed = await api('/api/onboard/redeem', 'POST', {
      flowId: redeemStart.body.flowId,
      url: 'https://example.invalid/callback?code=test-code&state=test-login',
    });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.body.status, 'ready');
  });

  await t.test('prepare validates the selected offer before captcha and consumes the preparation once', async () => {
    previewReply = { body: { code: 0, data: { plans: [{ plan_id: 'renamed-2099', name: '名称可以随时改变' }] } } };
    marketingReply = { body: { code: 0, data: { deliveries: [] } } };
    const before = claims;
    const requestStart = requests.length;
    const invalid = await api('/api/accounts/disabled-account/claim/start', 'POST', { planId: 'nonexistent' });
    assert.equal(invalid.status, 409);
    const prepared = await api('/api/accounts/disabled-account/claim/start', 'POST', { planId: 'renamed-2099' });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.plan.name, '名称可以随时改变');
    assert.equal(claims, before, 'preparation never consumes captcha or submits');
    assert.deepEqual(requests.slice(requestStart).map((r) => r.path.split('/').at(-1)), ['preview', 'touch', 'current', 'preview', 'touch', 'current']);
    const cfg = (await api('/api/captcha/config')).body;
    assert.equal(cfg.region, 'sgp');
    const submission = { planId: prepared.body.plan.planId, preparationId: prepared.body.preparationId,
      captchaParam: 'test-captcha', captchaRegion: cfg.region };
    // Discovery can change while the captcha window is open; use the prepared plan snapshot.
    previewReply = { body: { code: 0, data: null } };
    claimReply = { body: { code: 0 } };
    const submitted = (await api('/api/accounts/disabled-account/claim', 'POST', submission)).body.results[0];
    assert.equal(submitted.ok, true, 'success does not require data.plan');
    assert.equal(submitted.claimed, 'renamed-2099');
    assert.equal(claims, before + 1);
    const request = requests.findLast((r) => r.path.endsWith('/billing/claim'));
    assert.equal(request.headers['x-zcode-app-version'], '3.18.0');
    assert.equal(request.headers['x-aliyun-captcha-verify-region'], 'sgp');
    const replay = (await api('/api/accounts/disabled-account/claim', 'POST', submission)).body.results[0];
    assert.equal(replay.code, 'preparation_expired');
    assert.equal(claims, before + 1);
    assert.equal((await api('/claim', 'POST', { captchaParam: 'test-captcha' })).status, 400);
    claimReply = undefined;
  });

  await t.test('claim errors stop after one selected plan and do not retry captcha or other offers', async () => {
    previewReply = { body: { code: 0, data: { plans: [
      { plan_id: 'first', name: '套餐甲', priority: 10 }, { plan_id: 'second', name: '套餐乙' },
    ] } } };
    marketingReply = { body: { code: 0, data: { deliveries: [] } } };
    for (const code of [1001, 1002, 1003, 1004, 1005, 3001, 3007]) {
      claimReply = { body: { code, data: { plan: { ends_at: 1800000000 } } } };
      const before = claims;
      const result = (await api('/api/accounts/disabled-account/claim', 'POST', { captchaParam: 'test-captcha' })).body.results[0];
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      assert.equal(claimBody.plan_id, 'first');
      assert.equal(claims, before + 1, `code ${code} must be terminal`);
      if (code === 1005) assert.equal(result.nextAt, 1800000000000);
    }
    claimReply = { status: 500, body: { code: 0 } };
    assert.equal((await api('/api/accounts/disabled-account/claim', 'POST', { captchaParam: 'test-captcha' })).body.results[0].ok, false);
    claimReply = { status: 403, body: 'captcha challenge secret-upstream-detail' };
    const challenge = (await api('/api/accounts/disabled-account/claim', 'POST', { captchaParam: 'test-captcha' })).body.results[0];
    assert.equal(challenge.code, -2);
    assert.ok(!JSON.stringify(challenge).includes('secret-upstream-detail'));
    claimReply = { body: { code: 0, data: { server_time: 1794000000, plan: {
      starts_at: 1780000000, ends_at: 1800000000, entitlements: [{ effective_at: 0 }, { effective_at: 1800000000 }],
    } } } };
    const success = (await api('/api/accounts/disabled-account/claim', 'POST', { captchaParam: 'test-captcha' })).body.results[0];
    assert.equal(success.effectiveAt, 0);
    assert.equal(success.startsAt, 1780000000000);
    assert.equal(success.serverTime, 1794000000000);
    claimReply = undefined;
  });

  await t.test('current query failure preserves eligible offers and channel diagnostics', async () => {
    currentReply = { status: 503, body: { code: 9000 } };
    const state = await refreshEligibility();
    assert.equal(state.status, 'ready');
    assert.equal(state.plans.length, 2);
    assert.match(state.currentError, /503.*9000/);
    assert.equal(state.diagnostics.current.status, 503);
    assert.equal(state.diagnostics.current.code, 9000);
    assert.equal(state.diagnostics.preview.count, 2);
    assert.equal(state.diagnostics.preview.transport, 'fetch');
    currentReply = undefined;
  });

});
