// OAuth/key discovery follows zcode-switch's oauth.rs (MIT; see THIRD_PARTY_NOTICES.md).
// Monitor, subscription and ZCode MCP are separate upstream resources.
import { createHash, randomUUID } from 'node:crypto';
import { normalizeCoding, codingPlanMetadata } from './zcgw-quota.mjs';
import { zcodeRequest, responseJson } from './zcgw-upstream.mjs';

const text = (value) => typeof value === 'string' ? value.trim() : '';
export const oauthProviderOf = (acc) => acc.oauthProvider || (acc.bigmodelAccessToken ? 'bigmodel' : acc.zaiAccessToken ? 'zai' : null);
export const codingProviderOf = (acc) => acc.codingPlanProvider || oauthProviderOf(acc) || (acc.realm === 'cn' ? 'bigmodel' : 'zai');
export const oauthTokenOf = (acc, provider) => text(provider === 'bigmodel' ? acc.bigmodelAccessToken : acc.zaiAccessToken);
export const codingIdentity = (acc) => createHash('sha256').update(JSON.stringify([
  acc.jwt, codingProviderOf(acc), oauthProviderOf(acc), acc.zaiAccessToken, acc.bigmodelAccessToken, acc.codingPlanApiKey,
])).digest('hex');

export function extractOAuthToken(data, provider) {
  const nested = data?.[provider];
  return text(nested?.access_token) || text(nested?.accessToken) ||
    (provider === 'bigmodel' ? text(data?.access_token) || text(data?.accessToken) : '') || null;
}

export function pickOrgProject(customer) {
  const id = (value) => typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  const orgs = (Array.isArray(customer?.organizations) ? customer.organizations : [])
    .filter((o) => o && id(o.organizationId)).map((o) => ({ ...o,
      projects: (Array.isArray(o.projects) ? o.projects : []).filter((p) => p && String(p.projectType).trim() !== '2' && id(p.projectId)),
    })).filter((o) => o.projects.length);
  const org = orgs.find((o) => text(o.organizationName).includes('默认机构')) || orgs[0];
  if (!org) return null;
  const project = org.projects.find((p) => text(p.projectName).includes('默认项目')) || org.projects[0];
  return [id(org.organizationId), id(project.projectId)];
}

