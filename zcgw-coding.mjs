// OAuth/key discovery follows zcode-switch's oauth.rs (MIT; see THIRD_PARTY_NOTICES.md).
// Monitor, subscription and ZCode MCP are separate upstream resources.
import { createHash, randomUUID } from 'node:crypto';
import { normalizeCoding, codingPlanMetadata } from './zcgw-quota.mjs';
import { zcodeRequest, responseJson } from './zcgw-upstream.mjs';
import { userIdFromJwt } from './zcgw-fingerprint.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const text = (value) => typeof value === 'string' ? value.trim() : '';
export const oauthProviderOf = (acc) => acc.oauthProvider || (acc.bigmodelAccessToken ? 'bigmodel' : acc.zaiAccessToken ? 'zai' : null);
export const codingProviderOf = (acc) => acc.codingPlanProvider || oauthProviderOf(acc) || (acc.realm === 'cn' ? 'bigmodel' : 'zai');
export const oauthTokenOf = (acc, provider) => text(provider === 'bigmodel' ? acc.bigmodelAccessToken : acc.zaiAccessToken);
export const codingIdentity = (acc) => createHash('sha256').update(JSON.stringify([
  acc.jwt, codingProviderOf(acc), oauthProviderOf(acc), text(acc.zaiAccessToken), text(acc.bigmodelAccessToken), text(acc.codingPlanApiKey),
])).digest('hex');

// Discovered keys are private account credentials, not quota response data or manual overrides.
export const codingCredentialOwner = (acc) => String(userIdFromJwt(acc.jwt) ||
  createHash('sha256').update(text(acc.jwt)).digest('hex'));
