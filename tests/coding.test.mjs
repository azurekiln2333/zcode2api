import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodingClient, extractOAuthToken, codingProviderOf, pickOrgProject, codingCredentialOwner, savedCodingKey } from '../zcgw-coding.mjs';

const customer = { organizations: [
  { organizationId: 'other', organizationName: '其他', projects: [{ projectId: 'other', projectType: 1 }] },
  { organizationId: 'personal', organizationName: '默认机构', projects: [
    { projectId: 'team', projectName: '默认项目', projectType: '2' },
    { projectId: 'custom', projectName: '自定义', projectType: 1 },
    { projectId: 'default', projectName: '默认项目', projectType: 1 },
  ] },
] };
const keyPath = '/api/biz/v1/organization/personal/projects/default/api_keys';
const quota = { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
  { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 6, nextResetTime: 1794355200000 }] };
const subscriptions = [{ productId: 'glm-coding-trial', productName: 'GLM Coding Plan 优享体验卡',
  status: 'VALID', inCurrentPeriod: true, expireTime: '2026-11-11T15:59:59Z' }];
const mcp = { server_time: 1794000000, next_refresh_at: 1794144000, total_usage: { limit: 500, used: 0, remaining: 500 } };
const campaign = { configs: { codingPlanBillingDiscount: { 'zh-CN': { badgeBody: '150% 配额', infoTitle: '活动', infoBody: '官方活动说明' } } } };
const ok = (data, code = 200) => ({ code, data });

function harness(route, options = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const request = { host: parsed.host, path: parsed.pathname, query: parsed.searchParams,
      headers: new Headers(options.headers), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null };
    requests.push(request);
    const reply = await route(request);
    return new Response(JSON.stringify(reply?.payload ?? reply), { status: reply?.httpStatus || 200,
      headers: { 'content-type': 'application/json' } });
  };
  const zcodeRequestImpl = async (url, options) => {
    const response = await fetchImpl(url, options);
    return { ok: response.ok, status: response.status, body: await response.text() };
  };
  const client = createCodingClient({ fetchImpl, zcodeRequestImpl, zaiOrigin: 'https://zai.test',
    bigmodelOrigin: 'https://monitor.test', bigmodelBizOrigin: 'https://biz.test', zcodeOrigin: 'https://zcode.test',
    wait: async () => {}, ...options });
  return { client, requests };
}

test('OAuth extraction and organization selection follow provider and personal project contracts', () => {
  assert.equal(extractOAuthToken({ zai: { access_token: 'zai' }, bigmodel: { accessToken: 'cn' } }, 'bigmodel'), 'cn');
  assert.equal(extractOAuthToken({ accessToken: 'root' }, 'bigmodel'), 'root');
  assert.equal(extractOAuthToken({ accessToken: 'root', bigmodel: { access_token: 'cn' } }, 'zai'), null);
  assert.equal(codingProviderOf({ realm: 'cn', zaiAccessToken: 'zai' }), 'zai', 'email/phone must not pick a credential platform');
  assert.equal(codingProviderOf({ realm: 'intl', oauthProvider: 'bigmodel' }), 'bigmodel');
  assert.deepEqual(pickOrgProject(customer), ['personal', 'default']);
  assert.equal(pickOrgProject({ organizations: [{ organizationId: 1, projects: [{ projectId: 2, projectType: 2 }] }] }), null);
});

