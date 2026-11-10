import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));

const ADMIN_KEY = 'zcgw-panel-admin-key-0123456789';
const LEGACY_PANEL_KEY = 'zcgw-legacy-panel-key-987654321';

const freePort = async () => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
};

/**
 * Minimal OIDC provider: discovery, JWKS, token and userinfo. It signs real
 * RS256 ID tokens so the server's verification path runs unmodified.
 */
async function startIdp(t, { email = 'admin@example.com', emailVerified = true, sub = 'subject-1' } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const codes = new Map();
  const nonces = new Map();
  const issuer = () => `http://127.0.0.1:${port}`;
  let port = 0;

  const sign = (claims) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    signer.end();
    return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer());
    const json = (status, body) => {
      const buf = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
      res.end(buf);
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: issuer(),
        authorization_endpoint: `${issuer()}/authorize`,
        token_endpoint: `${issuer()}/token`,
        userinfo_endpoint: `${issuer()}/userinfo`,
        jwks_uri: `${issuer()}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const code = randomUUID();
      codes.set(code, {
        nonce: url.searchParams.get('nonce'),
        redirectUri: url.searchParams.get('redirect_uri'),
        challenge: url.searchParams.get('code_challenge'),
      });
      res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` });
      return res.end();
    }
    if (url.pathname === '/token') {
      const body = await new Promise((resolve) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => resolve(new URLSearchParams(raw)));
      });
      const entry = codes.get(body.get('code'));
      if (!entry) return json(400, { error: 'invalid_grant' });
      // PKCE: the verifier must hash to the challenge the client sent.
      const computed = createHash('sha256').update(body.get('code_verifier') || '').digest('base64url');
      if (computed !== entry.challenge) return json(400, { error: 'invalid_grant', hint: 'pkce' });
      nonces.set('current', entry.nonce);
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: 'access-token',
        token_type: 'Bearer',
        expires_in: 600,
        id_token: sign({
          iss: issuer(), aud: 'test-client', sub, email, email_verified: emailVerified,
          nonce: entry.nonce, iat: now, exp: now + 600, name: 'Admin User',
        }),
      });
    }
    if (url.pathname === '/userinfo') {
      return json(200, { sub, email, email_verified: emailVerified, name: 'Admin User' });
    }
    return json(404, { error: 'not_found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { issuer: issuer() };
}

async function startServer(t, { env: extra = {}, dataDir } = {}) {
  const dir = dataDir || (await mkdtemp(path.join(os.tmpdir(), 'zcgw-auth-')));
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    ZCGW_DATA_DIR: dir,
    ZCODE_HOME: path.join(dir, 'empty'),
    ZCODE_UPSTREAM_ORIGIN: 'http://127.0.0.1:1',
    ZCGW_CLAIM_ENABLED: 'false',
    ZCGW_SSO_ALLOW_LOCAL: '1',
    ...extra,
  };
  for (const key of ['PANEL_KEY', 'PANEL_ADMIN_KEY', 'PLATFORM_TOKEN', 'PANEL_PUBLIC_URL']) {
    if (!(key in extra)) delete env[key];
  }
  const child = spawn(process.execPath, ['zcgw-server.mjs'], {
    cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  let exitPromise = null;
  const waitExit = () => {
    if (!exitPromise) exitPromise = once(child, 'exit');
    return exitPromise;
  };
  child.once('exit', () => { if (!exitPromise) exitPromise = Promise.resolve(); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const pending = waitExit();
    child.kill();
    // Give Windows' TerminateProcess a bounded wait instead of hanging a test.
    await Promise.race([pending, delay(5000)]);
  };
  t.after(async () => {
    await stop();
    if (!dataDir) await rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { base, dataDir: dir, logs: () => logs, stop };
    } catch {}
    await delay(30);
  }
  throw new Error(`server did not start: ${logs}`);
}

const bearer = (key) => ({ Authorization: `Bearer ${key}` });

const patchSettings = (base, patch, headers = bearer(ADMIN_KEY)) =>
  fetch(`${base}/api/auth/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(patch),
  });

// ── D1: one panel key ───────────────────────────────────────────────────────

test('PANEL_ADMIN_KEY authorizes management routes as a bearer', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY } });

  const anonymous = await fetch(`${base}/api/overview`);
  assert.equal(anonymous.status, 401, 'no cookie and no bearer must stay unauthenticated');

  const authorized = await fetch(`${base}/api/overview`, { headers: bearer(ADMIN_KEY) });
  assert.equal(authorized.status, 200);

  const wrong = await fetch(`${base}/api/overview`, { headers: bearer(`${ADMIN_KEY}x`) });
  assert.equal(wrong.status, 401);
});

test('PANEL_KEY stays accepted as an alias for the same key', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t, { env: { PANEL_KEY: LEGACY_PANEL_KEY } });

  assert.equal((await fetch(`${base}/api/overview`, { headers: bearer(LEGACY_PANEL_KEY) })).status, 200);
  const login = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: LEGACY_PANEL_KEY }),
  });
  assert.equal(login.status, 200);
});

test('the panel key never authorizes data-plane routes' , { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY } });

  // /health and /models stay open; /v1 needs an issued gateway key, not the panel key.
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const models = await fetch(`${base}/models`, { headers: bearer(ADMIN_KEY) });
  assert.notEqual(models.status, 401, 'data-plane routes are not panel-auth gated');
});

// ── D2: key login ───────────────────────────────────────────────────────────

test('key login issues a session cookie and the session reports provider key',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY } });

    const wrong = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'definitely-not-the-key' }),
    });
    assert.equal(wrong.status, 401);

    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ADMIN_KEY }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^zcgw_panel=\d+\.key\.-/);
    assert.match(login.headers.get('set-cookie') || '', /HttpOnly/);

    const session = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    const payload = await session.json();
    assert.equal(payload.authenticated, true);
    assert.equal(payload.user.provider, 'key');
    assert.ok(!JSON.stringify(payload).includes(ADMIN_KEY), 'the key must never be echoed');
  });

test('repeated key login failures are throttled', { timeout: 30000 }, async (t) => {
  const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY } });

  const attempt = (key, ip) => fetch(`${base}/api/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
    body: JSON.stringify({ key }),
  });

  for (let i = 0; i < 5; i++) assert.equal((await attempt('wrong-key-value')).status, 401);
  const throttled = await attempt('wrong-key-value');
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('retry-after'), '600');
  // The correct key is refused too while the throttle is active.
  assert.equal((await attempt(ADMIN_KEY)).status, 429);
});