export function savedCodingKey(acc, provider = codingProviderOf(acc)) {
  const saved = acc.codingPlanCredential;
  return saved?.provider === provider && saved.owner === codingCredentialOwner(acc) ? text(saved.apiKey) : '';
}

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
  zcodeRequestImpl = zcodeRequest, now = Date.now, persistCredential = () => false, wait = delay } = {}) {
  const identities = new Map();
  let campaignCache, campaignPending;

  async function json(url, { headers = {}, method = 'GET', body, zcode = false,
    trace, resource, credential, validate } = {}) {
    let response, payload;
    const step = { resource, ...(credential ? { credential } : {}), status: 'error' };
    try {
      const options = { method, headers: { accept: 'application/json', ...headers,
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) };
      response = zcode ? await zcodeRequestImpl(url, { ...options, timeoutMs: 12000 })
        : await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) });
      step.httpStatus = response.status;
      payload = zcode ? responseJson(response) : await response.json();
    } catch {
      step.error = '查询连接失败或响应不是有效 JSON';
      trace?.push(step);
      throw new Error(step.error);
    }
    if (payload?.code != null && String(payload.code).trim() && Number.isFinite(Number(payload.code))) step.code = Number(payload.code);
    if (!response.ok || !payload || typeof payload !== 'object' || payload.success === false ||
        (payload.code !== undefined && ![0, 200, '0', '200'].includes(payload.code))) {
      const code = payload?.code;
      const knownCode = code != null && String(code).trim() && Number.isFinite(Number(code)) ? Number(code) : '未知';
      const error = new Error(`查询失败（HTTP ${response.status}，业务码 ${knownCode}）`);
      error.auth = [401, 403].includes(response.status) || [401, 403, 1006].includes(Number(code));
      trace?.push({ ...step, error: error.message });
      throw error;
    }
    if (validate && !validate(dataOf(payload))) {
      step.error = '查询响应缺少有效 data';
      trace?.push(step);
      throw new Error(step.error);
    }
    step.status = 'ready';
    const data = dataOf(payload);
    if (Array.isArray(data)) step.count = data.length;
    else if (Array.isArray(data?.limits)) step.count = data.limits.length;
    trace?.push(step);
    return payload;
  }
  const dataOf = (body) => body.data !== undefined ? body.data : body;
  const bizOrigin = (provider) => provider === 'bigmodel' ? bigmodelBizOrigin : zaiOrigin;
  const bizHeaders = (provider, token) => ({ authorization: provider === 'bigmodel' ? token : `Bearer ${token}`,
    'content-type': 'application/json' });

  async function identity(acc, provider = oauthProviderOf(acc)) {
    const raw = oauthTokenOf(acc, provider);
    if (!provider || !raw) return { accessToken: null, profile: null, apiKey: null, steps: [], keySteps: [] };
    const key = createHash('sha256').update(JSON.stringify([acc.jwt, provider, raw])).digest('hex');
    const existing = identities.get(key);
    if (existing && existing.expiresAt > now()) return existing.promise;
    const entry = { expiresAt: now() + 30_000 };
    entry.promise = (async () => {
      const steps = [];
      let accessToken = raw;
      if (provider === 'zai') {
        try {
          const login = dataOf(await json(`${zaiOrigin}/api/auth/z/login`, { method: 'POST', body: { token: raw },
            trace: steps, resource: '业务登录', credential: 'OAuth' }));
          accessToken = text(login?.access_token) || text(login?.accessToken) || raw;
        } catch { /* Older account files may already contain a business token. */ }
      }
      let profile = null;
      try {
        const value = dataOf(await json(`${bizOrigin(provider)}/api/biz/customer/getCustomerInfo`, {
          headers: bizHeaders(provider, accessToken), trace: steps, resource: '客户资料', credential: 'OAuth',
        }));
        if (value && typeof value === 'object' && !Array.isArray(value)) profile = value;
      } catch { /* Quota endpoints may still accept the token or explicit API key. */ }
      if (profile) entry.expiresAt = now() + 5 * 60_000;
      return { accessToken, profile, apiKey: null, keyPending: null, steps, keySteps: [] };
    })();
    identities.set(key, entry);
    if (identities.size > 256) identities.delete(identities.keys().next().value);
    return entry.promise;
  }

  async function resolveKey(auth, provider, create = true) {
    if (auth.apiKey) return auth.apiKey;
    if (auth.keyPending) return auth.keyPending;
    const scope = pickOrgProject(auth.profile);
    if (!scope || !auth.accessToken) {
      auth.keySteps = [{ resource: '解析套餐凭证', status: 'skipped', error: !auth.accessToken
        ? '未保存对应平台的 OAuth 凭证，无法自动获取套餐 Key' : '客户资料未返回可用的个人机构和项目' }];
      return null;
    }
    auth.keyPending = (async () => {
      auth.keySteps = [];
      const options = { trace: auth.keySteps, credential: 'OAuth' };
      try {
        const url = `${bizOrigin(provider)}/api/biz/v1/organization/${encodeURIComponent(scope[0])}/projects/${encodeURIComponent(scope[1])}/api_keys`;
        const headers = bizHeaders(provider, auth.accessToken);
        const list = dataOf(await json(url, { headers, ...options, resource: '套餐 Key 列表', validate: Array.isArray }));
        let key = list.find((k) => k?.name === 'zcode-api-key');
        if (!key && !create) return null;
        // Match zcode-switch: reuse its named key, provision it only after a successful empty lookup.
        if (!key) key = dataOf(await json(url, { headers, method: 'POST', body: { name: 'zcode-api-key' },
          ...options, resource: '创建套餐 Key' }));
        const publicKey = text(key?.apiKey);
        if (!publicKey) {
          auth.keySteps.push({ resource: '解析套餐凭证', status: 'error', error: '套餐 Key 响应缺少 apiKey' });
          return null;
        }
        let secret = '';
        try { secret = text(dataOf(await json(`${url}/copy/${encodeURIComponent(publicKey)}`, {
          headers, ...options, resource: '读取套餐密钥',
        }))?.secretKey); } catch {}
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
    acc = { ...acc };
    const provider = codingProviderOf(acc);
    const auth = await identity(acc, provider);
    const manualKey = text(acc.codingPlanApiKey);
    const savedKey = savedCodingKey(acc, provider);
    const steps = [];
    let discovered = false, persisted = false;
    async function discover() {
      discovered = true;
      const apiKey = await resolveKey(auth, provider, !manualKey);
      if (apiKey && !manualKey && apiKey !== savedKey) {
        try {
          const stored = await persistCredential(acc, { provider, owner: codingCredentialOwner(acc), apiKey });
          persisted = stored === true;
          steps.push(persisted ? { resource: '保存套餐凭证', status: 'ready' }
            : { resource: '保存套餐凭证', status: 'skipped', error: '当前凭证未写入持久存储' });
        } catch {
          steps.push({ resource: '保存套餐凭证', status: 'error', error: '套餐凭证保存失败，下次查询仍需重新获取' });
        }
      }
      return apiKey;
    }
    let autoKey = savedKey || await discover();
    // An explicit key can belong to a different account. Never mix its quota with OAuth metadata/MCP.
    const sameAccount = !manualKey || manualKey === autoKey;
    const unique = (entries) => entries.filter((entry, index) => entry.token && entries.findIndex((e) => e.token === entry.token) === index);
    const candidates = unique(manualKey ? [{ token: manualKey, kind: '手填 Key' }] : [
      { token: autoKey, kind: savedKey ? '已保存 Key' : '自动获取 Key' },
      { token: acc.jwt, kind: '账号 JWT' }, { token: auth.accessToken, kind: 'OAuth' },
    ]);
    const origin = provider === 'bigmodel' ? bigmodelOrigin : zaiOrigin;
    async function queryWithTokens(route, tokens, validate, resource, rediscover = false, retryAuth = false) {
      let failure, firstBusiness;
      const attempt = async (candidate) => {
        const value = dataOf(await json(`${origin}${route}`, { headers: {
          authorization: `Bearer ${candidate.token}`, 'user-agent': `ZCode/${version}`, 'x-request-id': randomUUID(),
        }, validate, trace: steps, resource, credential: candidate.kind }));
        return { value, candidate };
      };
      const queue = [...tokens];
      for (let index = 0; index < queue.length; index++) {
        const candidate = queue[index];
        try {
          return await attempt(candidate);
        } catch (error) {
          failure = error;
          if (!error.auth && !firstBusiness) firstBusiness = error;
          // A revoked saved key must not pin this account to a stale credential forever.
          if (rediscover && !discovered && candidate.token === savedKey) {
            auth.apiKey = null;
            autoKey = await discover();
            if (autoKey && !queue.some((entry) => entry.token === autoKey)) {
              queue.splice(index + 1, 0, { token: autoKey, kind: '自动获取 Key' });
            }
          }
        }
      }
      // zcode-switch retries the first credential once when every candidate failed authentication.
      if (retryAuth && queue.length && !firstBusiness) {
        await wait(1500);
        try { return await attempt(queue[0]); } catch (error) { failure = error; }
      }
      throw firstBusiness || failure || new Error('未找到对应平台的 Coding Plan 凭证');
    }
    const canMcp = sameAccount && !!auth.accessToken && oauthProviderOf(acc) === provider && !!acc.jwt;
    const quotaPromise = queryWithTokens('/api/monitor/usage/quota/limit', candidates,
      (d) => d && Array.isArray(d.limits), '周期额度', !manualKey, !!(manualKey || autoKey || auth.accessToken));
    const subscriptionPromise = (async () => {
      const successful = await quotaPromise.then((result) => result.candidate, () => null);
      const tokens = unique([...(successful ? [successful] : []),
        ...(!manualKey && autoKey ? [{ token: autoKey, kind: savedKey === autoKey ? '已保存 Key' : '自动获取 Key' }] : []),
        ...candidates, ...(sameAccount ? [{ token: auth.accessToken, kind: 'OAuth' }] : []),
      ]);
      return (await queryWithTokens('/api/biz/subscription/list', tokens, Array.isArray, '套餐订阅')).value;
    })();
    if (!canMcp) steps.push({ resource: 'ZCode MCP', status: 'skipped', error: manualKey && !sameAccount
      ? '手填 Key 未确认属于此账号，不混入 OAuth 账号的 MCP 额度'
      : '缺少对应平台的 OAuth 授权凭证，MCP 额度尚未查询' });
    const results = await Promise.allSettled([
      quotaPromise.then((result) => result.value),
      subscriptionPromise,
      canMcp ? json(`${zcodeOrigin}/api/v1/mcp/usage`, { zcode: true, headers: {
        ...headers, authorization: `Bearer ${acc.jwt}`, 'X-Bigmodel-Authorization': `Bearer ${auth.accessToken}`,
        'Bigmodel-Target-Type': 'PERSONAL',
      }, trace: steps, resource: 'ZCode MCP', credential: 'JWT + OAuth', validate: (data) => data == null ||
        (typeof data === 'object' && !Array.isArray(data) && (!data.total_usage ||
          ['limit', 'remaining', 'used'].every((key) => typeof data.total_usage[key] === 'number' && Number.isFinite(data.total_usage[key])))),
      }).then((body) => {
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
    return { plans, status: errors.length ? (!hasData && !manualKey && !savedKey && !auth.accessToken ? 'unconfigured' : 'error') : 'ready',
      error: errors.join('；') || null,
      diagnostics: { provider, credentials: { oauth: !!auth.accessToken, savedKey: !!savedKey || persisted, manualKey: !!manualKey },
        steps: [...auth.steps, ...(discovered ? auth.keySteps : []), ...steps], checkedAt: new Date(now()).toISOString() },
      syncedAt: errors.length ? (old ? previous.syncedAt : hasData ? new Date(now()).toISOString() : null) : new Date(now()).toISOString() };
  }
  return { identity, query };
}