for (const provider of ['zai', 'bigmodel']) {
  test(`${provider}: OAuth, key resolution, subscription, rolling quota and MCP use their own endpoint credentials`, async () => {
    const accessToken = provider === 'zai' ? 'zai-business' : 'bigmodel-oauth';
    const bizHost = provider === 'zai' ? 'zai.test' : 'biz.test';
    const monitorHost = provider === 'zai' ? 'zai.test' : 'monitor.test';
    const { client, requests } = harness((req) => {
      if (req.path === '/api/auth/z/login') {
        assert.equal(provider, 'zai'); assert.deepEqual(req.body, { token: 'zai-raw' });
        return ok({ access_token: accessToken });
      }
      if (req.path === '/api/biz/customer/getCustomerInfo' || req.path.startsWith(keyPath)) {
        assert.equal(req.host, bizHost);
        assert.equal(req.headers.get('content-type'), 'application/json');
        assert.equal(req.headers.get('authorization'), provider === 'zai' ? `Bearer ${accessToken}` : accessToken);
        if (req.path.endsWith('getCustomerInfo')) return ok(customer);
        if (req.path.endsWith('/copy/public-key')) return { secretKey: 'private-key' };
        return provider === 'zai' ? [{ name: 'zcode-api-key', apiKey: 'public-key' }] : ok([{ name: 'zcode-api-key', apiKey: 'public-key' }]);
      }
      if (req.path === '/api/monitor/usage/quota/limit') {
        assert.equal(req.host, monitorHost); assert.equal(req.headers.get('authorization'), 'Bearer public-key.private-key');
        assert.equal(req.headers.get('user-agent'), 'ZCode/3.18.0');
        return ok(quota);
      }
      if (req.path === '/api/biz/subscription/list') {
        assert.equal(req.host, monitorHost); assert.equal(req.headers.get('authorization'), 'Bearer public-key.private-key');
        return ok(subscriptions);
      }
      if (req.path === '/api/v1/mcp/usage') {
        assert.equal(req.host, 'zcode.test'); assert.equal(req.headers.get('authorization'), 'Bearer zcode-jwt');
        assert.equal(req.headers.get('x-bigmodel-authorization'), `Bearer ${accessToken}`);
        assert.equal(req.headers.get('bigmodel-target-type'), 'PERSONAL');
        return ok(mcp, 0);
      }
      if (req.path === '/api/v1/client/configs') {
        assert.equal(req.headers.has('authorization'), false);
        assert.equal(req.query.get('app_version'), '3.18.0');
        return ok(campaign, 0);
      }
      throw new Error('unexpected route');
    });
    const account = { jwt: 'zcode-jwt', oauthProvider: provider, codingPlanProvider: provider,
      ...(provider === 'zai' ? { zaiAccessToken: 'zai-raw' } : { bigmodelAccessToken: 'bigmodel-oauth' }) };
    const result = await client.query(account, { version: '3.18.0' });
    assert.equal(result.error, null); assert.equal(result.status, 'ready');
    assert.equal(result.plans[0].name, 'GLM Coding Plan 优享体验卡');
    assert.deepEqual(result.plans[0].items.map((item) => item.remainingPercent), [100, 94, 100]);
    assert.equal(result.plans[0].campaign.label, '150% 配额');
    assert.equal(result.plans[0].endsAt, '2026-11-11T15:59:59.000Z');
    assert.ok(!JSON.stringify(result).includes(accessToken));
    assert.equal(requests.filter((r) => r.path.endsWith('/subscription/list')).length, 1);
    await client.query(account, { version: '3.18.0' });
    assert.equal(requests.filter((r) => r.path.endsWith('getCustomerInfo')).length, 1);
    assert.equal(requests.filter((r) => r.path === keyPath).length, 1);
    assert.equal(requests.filter((r) => r.path === '/api/v1/client/configs').length, 1);
    assert.equal(requests.filter((r) => r.method === 'POST' && r.path === keyPath).length, 0);
  });
}

test('missing named key is provisioned once; failed listing never triggers creation', async () => {
  let listFails = false;
  const { client, requests } = harness((req) => {
    if (req.path.endsWith('getCustomerInfo')) return ok(customer);
    if (req.path === keyPath) return listFails ? ok(null, 401)
      : req.method === 'POST' ? { apiKey: 'created' } : [];
    if (req.path.endsWith('/copy/created')) return { secretKey: 'secret' };
    if (req.path.endsWith('/quota/limit')) return ok(quota);
    if (req.path.endsWith('/subscription/list')) return ok(subscriptions);
    if (req.path.endsWith('/mcp/usage')) return ok(mcp, 0);
    return ok(campaign, 0);
  });
  const account = { jwt: 'zcode-jwt', oauthProvider: 'bigmodel', bigmodelAccessToken: 'raw' };
  const [a, b] = await Promise.all([client.query(account), client.query(account)]);
  assert.equal(a.error, null); assert.equal(b.error, null);
  assert.equal(requests.filter((r) => r.path === keyPath && r.method === 'POST').length, 1);
  assert.deepEqual(requests.find((r) => r.path === keyPath && r.method === 'POST').body, { name: 'zcode-api-key' });
  listFails = true;
  await client.query({ ...account, bigmodelAccessToken: 'renewed' });
  assert.equal(requests.filter((r) => r.path === keyPath && r.method === 'POST').length, 1);
});