test('a spoofed X-Forwarded-For cannot reset the login throttle',
  { timeout: 30000 }, async (t) => {
    const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY } });

    // Rotating the header mimics an attacker trying to look like a new client.
    const attempt = (ip) => fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ key: 'wrong-key-value' }),
    });

    for (let i = 0; i < 5; i++) {
      assert.equal((await attempt(`203.0.113.${i}`)).status, 401);
    }
    assert.equal((await attempt('198.51.100.7')).status, 429, 'the socket address is the only key');
  });

test('the console auth config is public and reflects saved settings',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY } });

    const config = await (await fetch(`${base}/api/auth/config`)).json();
    assert.equal(config.keyLoginEnabled, true);
    assert.deepEqual(config.sso, { enabled: false, providerName: 'SSO', loginUrl: '' });
  });

// ── D2: SSO settings ────────────────────────────────────────────────────────

test('SSO settings require a session and never return the client secret',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY } });

    assert.equal((await fetch(`${base}/api/auth/settings`)).status, 401);

    const saved = await patchSettings(base, {
      providerName: 'Corp SSO',
      clientId: 'client-id',
      clientSecret: 'super-secret-value',
    });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.providerName, 'Corp SSO');
    assert.equal(body.clientId, 'client-id');
    assert.equal(body.hasClientSecret, true);
    assert.ok(!JSON.stringify(body).includes('super-secret-value'));
    assert.match(body.callbackUrl, /\/api\/auth\/oidc\/callback$/);
  });

test('SSO settings guards cannot lock the operator out', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY } });

  // Enabling SSO needs issuer, client and an allowlist.
  assert.equal((await patchSettings(base, { ssoEnabled: true })).status, 400);
  // Key login cannot be the only method that is turned off.
  const keyOff = await patchSettings(base, { keyLoginEnabled: false });
  assert.equal(keyOff.status, 400);
  assert.match((await keyOff.json()).error, /先启用有效的 SSO/);
  // A bad issuer is refused before anything is stored.
  assert.equal((await patchSettings(base, { issuer: 'javascript:alert(1)' })).status, 400);
  assert.equal((await patchSettings(base, { issuer: 'http://example.com' })).status, 400);
});

