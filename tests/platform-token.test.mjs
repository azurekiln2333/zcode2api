import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));

const TOKEN = 'zcgw-platform-service-token-0123456789';
const PANEL_KEY = 'test-panel-key';

const freePort = async () => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
};

async function startServer(t, { platformToken = TOKEN } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-platform-token-'));
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    PANEL_KEY,
    GATEWAY_KEY: '',
    ZCGW_DATA_DIR: dataDir,
    ZCODE_HOME: path.join(dataDir, 'empty'),
    // Keep the scheduler offline; no live account is ever contacted.
    ZCODE_UPSTREAM_ORIGIN: 'http://127.0.0.1:1',
    ZCGW_CLAIM_ENABLED: 'false',
  };
  if (platformToken === null) delete env.PLATFORM_TOKEN;
  else env.PLATFORM_TOKEN = platformToken;

  const child = spawn(process.execPath, ['zcgw-server.mjs'], {
    cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { base, logs: () => logs };
    } catch {}
    await delay(30);
  }
  throw new Error(`server did not start: ${logs}`);
}

const get = (base, pathname, headers = {}) => fetch(`${base}${pathname}`, { headers });

test('PLATFORM_TOKEN authorizes management routes without a panel cookie',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t);

    const anonymous = await get(base, '/api/overview');
    assert.equal(anonymous.status, 401, 'no cookie and no token must stay unauthenticated');

    const authorized = await get(base, '/api/overview', { Authorization: `Bearer ${TOKEN}` });
    assert.equal(authorized.status, 200);
    assert.match(authorized.headers.get('content-type') || '', /application\/json/);
  });

test('a wrong or malformed bearer token never authorizes',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t);

    for (const header of ['Bearer wrong-token-value-000', 'Bearer ', TOKEN, `Basic ${TOKEN}`,
                          `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`]) {
      const response = await get(base, '/api/overview', { Authorization: header });
      assert.equal(response.status, 401, `header ${JSON.stringify(header)} must not authorize`);
    }
  });

test('the token branch is inert when PLATFORM_TOKEN is unset',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t, { platformToken: null });

    const response = await get(base, '/api/overview', { Authorization: `Bearer ${TOKEN}` });
    assert.equal(response.status, 401);
  });

test('session probe reports a token-authenticated machine session',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t);

    const session = await get(base, '/api/session', { Authorization: `Bearer ${TOKEN}` });
    assert.equal(session.status, 200);
    const payload = await session.json();
    assert.equal(payload.authenticated, true);
    assert.equal(payload.user.provider, 'token');
    assert.ok(!JSON.stringify(payload).includes(TOKEN), 'the token must never be echoed');
  });

test('panel-key login still works when a token is configured',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t);

    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ key: PANEL_KEY }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie') || '';
    assert.match(cookie, /zcgw_panel=/);

    const session = await get(base, '/api/session', { Cookie: cookie.split(';')[0] });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).authenticated, true);
  });
