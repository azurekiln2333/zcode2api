import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ user_id: 'probe-user' })).toString('base64url')}.private-token`;

test('console probes respond immediately and report genuine upstream outcomes without retrying inference', { timeout: 15000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-selftest-'));
  await writeFile(path.join(dataDir, 'accounts.json'), JSON.stringify([
    { label: 'probe', jwt }, { label: 'disabled', jwt, disabled: true },
  ]));
  let calls = 0, mode = 'hold', held;
  const upstream = http.createServer(async (req, res) => {
    if (!req.url.endsWith('/anthropic/v1/messages')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ code: 0, data: { plans: [], balances: [] } }));
    }
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${jwt}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks)).stream, false);
    res.setHeader('content-type', 'application/json');
    if (mode === 'hold') { held = res; return; }
    if (mode === 'timeout') return;
    if (mode === 'disconnect') { res.destroy(); return; }
    if (mode === 'html502') {
      res.writeHead(502, { 'content-type': 'text/html', 'cf-ray': 'a5678101b9b51c0a-AMS' });
      return res.end('<html>secret-upstream-detail</html>');
    }
    if (mode === 'http401') { res.statusCode = 401; return res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'secret-upstream-detail', biz_code: 3012 } })); }
    if (mode === 'business') return res.end(JSON.stringify({ code: 3012, msg: 'secret-upstream-detail' }));
    if (mode === 'malformed') return res.end('not JSON: secret-upstream-detail');
    if (mode === 'empty') return res.end(JSON.stringify({ content: [] }));
    if (mode === 'null') return res.end('null');
    return res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: '正常' }] }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const listener = http.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ['zcgw-server.mjs'], { cwd: root, windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PANEL_KEY: 'test-panel', GATEWAY_KEY: '',
      ZCGW_DATA_DIR: dataDir, ZCODE_HOME: path.join(dataDir, 'empty'),
      ZCODE_UPSTREAM_ORIGIN: `http://127.0.0.1:${upstream.address().port}`, ZCGW_SELFTEST_TIMEOUT_MS: '800', ZCODE_HTTP_TRANSPORT: 'fetch' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
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
    await delay(30);
  }
  assert.ok(ready, logs);
  const endpoint = '/api/accounts/probe/selftest';
  assert.equal((await fetch(base + endpoint, { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + endpoint + '/missing')).status, 401);
  assert.equal(calls, 0);
  const login = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'test-panel' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (route, method = 'GET') => {
    const response = await fetch(base + route, { method, headers: { cookie } });
    assert.match(response.headers.get('content-type'), /application\/json/);
    return { status: response.status, body: await response.json() };
  };
  const result = async (job) => {
    for (let i = 0; i < 200; i++) {
      const response = await api(`${endpoint}/${job.jobId}`);
      assert.equal(response.status, 200);
      if (response.body.status === 'completed') return response.body.result;
      await delay(10);
    }
    assert.fail('probe did not complete');
  };
  const started = await api(endpoint, 'POST');
  assert.equal(started.status, 202);
  assert.equal(started.body.status, 'running');
  assert.ok(!JSON.stringify(started.body).includes(jwt));
  for (let i = 0; i < 100 && !held; i++) await delay(5);
  assert.ok(held, 'the initial response must arrive while inference is still waiting');
  const duplicate = await api(endpoint, 'POST');
  assert.equal(duplicate.body.jobId, started.body.jobId);
  assert.equal(calls, 1, 'simultaneous clicks share one inference request');
  held.end(JSON.stringify({ content: [{ type: 'text', text: '正常' }] }));
  assert.equal((await result(started.body)).ok, true);
  const cases = [
    ['html502', 'upstream_http', 502], ['http401', 'upstream_http', 401], ['business', 'upstream_rejected', 200],
    ['malformed', 'invalid_response', 200], ['null', 'invalid_response', 200], ['empty', 'empty_reply', 200],
    ['disconnect', 'connection_failed', null], ['timeout', 'timeout', null],
  ];
  for (const [scenario, code, status] of cases) {
    mode = scenario;
    const before = calls;
    const probe = await api(endpoint, 'POST');
    const outcome = await result(probe.body);
    assert.equal(outcome.ok, false, scenario);
    assert.equal(outcome.code, code, scenario);
    assert.equal(outcome.upstreamStatus, status, scenario);
    assert.equal(calls, before + 1, 'a failed probe must never automatically retry inference');
    assert.ok(!JSON.stringify(outcome).includes('secret-upstream-detail'));
    if (scenario === 'html502') assert.equal(outcome.rayId, 'a5678101b9b51c0a-AMS');
    const account = (await api('/api/overview')).body.accounts.find((a) => a.id === 'probe');
    assert.equal(account.lastError, outcome.error);
  }
  assert.ok(!logs.includes('Invalid time value'), 'repeated failures must not throw while calculating breaker cooldown');
  assert.equal((await api('/api/accounts/disabled/selftest', 'POST')).status, 409);
  assert.equal((await api('/api/accounts/missing/selftest', 'POST')).status, 404);
  assert.equal((await api(endpoint + '/missing')).status, 410);
  mode = 'success';
  assert.equal((await result((await api(endpoint, 'POST')).body)).ok, true);
  const recovered = (await api('/api/overview')).body.accounts.find((a) => a.id === 'probe');
  assert.equal(recovered.lastError, '');
  assert.equal(recovered.status, 'healthy');
  assert.equal((await api('/selftest', 'POST')).body.ok, true, 'legacy endpoint retains direct results');
});