test('SSO settings persist in the data directory across a restart',
  { timeout: 30000 }, async (t) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-auth-persist-'));
    const first = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY }, dataDir });

    const saved = await patchSettings(first.base, {
      providerName: 'Persisted SSO',
      clientId: 'client-id',
      clientSecret: 'secret-value',
    });
    assert.equal(saved.status, 200);
    await first.stop();

    const stored = JSON.parse(await readFile(path.join(dataDir, 'auth.json'), 'utf8'));
    assert.equal(stored.sso.providerName, 'Persisted SSO');
    assert.ok(stored.sessionSecret.length >= 32, 'the session secret is persisted, not ephemeral');
    assert.equal(stored.sessionSecret.includes(ADMIN_KEY), false);

    const second = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY }, dataDir });
    const settings = await (await fetch(`${second.base}/api/auth/settings`, {
      headers: bearer(ADMIN_KEY),
    })).json();
    assert.equal(settings.providerName, 'Persisted SSO');
    assert.equal(settings.hasClientSecret, true);

    const restarted = JSON.parse(await readFile(path.join(dataDir, 'auth.json'), 'utf8'));
    assert.equal(restarted.sessionSecret, stored.sessionSecret, 'the secret is reused, not regenerated');
    await rm(dataDir, { recursive: true, force: true });
  });

// ── D2: SSO login round trip ────────────────────────────────────────────────

const enableSso = async (base, issuer, extra = {}) => {
  const response = await patchSettings(base, {
    ssoEnabled: true,
    issuer,
    clientId: 'test-client',
    clientSecret: 'test-secret',
    scope: 'openid profile email',
    allowedEmails: ['admin@example.com'],
    ...extra,
  });
  const text = await response.text();
  assert.equal(response.status, 200, `enabling SSO failed: ${text}`);
  return JSON.parse(text);
};

test('SSO login runs PKCE end to end and yields an oidc session',
  { timeout: 30000 }, async (t) => {
    const idp = await startIdp(t);
    const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY } });
    await enableSso(base, idp.issuer);

    const config = await (await fetch(`${base}/api/auth/config`)).json();
    assert.equal(config.sso.enabled, true);
    assert.equal(config.sso.loginUrl, '/api/auth/oidc/login');

    // Entry redirects to the provider carrying state, nonce and PKCE.
    const entry = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    assert.equal(entry.status, 302);
    const location = new URL(entry.headers.get('location'));
    assert.equal(location.pathname, '/authorize');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(location.searchParams.get('code_challenge'));
    assert.ok(location.searchParams.get('state'));
    assert.ok(location.searchParams.get('nonce'));
    const oidcCookie = (entry.headers.get('set-cookie') || '').split(';')[0];
    assert.match(oidcCookie, /^zcgw_oidc=/);

    // The provider mints the code on its /authorize hop, so drive that hop.
    const authorize = await fetch(`${idp.issuer}/authorize?${new URLSearchParams({
      client_id: 'test-client',
      redirect_uri: `${base}/api/auth/oidc/callback`,
      state: location.searchParams.get('state'),
      nonce: location.searchParams.get('nonce'),
      code_challenge: location.searchParams.get('code_challenge'),
      code_challenge_method: 'S256',
      scope: 'openid profile email',
      response_type: 'code',
    })}`, { redirect: 'manual' });
    assert.equal(authorize.status, 302);
    const providerRedirect = new URL(authorize.headers.get('location'));
    assert.equal(providerRedirect.origin + providerRedirect.pathname, `${base}/api/auth/oidc/callback`);

    const done = await fetch(providerRedirect.toString(), {
      redirect: 'manual',
      headers: { Cookie: oidcCookie },
    });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), '/');
    const sessionCookie = (done.headers.get('set-cookie') || '')
      .split(',')
      .map((entry) => entry.split(';')[0].trim())
      .find((pair) => pair.startsWith('zcgw_panel='));
    assert.ok(sessionCookie, 'the callback must set the panel session cookie');
    assert.match(sessionCookie, /\.oidc\.[\w-]+\./, 'the session records the SSO provider and config fingerprint');

    const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: sessionCookie } })).json();
    assert.equal(session.user.provider, 'oidc');

    // The SSO session works for management routes exactly like a key session.
    assert.equal((await fetch(`${base}/api/overview`, { headers: { Cookie: sessionCookie } })).status, 200);
  });

