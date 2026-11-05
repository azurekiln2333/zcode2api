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

export function normalizeCoding(data) {
  const limits = Array.isArray(data.limits) ? data.limits : [];
  if (!limits.length) return [];
  const periodUnits = { 3: '小时', 4: '天', 5: '月', 6: '周' };
  return [{
    id: 'coding-plan', name: String(data.productName || data.level || 'Coding Plan'), status: 'active', endsAt: null,
    items: limits.map((l, index) => {
      const period = periodUnits[l.unit] ? `${l.number ?? 1} ${periodUnits[l.unit]}` : '当前周期';
      const names = { CREDIT_LIMIT: 'Credits', TOKENS_LIMIT: '用量', TIME_LIMIT: '工具用量' };
      return {
        id: `${l.type || 'limit'}:${l.unit}:${l.number}:${index}`,
        name: `${names[l.type] || l.type || '额度'} · ${period}`,
        unit: l.type === 'CREDIT_LIMIT' ? 'Credits' : '单位',
        ...amounts(l.usage, l.currentValue, l.remaining, l.percentage),
        resetAt: quotaDate(l.nextResetTime),
      };
    }),
  }];
}
