import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAccountRecords } from './helpers/store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const jwt = (id) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ user_id: id })).toString('base64url')}.test`;
async function until(condition) {
  for (let i = 0; i < 150; i++) { if (await condition()) return; await delay(20); }
  assert.fail('condition did not become true');
}

test('gateway persists discovered keys across restart and rejects stale discovery writes', { timeout: 20000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-coding-persistence-'));
  const accountFile = path.join(dataDir, 'accounts.json');
  // 旧格式夹具：首次启动会导入数据库并改名 .bak，后续读写都走 SQLite
  const readAccounts = async () => readAccountRecords(dataDir);
  await writeFile(accountFile, JSON.stringify(['saved', 'manual-race', 'reauth-race'].map((id) => ({
    label: id, jwt: jwt(id), oauthProvider: 'bigmodel', realm: 'cn',
    bigmodelAccessToken: `${id}-oauth`, activationUserId: `${id}-profile`,
  }))));
  let expired = false, copyGate, heldKey, releaseCopy, copyStarted = false;
  const keyRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (data, code = 0) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code, data }));
    };
    if (url.pathname.endsWith('/customer/getCustomerInfo')) {
      if (expired && req.headers.authorization === 'saved-oauth') return send(null, 401);
      const owner = req.headers.authorization.replace(/-oauth$/, '');
      return send({ organizations: [{ organizationId: owner, projects: [{ projectId: 'personal', projectType: 0 }] }] }, 200);
    }
    if (url.pathname.includes('/api_keys')) {
      keyRequests.push(url.pathname);
      assert.equal(req.headers['content-type'], 'application/json');
      const owner = req.headers.authorization.replace(/-oauth$/, '');
      if (url.pathname.includes('/copy/')) {
        if (heldKey === owner && copyGate) { copyStarted = true; await copyGate; }
        return send({ secretKey: `${owner}-secret` }, 200);
      }
      assert.equal(req.method, 'GET', 'existing named keys must be reused');
      return send([{ name: 'zcode-api-key', apiKey: `${owner}-public` }], 200);
    }
    if (url.pathname.endsWith('/quota/limit')) {
      const auth = req.headers.authorization;
      if (auth !== 'Bearer manual-override' && !/^Bearer (.+)-public\.\1-secret$/.test(auth)) return send(null, 401);
      return send({ limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 6 },
      ] }, 200);
    }
    if (url.pathname.endsWith('/subscription/list')) return send([{ productName: '任意名称的套餐', status: 'VALID', inCurrentPeriod: true }], 200);
    if (url.pathname.endsWith('/mcp/usage')) return expired && req.headers['x-bigmodel-authorization'] === 'Bearer saved-oauth'
      ? send(null, 401) : send({ total_usage: { used: 0, limit: 500, remaining: 500 } });
    if (url.pathname.endsWith('/billing/balance')) return send({ plans: [], balances: [] });
    if (/\/billing\/(preview|current)$/.test(url.pathname)) return send({ plans: [] });
    if (url.pathname.endsWith('/marketing/touch')) return send({ deliveries: [] });
    if (url.pathname.endsWith('/event/report')) return send({});
    if (url.pathname.endsWith('/client/configs')) return send({ configs: {} });
    if (url.pathname.endsWith('/oauth/cli/init')) return send({ flow_id: 'renew-flow',
      authorize_url: 'https://example.invalid/authorize?state=renew-flow', poll_token: 'renew-poll', poll_interval_sec: 1 });
    if (url.pathname.endsWith('/oauth/cli/poll/renew-flow')) return send({ status: 'ready',
      token: `${jwt('reauth-race')}-renewed`, user: { id: 'reauth-profile' }, bigmodel: { access_token: 'renewed-oauth' } });
    send(null, 404);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  let child, base, cookie;
  let logs = '';
  const stop = async () => { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } };
  t.after(async () => {
    releaseCopy?.(); await stop(); upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(`${base}/api${route}`, { method, headers: { cookie, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, route);
    return response.json();
  };
  const start = async () => {
    const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['zcgw-server.mjs'], { cwd: root, windowsHide: true,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PANEL_KEY: 'test-panel', GATEWAY_KEY: '',
        ZCGW_DATA_DIR: dataDir, ZCODE_HOME: path.join(dataDir, 'empty'), ZCODE_UPSTREAM_ORIGIN: origin,
        ZCODE_BIGMODEL_ORIGIN: origin, ZCODE_BIGMODEL_BIZ_ORIGIN: origin, ZCODE_ZAI_ORIGIN: origin,
        ZCODE_HTTP_TRANSPORT: 'fetch', ZCGW_WEEKEND_GRAB: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (data) => { logs += data; }); child.stderr.on('data', (data) => { logs += data; });
    await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } });
    const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"key":"test-panel"}' });
    cookie = session.headers.get('set-cookie').split(';')[0];
  };
  await start();
  await t.test('successful discovery is private and survives a process restart with expired OAuth', async () => {
    const first = await api('/accounts/saved/refresh', 'POST', {});
    assert.deepEqual(first.quotaSources.find((s) => s.id === 'coding').plans[0].items.map((i) => i.remainingPercent), [100, 94, 100]);
    const saved = (await readAccounts()).find((a) => a.label === 'saved');
    assert.deepEqual(saved.codingPlanCredential, { provider: 'bigmodel', owner: 'saved', apiKey: 'saved-public.saved-secret' });
    assert.equal(saved.codingPlanApiKey, undefined, 'automatic persistence is not a manual override');
    await stop(); expired = true; const before = keyRequests.length; await start();
    const next = await api('/accounts/saved/refresh', 'POST', {});
    const coding = next.quotaSources.find((s) => s.id === 'coding');
    assert.deepEqual(coding.plans[0].items.map((i) => i.remainingPercent), [100, 94]);
    assert.equal(keyRequests.length, before, 'saved key works without API key rediscovery');
    assert.equal(coding.diagnostics.credentials.savedKey, true);
    assert.equal(coding.status, 'error', 'expired MCP OAuth must still be reported');
    for (const body of [first, next, await api('/overview')]) {
      for (const secret of [saved.jwt, saved.bigmodelAccessToken, saved.codingPlanCredential.apiKey]) assert.ok(!JSON.stringify(body).includes(secret));
    }
  });
  const hold = (owner) => {
    heldKey = owner; copyStarted = false;
    copyGate = new Promise((resolve) => { releaseCopy = resolve; });
  };
  await t.test('a manual edit during key discovery is never overwritten by the older request', async () => {
    hold('manual-race');
    const refreshing = api('/accounts/manual-race/refresh', 'POST', {});
    await until(() => copyStarted);
    const editing = api('/accounts/manual-race', 'PATCH', { codingPlanApiKey: 'manual-override' });
    await until(async () => (await readAccounts()).find((a) => a.label === 'manual-race').codingPlanApiKey === 'manual-override');
    releaseCopy(); await Promise.all([refreshing, editing]);
    const saved = (await readAccounts()).find((a) => a.label === 'manual-race');
    assert.equal(saved.codingPlanApiKey, 'manual-override');
    assert.equal(saved.codingPlanCredential, undefined);
  });
  await t.test('reauthorization during discovery saves only the renewed account credential', async () => {
    hold('reauth-race');
    const refreshing = api('/accounts/reauth-race/refresh', 'POST', {});
    await until(() => copyStarted);
    await api('/onboard/start', 'POST', { provider: 'bigmodel' });
    const login = await api('/onboard/poll/renew-flow');
    assert.equal(login.status, 'ready');
    assert.equal((await readAccounts()).find((a) => a.label === 'reauth-race').bigmodelAccessToken, 'renewed-oauth');
    releaseCopy(); await refreshing;
    await until(async () => !(await api('/overview')).accounts.find((a) => a.id === 'reauth-race').eligibilityRefreshing);
    const saved = (await readAccounts()).find((a) => a.label === 'reauth-race');
    assert.deepEqual(saved.codingPlanCredential, { provider: 'bigmodel', owner: 'reauth-race', apiKey: 'renewed-public.renewed-secret' });
    assert.equal(saved.jwt, `${jwt('reauth-race')}-renewed`);
  });
  assert.ok(!logs.includes('saved-secret') && !logs.includes('renewed-secret') && !logs.includes('saved-oauth'));
});