test('an SSO identity outside the allowlist is rejected', { timeout: 30000 }, async (t) => {
  const idp = await startIdp(t, { email: 'stranger@example.com' });
  const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY } });
  await enableSso(base, idp.issuer);

  const entry = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
  const location = new URL(entry.headers.get('location'));
  const oidcCookie = (entry.headers.get('set-cookie') || '').split(';')[0];

  const authorize = await fetch(`${idp.issuer}/authorize?${new URLSearchParams({
    client_id: 'test-client',
    redirect_uri: `${base}/api/auth/oidc/callback`,
    state: location.searchParams.get('state'),
    nonce: location.searchParams.get('nonce'),
    code_challenge: location.searchParams.get('code_challenge'),
    code_challenge_method: 'S256',
    scope: 'openid profile email',
    response_type: 'code',
  })}`, { redirect: 'manual' });

  const done = await fetch(authorize.headers.get('location'), {
    redirect: 'manual',
    headers: { Cookie: oidcCookie },
  });
  assert.equal(done.status, 302);
  assert.match(done.headers.get('location'), /auth_error=not_allowed/);
  const cookies = done.headers.get('set-cookie') || '';
  assert.ok(!/zcgw_panel=\d/.test(cookies), 'a rejected identity must not receive a session');
});

test('turning key login off needs an SSO session with the same configuration',
  { timeout: 30000 }, async (t) => {
    const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY } });

    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ADMIN_KEY }),
    });
    const keyCookie = (login.headers.get('set-cookie') || '').split(';')[0];

    // A valid SSO configuration is required first.
    const idp = await startIdp(t);
    await enableSso(base, idp.issuer);

    // A key-backed session cannot disable key login.
    const refused = await patchSettings(base, { keyLoginEnabled: false }, { Cookie: keyCookie });
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /先通过 SSO 登录验证/);

    // The bearer is a machine path, so it cannot prove SSO either.
    const byBearer = await patchSettings(base, { keyLoginEnabled: false });
    assert.equal(byBearer.status, 403);
  });

