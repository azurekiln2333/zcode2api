// Keep upstream quota buckets separate: plans, models, units and reset windows
// cannot be added together to describe a single usable balance.
export function quotaNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function quotaDate(value) {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') return null;
  const n = Number(value);
  const date = new Date(Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function amounts(totalValue, usedValue, remainingValue, percentage) {
  const total = quotaNumber(totalValue);
  let used = quotaNumber(usedValue);
  let remaining = quotaNumber(remainingValue);
  if (remaining === null && total !== null && used !== null) remaining = Math.max(0, total - used);
  if (used === null && total !== null && remaining !== null) used = Math.max(0, total - remaining);
  const percentUsed = total > 0 && used !== null
    ? Math.min(100, (used / total) * 100)
    : quotaNumber(percentage);
  return { total, used, remaining, remainingPercent: percentUsed === null ? null : Math.max(0, Math.min(100, 100 - percentUsed)) };
}

export function normalizeBilling(data) {
  const plans = (Array.isArray(data.plans) ? data.plans : []).map((p, index) => ({
    id: String(p.plan_id || p.id || `plan-${index}`),
    name: String(p.name || p.plan_id || '未命名套餐'),
    status: String(p.status || 'unknown'),
    endsAt: quotaDate(p.ends_at),
    items: [],
  }));
  for (const [index, b] of (Array.isArray(data.balances) ? data.balances : []).entries()) {
    const planId = String(b.plan_id || b.planId || (plans.some((p) => p.id === b.entitlement_id) ? b.entitlement_id : ''));
    // A missing association is unknown, never attribute it to the first plan.
    let plan = plans.find((p) => p.id === (planId || 'unassigned'));
    if (!plan) {
      plan = { id: planId || 'unassigned', name: String(b.plan_name || planId || '未标注套餐'), status: 'unknown', endsAt: null, items: [] };
      plans.push(plan);
    }
    plan.items.push({
      id: `${plan.id}:${b.entitlement_id || b.show_name || 'balance'}:${index}`,
      name: String(b.show_name || b.name || b.entitlement_id || '额度'),
      unit: String(b.unit_type || b.meter || '单位'),
      ...amounts(b.total_units, b.used_units, b.remaining_units ?? b.available_units),
      resetAt: quotaDate(b.period_end || b.expires_at),
    });
  }
  return plans;
}

export function codingSubscription(subscriptions) {
  const list = (Array.isArray(subscriptions) ? subscriptions : []).filter((s) => s && typeof s === 'object');
  const coding = (s) => /coding/i.test(`${s.productId || ''} ${s.productName || ''}`);
  const active = (s) => s.inCurrentPeriod === true && String(s.status).toUpperCase() === 'VALID';
  const available = (s) => s.inCurrentPeriod !== false && (s.status == null || String(s.status).toUpperCase() === 'VALID');
  return list.find((s) => coding(s) && active(s)) || list.find(active) || list.find(available) || list[0] || null;
}

function subscriptionExpiry(subscription) {
  if (!subscription) return null;
  for (const key of ['nextRenewTime', 'expireTime', 'expire_time', 'endTime', 'end_time', 'expireAt',
    'expiredTime', 'validEndTime', 'expires_at', 'expiresAt', 'expired_at', 'period_end']) {
    if (key === 'nextRenewTime' && subscription.autoRenew === true) continue;
    const date = quotaDate(subscription[key]);
    if (date) return date;
  }
  const dates = typeof subscription.valid === 'string' ? subscription.valid.match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/g) : null;
  return dates?.length ? quotaDate(dates.at(-1)) : null;
}

export function codingPlanMetadata(data = {}, subscriptions = [], campaign = null) {
  const subscription = codingSubscription(subscriptions);
  return {
    id: 'coding-plan', name: String(subscription?.productName || data?.productName || data?.level || 'Coding Plan'),
    status: String(subscription?.status || 'active'), endsAt: subscriptionExpiry(subscription),
    ...(campaign ? { campaign } : {}),
  };
}

export function normalizeCoding(data, subscriptions = [], mcp = null, campaign = null) {
  const limits = (Array.isArray(data?.limits) ? data.limits : []).filter((l) => l && typeof l === 'object');
  const periodUnits = { 3: '小时', 4: '天', 5: '月', 6: '周' };
  const items = limits.map((l, index) => {
      const unit = Number(l.unit), count = Number(l.number ?? (unit === 3 ? 5 : 1));
      const period = periodUnits[unit] ? `${count} ${periodUnits[unit]}` : '当前周期';
      const names = { CREDIT_LIMIT: 'Credits', TOKENS_LIMIT: '用量', TIME_LIMIT: '工具用量' };
      const amount = amounts(l.usage, l.currentValue, l.remaining, l.percentage);
      // The monitor's percentage is authoritative, including percentage-only/rolling windows.
      const percentage = quotaNumber(l.percentage);
      if (percentage !== null) amount.remainingPercent = Math.max(0, Math.min(100, 100 - percentage));
      const name = l.type === 'TOKENS_LIMIT'
        ? unit === 3 ? `${count} 小时剩余` : unit === 6 && count === 1 ? '每周剩余' : `${period}剩余`
        : l.type === 'TIME_LIMIT' && unit === 5 ? '工具调用' : `${names[l.type] || l.type || '额度'} · ${period}`;
      return {
        id: `${l.type || 'limit'}:${l.unit}:${l.number}:${index}`,
        name, unit: l.type === 'CREDIT_LIMIT' ? 'Credits' : '单位', display: 'percent',
        ...amount, resetTimeFormat: unit === 3 ? 'datetime' : 'date',
        resetAt: quotaDate(l.nextResetTime),
      };
    });
  const total = quotaNumber(mcp?.total_usage?.limit);
  const rawRemaining = mcp?.total_usage?.remaining;
  const remaining = Number.isFinite(rawRemaining) ? Math.max(0, rawRemaining) : null;
  if (total > 0 && remaining !== null) {
    const available = Math.min(total, remaining);
    items.push({ id: 'zcode-mcp', name: 'ZCode MCP', unit: '次', display: 'percent',
      ...amounts(total, total - available, available), resetTimeFormat: 'date', resetAt: quotaDate(mcp.next_refresh_at) });
  }
  if (!items.length) return [];
  return [{ ...codingPlanMetadata(data, subscriptions, campaign), items }];
}