export function createCodingClient({ zaiOrigin = 'https://api.z.ai', bigmodelOrigin = 'https://open.bigmodel.cn',
  bigmodelBizOrigin = 'https://bigmodel.cn', zcodeOrigin = 'https://zcode.z.ai', fetchImpl = fetch,
  zcodeRequestImpl = zcodeRequest, now = Date.now } = {}) {
  const identities = new Map();
  let campaignCache, campaignPending;

  async function json(url, { headers = {}, method = 'GET', body, zcode = false } = {}) {
    let response, payload;
    try {
      const options = { method, headers: { accept: 'application/json', ...headers,
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) };
      response = zcode ? await zcodeRequestImpl(url, { ...options, timeoutMs: 12000 })
        : await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) });
      payload = zcode ? responseJson(response) : await response.json();
    } catch { throw new Error('查询连接失败或响应不是有效 JSON'); }
    if (!response.ok || !payload || typeof payload !== 'object' || payload.success === false ||
        (payload.code !== undefined && ![0, 200, '0', '200'].includes(payload.code))) {
      const code = payload?.code;
      const knownCode = code != null && String(code).trim() && Number.isFinite(Number(code)) ? Number(code) : '未知';
      const error = new Error(`查询失败（HTTP ${response.status}，业务码 ${knownCode}）`);
      error.auth = [401, 403].includes(response.status) || [401, 403, 1006].includes(Number(code));
      throw error;
    }
    return payload;
  }
  const dataOf = (body) => body.data !== undefined ? body.data : body;
  const bizOrigin = (provider) => provider === 'bigmodel' ? bigmodelBizOrigin : zaiOrigin;
  const bizHeaders = (provider, token) => ({ authorization: provider === 'bigmodel' ? token : `Bearer ${token}` });

  async function identity(acc, provider = oauthProviderOf(acc)) {
    const raw = oauthTokenOf(acc, provider);
    if (!provider || !raw) return { accessToken: null, profile: null, apiKey: null };
    const key = createHash('sha256').update(JSON.stringify([acc.jwt, provider, raw])).digest('hex');
    const existing = identities.get(key);
    if (existing && existing.expiresAt > now()) return existing.promise;
    const entry = { expiresAt: now() + 30_000 };
    entry.promise = (async () => {
      let accessToken = raw;
      if (provider === 'zai') {
        try {
          const login = dataOf(await json(`${zaiOrigin}/api/auth/z/login`, { method: 'POST', body: { token: raw } }));
          accessToken = text(login?.access_token) || text(login?.accessToken) || raw;
        } catch { /* Older account files may already contain a business token. */ }
      }
      let profile = null;
      try {
        const value = dataOf(await json(`${bizOrigin(provider)}/api/biz/customer/getCustomerInfo`, {
          headers: bizHeaders(provider, accessToken),
        }));
        if (value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'code')) profile = value;
      } catch { /* Quota endpoints may still accept the token or explicit API key. */ }
      if (profile) entry.expiresAt = now() + 5 * 60_000;
      return { accessToken, profile, apiKey: null, keyPending: null };
    })();
    identities.set(key, entry);
    if (identities.size > 256) identities.delete(identities.keys().next().value);
    return entry.promise;
  }

  async function resolveKey(auth, provider, create = true) {
    if (auth.apiKey) return auth.apiKey;
    if (auth.keyPending) return auth.keyPending;
    const scope = pickOrgProject(auth.profile);
    if (!scope || !auth.accessToken) return null;
    auth.keyPending = (async () => {
      try {
        const url = `${bizOrigin(provider)}/api/biz/v1/organization/${encodeURIComponent(scope[0])}/projects/${encodeURIComponent(scope[1])}/api_keys`;
        const headers = bizHeaders(provider, auth.accessToken);
        const list = dataOf(await json(url, { headers }));
        if (!Array.isArray(list)) return null;
        let key = list.find((k) => k?.name === 'zcode-api-key');
        if (!key && !create) return null;
        // Match zcode-switch: reuse its named key, provision it only after a successful empty lookup.
        if (!key) key = dataOf(await json(url, { headers, method: 'POST', body: { name: 'zcode-api-key' } }));
        const publicKey = text(key?.apiKey);
        if (!publicKey) return null;
        let secret = '';
        try { secret = text(dataOf(await json(`${url}/copy/${encodeURIComponent(publicKey)}`, { headers }))?.secretKey); } catch {}
        auth.apiKey = secret ? `${publicKey}.${secret}` : provider === 'bigmodel' ? publicKey : null;
        return auth.apiKey;
      } catch { return null; }
    })().finally(() => { auth.keyPending = null; });
    return auth.keyPending;
  }

  async function campaign(version, headers) {
    if (campaignCache?.expiresAt > now()) return campaignCache.value;
    if (campaignPending) return campaignPending;
    campaignPending = (async () => {
      try {
        const query = new URLSearchParams({ app_version: version, platform: headers['x-platform'] || 'linux' });
        const payload = await json(`${zcodeOrigin}/api/v1/client/configs?${query}`, {
          zcode: true, headers: { 'user-agent': `ZCode/${version}`, 'x-app-version': version },
        });
        const copy = payload.data?.configs?.codingPlanBillingDiscount?.['zh-CN'];
        const value = text(copy?.badgeBody) ? { label: text(copy.badgeBody).slice(0, 100),
          description: [text(copy.infoTitle), text(copy.infoBody)].filter(Boolean).join('\n').slice(0, 4000) } : null;
        campaignCache = { value, expiresAt: now() + 600_000 };
        return value;
      } catch { campaignCache = { value: null, expiresAt: now() + 30_000 }; return null; }
    })().finally(() => { campaignPending = null; });
    return campaignPending;
  }

  async function query(acc, { version = '3.17.2', headers = {}, previous } = {}) {
    const provider = codingProviderOf(acc);
    const auth = await identity(acc, provider);
    const manualKey = text(acc.codingPlanApiKey);
    const autoKey = await resolveKey(auth, provider, !manualKey);
    // An explicit key can belong to a different account. Never mix its quota with OAuth metadata/MCP.
    const sameAccount = !manualKey || manualKey === autoKey;
    const candidates = [...new Set((manualKey ? [manualKey] : [autoKey, acc.jwt, auth.accessToken]).filter(Boolean))];
    const origin = provider === 'bigmodel' ? bigmodelOrigin : zaiOrigin;
    async function queryWithTokens(route, tokens, validate) {
      let failure;
      for (const token of tokens) {
        try {
          const value = dataOf(await json(`${origin}${route}`, { headers: {
            authorization: `Bearer ${token}`, 'user-agent': `ZCode/${version}`, 'x-request-id': randomUUID(),
          } }));
          if (!validate(value)) throw new Error('查询响应缺少有效 data');
          return value;
        } catch (error) { failure = error; if (!error.auth) break; }
      }
      throw failure || new Error('未找到对应平台的 Coding Plan 凭证');
    }
    const canMcp = sameAccount && !!auth.accessToken && oauthProviderOf(acc) === provider && !!acc.jwt;
    const results = await Promise.allSettled([
      queryWithTokens('/api/monitor/usage/quota/limit', candidates, (d) => d && Array.isArray(d.limits)),
      queryWithTokens('/api/biz/subscription/list', [...new Set([
        ...(sameAccount ? [auth.accessToken] : []), ...candidates,
      ].filter(Boolean))], Array.isArray),
      canMcp ? json(`${zcodeOrigin}/api/v1/mcp/usage`, { zcode: true, headers: {
        ...headers, authorization: `Bearer ${acc.jwt}`, 'X-Bigmodel-Authorization': `Bearer ${auth.accessToken}`,
        'Bigmodel-Target-Type': 'PERSONAL',
      } }).then((body) => {
        if (body.code !== 0 && body.code !== '0') throw new Error('MCP 查询响应异常');
        if (body.data == null) return null;
        if (typeof body.data !== 'object' || Array.isArray(body.data)) throw new Error('MCP 查询响应缺少有效 data');
        if (body.data.total_usage && !['limit', 'remaining', 'used'].every((key) =>
          typeof body.data.total_usage[key] === 'number' && Number.isFinite(body.data.total_usage[key]))) {
          throw new Error('MCP 查询响应缺少有效额度');
        }
        return body.data;
      }) : Promise.resolve(null),
      campaign(version, headers),
    ]);
    const [quota, subscription, mcp, discount] = results;
    const failed = (result) => result.status === 'rejected';
    const value = (result, fallback) => failed(result) ? fallback : result.value;
    const quotaData = value(quota, { limits: [] }), subscriptionData = value(subscription, []);
    const mcpData = value(mcp, null), campaignData = value(discount, null);
    const plans = normalizeCoding(quotaData, subscriptionData, mcpData, campaignData);
    const old = previous?.plans?.[0];
    if (old && results.slice(0, 3).some(failed)) {
      let plan = plans[0];
      if (!plan) {
        // Build current metadata before restoring failed resources: a successful subscription query
        // can rename the plan even while both quota endpoints are unavailable.
        plan = { ...codingPlanMetadata(quotaData, subscriptionData, campaignData), items: [] };
        plans.push(plan);
      }
      if (failed(quota)) plan.items.unshift(...old.items.filter((item) => item.id !== 'zcode-mcp'));
      if (failed(mcp) && canMcp) plan.items.push(...old.items.filter((item) => item.id === 'zcode-mcp'));
      if (failed(subscription)) { plan.name = old.name; plan.endsAt = old.endsAt; plan.status = old.status; }
    }
    const errors = results.slice(0, 3).flatMap((result, i) => failed(result)
      ? [`${['周期额度', '套餐订阅', 'ZCode MCP'][i]}：${result.reason.message}`] : []);
    const hasData = plans.some((plan) => plan.items.length);
    return { plans, status: errors.length ? (!hasData && !manualKey && !auth.accessToken ? 'unconfigured' : 'error') : 'ready',
      error: errors.join('；') || null,
      syncedAt: errors.length ? (old ? previous.syncedAt : hasData ? new Date(now()).toISOString() : null) : new Date(now()).toISOString() };
  }
  return { identity, query };
}