test('the panel key keeps working as a bearer after key login is disabled',
  { timeout: 30000 }, async (t) => {
    const idp = await startIdp(t);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-auth-keyoff-'));
    const { base } = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY }, dataDir });
    await enableSso(base, idp.issuer);
    await t.after(() => rm(dataDir, { recursive: true, force: true }));

    // Simulate the state an SSO session would have produced.
    const stored = JSON.parse(await readFile(path.join(dataDir, 'auth.json'), 'utf8'));
    stored.sso.keyLoginEnabled = false;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dataDir, 'auth.json'), JSON.stringify(stored));
    const restarted = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY }, dataDir });

    const config = await (await fetch(`${restarted.base}/api/auth/config`)).json();
    assert.equal(config.keyLoginEnabled, false);

    // Key login is refused…
    const login = await fetch(`${restarted.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ADMIN_KEY }),
    });
    assert.equal(login.status, 403);

    // …but the service-to-service bearer still manages the box (D2.7).
    assert.equal((await fetch(`${restarted.base}/api/overview`, { headers: bearer(ADMIN_KEY) })).status, 200);
  });

test('PANEL_PUBLIC_URL drives the advertised SSO callback address',
  { timeout: 20000 }, async (t) => {
    const { base } = await startServer(t, {
      env: { PANEL_ADMIN_KEY: ADMIN_KEY, PANEL_PUBLIC_URL: 'https://zcode.example.com' },
    });
    const settings = await (await fetch(`${base}/api/auth/settings`, { headers: bearer(ADMIN_KEY) })).json();
    assert.equal(settings.callbackUrl, 'https://zcode.example.com/api/auth/oidc/callback');
  });

test('an unconfigured panel stays in open mode', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t, { env: {} });

  assert.equal((await fetch(`${base}/api/overview`)).status, 200, 'no key and no SSO means no gate');
  const state = await (await fetch(`${base}/panel/state`)).json();
  assert.equal(state.authRequired, false);
  assert.equal(state.authed, true, 'open mode counts as authenticated');

  // The console decides whether to render the login page from this probe: it
  // must succeed in open mode, otherwise the deployment cannot be entered at all.
  const session = await fetch(`${base}/api/session`);
  assert.equal(session.status, 200);
  const payload = await session.json();
  assert.equal(payload.authenticated, true);

  // SSO can be bootstrapped from the console without setting any env var.
  const settings = await fetch(`${base}/api/auth/settings`);
  assert.equal(settings.status, 200);
  assert.equal((await settings.json()).ssoEnabled, false);

  const login = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'anything' }),
  });
  assert.equal(login.status, 400, 'key login is meaningless without a key');
});

test('rotating the panel key invalidates key sessions but not SSO sessions',
  { timeout: 30000 }, async (t) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-auth-rotate-'));
    const first = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY }, dataDir });

    const login = await fetch(`${first.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ADMIN_KEY }),
    });
    assert.equal(login.status, 200);
    const keyCookie = (login.headers.get('set-cookie') || '').split(';')[0];
    assert.equal(
      (await fetch(`${first.base}/api/session`, { headers: { Cookie: keyCookie } })).status,
      200,
    );
    await first.stop();

    // A new key on the same data directory must not honour the old cookie.
    const rotated = 'zcgw-rotated-panel-key-abcdef123456';
    const second = await startServer(t, { env: { PANEL_ADMIN_KEY: rotated }, dataDir });
    const stale = await fetch(`${second.base}/api/session`, { headers: { Cookie: keyCookie } });
    assert.equal(stale.status, 401, 'the old key session must die with the old key');
    assert.equal((await fetch(`${second.base}/api/overview`, { headers: { Cookie: keyCookie } })).status, 401);

    // A session created with the new key works.
    const fresh = await fetch(`${second.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: rotated }),
    });
    assert.equal(fresh.status, 200);
    await rm(dataDir, { recursive: true, force: true });
  });

/** Drive a full SSO round trip and return the resulting panel session cookie. */
async function ssoSession(base, idp) {
  const entry = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
  const location = new URL(entry.headers.get('location'));
  const oidcCookie = (entry.headers.get('set-cookie') || '').split(';')[0];
  const authorize = await fetch(`${idp.issuer}/authorize?${new URLSearchParams({
    client_id: 'test-client',
    redirect_uri: `${base}/api/auth/oidc/callback`,
    state: location.searchParams.get('state'),
    nonce: location.searchParams.get('nonce'),
    code_challenge: location.searchParams.get('code_challenge'),
    code_challenge_method: 'S256',
    scope: 'openid profile email',
    response_type: 'code',
  })}`, { redirect: 'manual' });
  const done = await fetch(authorize.headers.get('location'), {
    redirect: 'manual',
    headers: { Cookie: oidcCookie },
  });
  assert.equal(done.status, 302);
  const cookie = (done.headers.get('set-cookie') || '')
    .split(',')
    .map((part) => part.split(';')[0].trim())
    .find((pair) => pair.startsWith('zcgw_panel='));
  assert.ok(cookie, 'the SSO callback must set a session cookie');
  return cookie;
}

test('an SSO session survives a panel key rotation', { timeout: 30000 }, async (t) => {
  const idp = await startIdp(t);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-auth-rotate-sso-'));
  const first = await startServer(t, { env: { PANEL_ADMIN_KEY: ADMIN_KEY }, dataDir });
  await enableSso(first.base, idp.issuer);
  const ssoCookie = await ssoSession(first.base, idp);
  assert.equal((await fetch(`${first.base}/api/session`, { headers: { Cookie: ssoCookie } })).status, 200);
  await first.stop();

  // SSO sessions are bound to the SSO configuration, not to the panel key.
  const second = await startServer(t, {
    env: { PANEL_ADMIN_KEY: 'zcgw-rotated-panel-key-abcdef123456' },
    dataDir,
  });
  const session = await fetch(`${second.base}/api/session`, { headers: { Cookie: ssoCookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.provider, 'oidc');
  await rm(dataDir, { recursive: true, force: true });
});
