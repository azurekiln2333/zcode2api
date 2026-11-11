import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));

const MASTER_KEY = 'zcgw-master-key-0123456789abcdef';

const freePort = async () => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
};

async function startServer(t, { gatewayKey = '' } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-default-deny-'));
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    GATEWAY_KEY: gatewayKey,
    ZCGW_DATA_DIR: dataDir,
    ZCODE_HOME: path.join(dataDir, 'empty'),
    // Keep the scheduler offline; no live account is ever contacted.
    ZCODE_UPSTREAM_ORIGIN: 'http://127.0.0.1:1',
    ZCGW_CLAIM_ENABLED: 'false',
  };
  // No panel key: management routes stay reachable so the test can create keys.
  delete env.PANEL_ADMIN_KEY;
  delete env.PANEL_KEY;
  delete env.PLATFORM_TOKEN;

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
      if ((await fetch(`${base}/health`)).ok) return { base, dataDir, logs: () => logs };
    } catch {}
    await delay(30);
  }
  throw new Error(`server did not start: ${logs}`);
}

const chat = (base, { key, headers = {} } = {}) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...headers,
  },
  body: JSON.stringify({ model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'hi' }] }),
});

const anthropic = (base, { key } = {}) => fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(key ? { 'x-api-key': key } : {}),
  },
  body: JSON.stringify({ model: 'GLM-5.3-Flash', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
});

const createKey = async (base, name, extra = {}) => {
  const response = await fetch(`${base}/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, ...extra }),
  });
  assert.equal(response.status, 200);
  return response.json();
};

test('an unconfigured gateway refuses inference calls with 401', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t);

  // The test itself connects from 127.0.0.1, so this also proves that there is
  // no loopback escape hatch left: the old build answered 200 here.
  for (const response of [
    await chat(base),
    await anthropic(base),
    await chat(base, { key: 'not-a-real-key' }),
    await chat(base, { key: 'zck_whatever' }),
  ]) {
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.message, '尚未配置 API 密钥');
    assert.equal(body.error.type, 'authentication_error');
  }
});

test('a spoofed forwarded address cannot restore the old bypass',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t);

    for (const header of ['127.0.0.1', '::1', 'localhost', '127.0.0.1, 10.0.0.1']) {
      const response = await chat(base, { headers: { 'x-forwarded-for': header, 'x-real-ip': header } });
      assert.equal(response.status, 401, `x-forwarded-for ${header} must not authorize`);
    }
  });

test('a disabled key alone does not count as configured', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t);
  const created = await createKey(base, 'paused');

  assert.equal((await chat(base, { key: created.secret })).status, 503,
    'an enabled key makes the gateway usable, so auth passes and the account pool is the next failure');

  const patched = await fetch(`${base}/keys/${created.key.id}/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(patched.status, 200);

  const denied = await chat(base, { key: created.secret });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.message, '尚未配置 API 密钥');
});

test('a master key restores access without reviving an open mode',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t, { gatewayKey: MASTER_KEY });

    const anon = await chat(base);
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error.message, '缺少 API Key');

    const wrong = await chat(base, { key: 'zck_wrong_key_value' });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error.message, 'API Key 无效');

    // Auth passes with the master key, so the request reaches the pool step.
    const accepted = await chat(base, { key: MASTER_KEY });
    assert.equal(accepted.status, 503);

    // The Anthropic entry point enforces the same rule, in both header styles.
    const anthropicAnon = await anthropic(base);
    assert.equal(anthropicAnon.status, 401);
    assert.equal((await anthropicAnon.json()).error.message, '缺少 API Key');
    const anthropicAccepted = await anthropic(base, { key: MASTER_KEY });
    assert.equal(anthropicAccepted.status, 503, 'x-api-key with the master key must authenticate');
  });

test('a created key is the only credential that authorizes', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t);
  const created = await createKey(base, 'prod-01');

  assert.equal((await chat(base, { key: created.secret })).status, 503);
  assert.equal((await chat(base)).status, 401);
  assert.equal((await chat(base, { key: 'zck_wrong_key_value' })).status, 401);
  // A soft-deleted key stops working and no longer counts as configured.
  await fetch(`${base}/keys/${created.key.id}/delete`, { method: 'POST' });
  const afterDelete = await chat(base, { key: created.secret });
  assert.equal(afterDelete.status, 401);
  assert.equal((await afterDelete.json()).error.message, '尚未配置 API 密钥');
});

test('the key listing reports configuration instead of an open mode',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t);

    const empty = await (await fetch(`${base}/keys`)).json();
    assert.equal(empty.gatewayConfigured, false);
    assert.equal(empty.masterKeyEnabled, false);
    assert.ok(!('openMode' in empty), 'the removed flag must not come back');

    await createKey(base, 'k1');
    const filled = await (await fetch(`${base}/keys`)).json();
    assert.equal(filled.gatewayConfigured, true);
  });

test('no shipped file claims the gateway can run without a key',
  { timeout: 20000 }, async () => {
    for (const file of ['zcgw-server.mjs', 'dashboard.html', 'README.md',
                        'web/src/views/AccessView.vue']) {
      const text = await readFile(path.join(root, file), 'utf8');
      assert.ok(!text.includes('开放模式'), `${file} must not mention the removed open mode`);
      assert.ok(!/openMode/.test(text), `${file} must not carry the removed flag`);
    }
  });
