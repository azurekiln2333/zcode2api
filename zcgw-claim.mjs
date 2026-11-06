// Ported from zcode-switch src-tauri/src/claim.rs and quota.rs.
// Copyright (c) 2026 zcode-switch contributors. MIT; see THIRD_PARTY_NOTICES.md.
import crypto from 'node:crypto';
import os from 'node:os';

export function billingHeaders({ token, deviceId, version, origin }) {
  return {
    'user-agent': `ZCode/${version}`, 'http-referer': origin, 'x-title': 'Z Code@electron',
    'x-zcode-app-version': version, 'x-platform': `${process.platform}-${process.arch}`,
    'x-release-channel': 'production', 'x-client-language': 'zh-CN',
    'x-client-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    'x-os-category': { win32: 'windows', darwin: 'macos' }[process.platform] || process.platform,
    'x-os-version': os.release(), ...(deviceId ? { 'x-device-mid': deviceId } : {}),
    authorization: `Bearer ${token || ''}`, 'x-request-id': crypto.randomUUID(),
  };
}

export const sortPlans = (plans) => plans.sort((a, b) => b.priority - a.priority || (a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0));
const str = (obj, a, b = a) => typeof obj?.[a] === 'string' ? obj[a] : typeof obj?.[b] === 'string' ? obj[b] : '';
const num = (obj, a, b = a) => typeof obj?.[a] === 'number' ? obj[a] : typeof obj?.[b] === 'number' ? obj[b] : null;
const millis = (value) => Number.isFinite(value) ? value * 1000 : null;
export function effectiveAt(plan) {
  const times = (Array.isArray(plan?.entitlements) ? plan.entitlements : [])
    .map((e) => num(e, 'effective_at', 'effectiveAt')).filter(Number.isFinite);
  return times.length ? Math.min(...times) * 1000 : null;
}
export function parseClaimPlan(plan) {
  const planId = str(plan, 'plan_id', 'planId').trim();
  if (!planId) return null;
  const grants = (Array.isArray(plan.entitlements) ? plan.entitlements : [])
    .filter((e) => e?.meter === 'model_usage' && str(e, 'unit_type', 'unitType') === 'token' && str(e, 'show_name', 'showName').trim())
    .map((e) => ({ model: str(e, 'show_name', 'showName'), grant: num(e, 'grant_units', 'grantUnits') ?? 0, period: str(e, 'period') || 'one_time' }));
  return { planId, name: str(plan, 'name').trim() || planId, description: str(plan, 'description').trim(),
    priority: Number.isInteger(plan.priority) ? plan.priority : 0, entitlements: grants, effectiveAt: effectiveAt(plan),
    startsAt: millis(num(plan, 'starts_at', 'startsAt')), endsAt: millis(num(plan, 'ends_at', 'endsAt')), campaign: null };
}

function walk(value, visit) {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value && typeof value === 'object') { visit(value); Object.values(value).forEach((v) => walk(v, visit)); }
}
const at = (value, route) => route.split('/').filter(Boolean).reduce((v, key) => v?.[key], value);
const textOf = (value) => (typeof value === 'string' ? value : str(value, 'content')).trim();
const plainText = (value) => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
function firstText(value, routes, keys) {
  for (const route of routes) { const text = textOf(at(value, route)); if (text) return text; }
  let text = '';
  walk(value, (obj) => {
    for (const [key, item] of Object.entries(obj)) if (!text && keys.includes(key) && typeof item === 'string' && item.trim().length < 400) text = item.trim();
  });
  return text;
}
function actionInfo(action) {
  return { kind: str(action, 'type'), planId: (str(action?.args, 'plan_id') || str(action, 'planId')).trim() || null };
}
export function campaignFromDelivery(delivery) {
  const buttons = [];
  walk(delivery, (obj) => { if (obj.action?.type) buttons.push(actionInfo(obj.action)); });
  const time = (key) => {
    for (const prefix of ['', '/banner/background/args/zcode_plan', '/popup/hero/args/zcode_plan', '/background/args/zcode_plan']) {
      const value = at(delivery, `${prefix}/${key}`); if (Number.isFinite(value)) return millis(value);
    }
    return null;
  };
  return {
    campaignId: str(delivery, 'campaign_id', 'campaignId').trim(),
    position: str(delivery, 'resource_position', 'resourcePosition').trim(),
    title: plainText(firstText(delivery, ['/banner/success_popup/title', '/popup/title', '/banner/title', '/title'], ['title', 'heading', 'headline'])),
    body: plainText(firstText(delivery, ['/banner/success_popup/description', '/popup/description', '/banner/description', '/description', '/banner/text', '/text'], ['text', 'subtitle', 'description', 'content', 'body'])),
    buttons, startsAt: time('starts_at'), endsAt: time('ends_at'),
  };
}
export function parseMarketingPlans(deliveries) {
  const payloads = [], buttonIds = new Map();
  for (const delivery of deliveries) {
    const campaign = campaignFromDelivery(delivery);
    walk(delivery, (obj) => {
      const action = actionInfo(obj.action);
      if (['claim_zcode_plan', 'claim_plan'].includes(action.kind) && action.planId && !buttonIds.has(action.planId)) buttonIds.set(action.planId, campaign);
      if (typeof obj.name === 'string' || Array.isArray(obj.entitlements)) {
        const plan = parseClaimPlan(obj);
        if (plan) payloads.push({ ...plan, campaign });
      }
    });
  }
  for (const [planId, campaign] of buttonIds) if (!payloads.some((p) => p.planId === planId)) payloads.push({ ...parseClaimPlan({ plan_id: planId }), campaign });
  const plans = new Map();
  for (const plan of sortPlans(payloads)) if (!plans.has(plan.planId)) plans.set(plan.planId, plan);
  return [...plans.values()];
}
export function mergeClaimPlans(base, extra) {
  const plans = new Map(base.map((p) => [p.planId, p]));
  for (const plan of extra) {
    const existing = plans.get(plan.planId);
    if (!existing) plans.set(plan.planId, plan);
    else { existing.campaign ||= plan.campaign; existing.description ||= plan.description; }
  }
  return sortPlans([...plans.values()]);
}
export function parseCurrentPlans(plans) {
  return plans.map((p) => {
    const plan = parseClaimPlan(p);
    return plan ? { ...plan, userPlanId: str(p, 'user_plan_id', 'userPlanId'), status: str(p, 'status') } : null;
  }).filter(Boolean).sort((a, b) => (b.endsAt || 0) - (a.endsAt || 0) || a.planId.localeCompare(b.planId));
}

export function claimFailure(code, response, body) {
  const messages = { 1001: '套餐不存在', 1002: '活动已结束或套餐暂不可领取', 1003: '该套餐已经领取过',
    1004: '不符合领取条件', 1005: '今日领取名额已用完', 3001: '领取参数错误，请刷新后重试',
    3007: '验证码校验失败，请重新发起领取', 401: '请先登录后再领取' };
  const challenged = [401, 403].includes(response.status) && (response.headers.has('x-aliyun-captcha-verify-param') || /captcha/i.test(response.body));
  return { ok: false, code: challenged ? -2 : code,
    msg: challenged ? '触发了人机校验拦截，请重新发起领取并完成验证' : messages[code] || `领取失败（HTTP ${response.status}，业务码 ${code}）`,
    nextAt: code === 1005 ? millis(body?.data?.plan?.ends_at) : null,
    ...(code === 1003 ? { alreadyClaimed: true } : {}) };
}