test('explicit key does not mix OAuth subscription or MCP; selecting another platform never leaks OAuth', async () => {
  const { client, requests } = harness((req) => {
    if (req.path.endsWith('getCustomerInfo')) return ok(customer);
    if (req.path === keyPath) return [];
    if (req.path.endsWith('/quota/limit')) {
      assert.equal(req.headers.get('authorization'), 'Bearer manual'); return ok(quota);
    }
    if (req.path.endsWith('/subscription/list')) {
      assert.equal(req.headers.get('authorization'), 'Bearer manual'); return ok([{ ...subscriptions[0], productName: '手填 Key 的套餐' }]);
    }
    return ok(campaign, 0);
  });
  const acc = { jwt: 'zcode', oauthProvider: 'bigmodel', bigmodelAccessToken: 'oauth', codingPlanApiKey: 'manual' };
  const result = await client.query(acc);
  assert.equal(result.error, null); assert.equal(result.plans[0].items.length, 2);
  assert.equal(result.plans[0].name, '手填 Key 的套餐');
  assert.equal(requests.filter((r) => r.path.endsWith('/mcp/usage') || r.method === 'POST').length, 0);
  const start = requests.length;
  await client.query({ ...acc, codingPlanProvider: 'zai' });
  const next = requests.slice(start);
  assert.ok(next.every((r) => r.host === 'zai.test'));
  assert.ok(next.every((r) => !JSON.stringify(r.body).includes('oauth') && !(r.headers.get('authorization') || '').includes('oauth')));
});

test('JWT and same-provider OAuth fallback handle business 401 without hiding non-auth failures', async () => {
  const { client, requests } = harness((req) => {
    if (req.path.endsWith('getCustomerInfo')) return ok({});
    if (req.path.endsWith('/quota/limit')) return req.headers.get('authorization') === 'Bearer oauth' ? ok(quota) : ok(null, 401);
    if (req.path.endsWith('/subscription/list')) return ok(subscriptions);
    if (req.path.endsWith('/mcp/usage')) return ok(null, 0);
    return ok({}, 0);
  });
  const result = await client.query({ jwt: 'zcode', oauthProvider: 'bigmodel', bigmodelAccessToken: 'oauth' });
  assert.equal(result.error, null);
  assert.deepEqual(requests.filter((r) => r.path.endsWith('/quota/limit')).map((r) => r.headers.get('authorization')),
    ['Bearer zcode', 'Bearer oauth']);
});

test('partial failures keep only failed resources cached, successful empty responses clear them', async () => {
  let failure = 'none';
  const { client } = harness((req) => {
    if (req.path.endsWith('getCustomerInfo')) return ok({});
    if (req.path.endsWith('/quota/limit')) return failure === 'quota' ? { payload: { code: 500, msg: 'secret-data' }, httpStatus: 503 }
      : ok(failure === 'empty' ? { limits: [] } : { limits: [{ ...quota.limits[0], percentage: 20 }] });
    if (req.path.endsWith('/subscription/list')) return failure === 'subscription' ? ok(null, 500) : ok(failure === 'empty' ? [] : subscriptions);
    if (req.path.endsWith('/mcp/usage')) return failure === 'mcp' ? ok(null, 500) : ok(failure === 'empty' ? null : mcp, 0);
    return ok({}, 0);
  });
  const acc = { jwt: 'zcode', oauthProvider: 'bigmodel', bigmodelAccessToken: 'oauth' };
  let previous = await client.query(acc);
  const oldTime = previous.syncedAt;
  for (failure of ['mcp', 'quota', 'subscription']) {
    const next = await client.query(acc, { previous });
    assert.equal(next.status, 'error'); assert.equal(next.plans[0].items.length, 2);
    assert.equal(next.plans[0].name, subscriptions[0].productName);
    assert.equal(next.syncedAt, oldTime);
    assert.ok(!JSON.stringify(next).includes('secret-data'));
    previous = next;
  }
  failure = 'empty';
  assert.deepEqual((await client.query(acc, { previous })).plans, []);
});

test('a discovered key survives a new client and expired OAuth without leaking into quota responses', async () => {
  const account = { jwt: 'account-jwt', oauthProvider: 'bigmodel', bigmodelAccessToken: 'live-oauth' };
  let expired = false, saved;
  const route = (req) => {
    if (req.path.endsWith('getCustomerInfo')) return expired ? ok(null, 401) : ok(customer);
    if (req.path === keyPath) return [{ name: 'zcode-api-key', apiKey: 'persisted-public' }];
    if (req.path.endsWith('/copy/persisted-public')) return { secretKey: 'persisted-secret' };
    if (req.path.endsWith('/quota/limit')) return req.headers.get('authorization') === 'Bearer persisted-public.persisted-secret' ? ok(quota) : ok(null, 401);
    if (req.path.endsWith('/subscription/list')) return ok(subscriptions);
    if (req.path.endsWith('/mcp/usage')) return expired ? ok(null, 401) : ok(mcp, 0);
    return ok({}, 0);
  };
  const first = harness(route, { persistCredential: (snapshot, credential) => {
    assert.equal(snapshot.jwt, account.jwt); saved = structuredClone(credential); return true;
  } });
  const before = await first.client.query(account);
  assert.equal(before.status, 'ready');
  assert.equal(saved.apiKey, 'persisted-public.persisted-secret');
  const restarted = { ...account, codingPlanCredential: saved };
  expired = true;
  const second = harness(route);
  const after = await second.client.query(restarted);
  assert.deepEqual(after.plans[0].items.map((item) => item.remainingPercent), [100, 94]);
  assert.equal(after.status, 'error', 'MCP still needs valid OAuth, even when monitor works');
  assert.ok(after.diagnostics.credentials.savedKey);
  assert.ok(!second.requests.some((req) => req.path.includes('/api_keys')));
  for (const secret of [account.jwt, account.bigmodelAccessToken, saved.apiKey, 'persisted-secret']) {
    assert.ok(!JSON.stringify([before, after]).includes(secret));
  }
  assert.equal(savedCodingKey({ ...restarted, jwt: 'other-account' }), '');
  assert.equal(savedCodingKey({ ...restarted, codingPlanProvider: 'zai' }), '');
});

