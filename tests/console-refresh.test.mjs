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
  let claims = 0;
  let claimBody;
  let balanceCalls = 0;
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
  for (let i = 0; i < 100 && balanceCalls < 2; i++) await delay(40);
  assert.ok(balanceCalls >= 2, 'background refresh bypasses HTTP session boundary');
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
      entitlements: [{ show_name: 'GLM-5.3', grant_units: 123, period: 'one_time' }] };
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
    claimCode = 1003;
    const duplicate = (await api('/api/accounts/disabled-account/claim', 'POST', { planId: 'start', captchaParam: 'test-captcha' })).body;
    assert.equal(duplicate.results[0].alreadyClaimed, true);
    assert.equal(duplicate.results[0].expired, undefined);
  });

  await t.test('preview query and identity headers use the same client platform and version', () => {
    const req = requests.find((r) => r.path.endsWith('/billing/preview'));
    assert.equal(req.method, 'GET');
    assert.equal(req.query.platform, req.headers['x-platform']);
    assert.equal(req.query.app_version, req.headers['x-zcode-app-version']);
    for (const key of ['authorization', 'x-device-mid', 'x-zcode-app-version', 'x-platform', 'x-os-category', 'x-client-language', 'x-client-timezone', 'x-title', 'user-agent']) {
      assert.ok(req.headers[key], `missing ${key}`);
    }
  });
});