for (const failure of [ok(null, 500), ok({ unexpected: true })]) {
  test(`a candidate's ${failure.code === 500 ? 'business error' : 'invalid shape'} cannot suppress valid OAuth quotas`, async () => {
    const { client, requests } = harness((req) => {
      if (req.path.endsWith('getCustomerInfo')) return ok({});
      if (req.path.endsWith('/quota/limit')) return req.headers.get('authorization') === 'Bearer last-candidate' ? ok(quota) : failure;
      if (req.path.endsWith('/subscription/list')) return ok(subscriptions);
      if (req.path.endsWith('/mcp/usage')) return ok(null, 0);
      return ok({}, 0);
    });
    const result = await client.query({ jwt: 'first-candidate', oauthProvider: 'bigmodel', bigmodelAccessToken: 'last-candidate' });
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.plans[0].items.map((item) => item.remainingPercent), [100, 94]);
    assert.deepEqual(requests.filter((req) => req.path.endsWith('/quota/limit')).map((req) => req.headers.get('authorization')),
      ['Bearer first-candidate', 'Bearer last-candidate']);
    assert.equal(result.diagnostics.steps.filter((step) => step.resource === '周期额度' && step.status === 'error').length, 1);
  });
}

test('revoked saved key is rediscovered before JWT fallback, and manual override never uses saved credentials', async () => {
  const account = { jwt: 'jwt', oauthProvider: 'bigmodel', bigmodelAccessToken: 'oauth' };
  account.codingPlanCredential = { provider: 'bigmodel', owner: codingCredentialOwner(account), apiKey: 'revoked-key' };
  let stored;
  const { client, requests } = harness((req) => {
    if (req.path.endsWith('getCustomerInfo')) return ok(customer);
    if (req.path === keyPath) return [{ name: 'zcode-api-key', apiKey: 'new-public' }];
    if (req.path.endsWith('/copy/new-public')) return { secretKey: 'new-secret' };
    if (req.path.endsWith('/quota/limit')) return ['Bearer new-public.new-secret', 'Bearer manual'].includes(req.headers.get('authorization')) ? ok(quota) : ok(null, 401);
    if (req.path.endsWith('/subscription/list')) return ok(subscriptions);
    if (req.path.endsWith('/mcp/usage')) return ok(null, 0);
    return ok({}, 0);
  }, { persistCredential: (_, value) => { stored = value; return true; } });
  assert.equal((await client.query(account)).status, 'ready');
  assert.equal(stored.apiKey, 'new-public.new-secret');
  assert.deepEqual(requests.filter((req) => req.path.endsWith('/quota/limit')).map((req) => req.headers.get('authorization')),
    ['Bearer revoked-key', 'Bearer new-public.new-secret']);
  const start = requests.length;
  await client.query({ ...account, codingPlanApiKey: 'manual' });
  assert.ok(requests.slice(start).every((req) => !req.path.endsWith('/mcp/usage') && req.headers.get('authorization') === 'Bearer manual'));
});

test('all-auth failure retries first candidate once and diagnostics preserve only safe codes and labels', async () => {
  const waits = [];
  const { client, requests } = harness((req) => req.path.endsWith('/client/configs') ? ok({}, 0)
    : { payload: { code: 401, msg: 'sensitive-token-and-customer-info' }, httpStatus: 200 },
  { wait: async (ms) => { waits.push(ms); } });
  const result = await client.query({ jwt: 'private-jwt', oauthProvider: 'bigmodel', bigmodelAccessToken: 'private-oauth' });
  assert.equal(result.status, 'error');
  assert.deepEqual(waits, [1500]);
  assert.equal(requests.filter((req) => req.path.endsWith('/quota/limit')).length, 3);
  assert.ok(result.diagnostics.steps.some((step) => step.resource === '客户资料' && step.code === 401));
  for (const secret of ['private-jwt', 'private-oauth', 'sensitive-token-and-customer-info']) assert.ok(!JSON.stringify(result).includes(secret));
});
