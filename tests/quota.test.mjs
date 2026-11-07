import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBilling, normalizeCoding } from '../zcgw-quota.mjs';

test('billing keeps plans, models, zero balances and unknown amounts separate', () => {
  const plans = normalizeBilling({
    plans: [
      { plan_id: 'start', name: 'Start Plan', status: 'active' },
      { plan_id: 'zai', name: 'Z.ai', status: 'active' },
    ],
    balances: [
      { plan_id: 'start', show_name: 'GLM A', total_units: '100', remaining_units: '20' },
      { plan_id: 'start', show_name: 'GLM B', total_units: 10, remaining_units: 0 },
      { plan_id: 'zai', show_name: 'GLM A', total_units: 1000, used_units: 300, period_end: 1800000000 },
      { show_name: 'unknown 1', remaining_units: 12 },
      { show_name: 'unknown 2', total_units: -1 },
    ],
  });
  assert.deepEqual(plans.map((p) => [p.name, p.items.length]), [['Start Plan', 2], ['Z.ai', 1], ['未标注套餐', 2]]);
  assert.equal(plans[0].items[0].remainingPercent, 20);
  assert.equal(plans[0].items[1].remainingPercent, 0);
  assert.equal(plans[1].items[0].remaining, 700);
  assert.equal(plans[1].items[0].resetAt, new Date(1800000000000).toISOString());
  assert.equal(plans[2].items[0].total, null);
  assert.equal(plans[2].items[0].remainingPercent, null);
  assert.equal(plans[2].items[1].total, null);
});

test('coding plan windows are distinct and percentage-only responses stay unknown in units', () => {
  const [plan] = normalizeCoding({ level: 'Pro', limits: [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: '80', currentValue: '20', nextResetTime: 1800000000000 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 25 },
    { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 0, currentValue: 0 },
  ] });
  assert.equal(plan.items.length, 3);
  assert.equal(plan.items[0].remaining, 60);
  assert.match(plan.items[0].name, /5 小时/);
  assert.equal(plan.items[1].name, '每周剩余');
  assert.equal(plan.items[1].remainingPercent, 75);
  assert.equal(plan.items[1].total, null);
  assert.equal(plan.items[1].remaining, null);
  assert.equal(plan.items[2].remainingPercent, null);
});

test('Coding Plan shows active subscription, percentage windows and independent MCP reset', () => {
  const [plan] = normalizeCoding({ limits: [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 6, usage: 1000, currentValue: 0, nextResetTime: 1794355200000 },
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 100 },
  ] }, [
    { productId: 'coding-old', productName: '旧套餐', status: 'EXPIRED' },
    { productId: 'coding-trial', productName: 'GLM Coding Plan 优享体验卡', inCurrentPeriod: true, nextRenewTime: '2026-11-11T16:00:00Z' },
  ], { server_time: 1794000000, next_refresh_at: 1794144000, total_usage: { limit: 500, used: 0, remaining: 500 } },
  { label: '150% 配额', description: '活动说明' });
  assert.equal(plan.name, 'GLM Coding Plan 优享体验卡');
  assert.equal(plan.endsAt, '2026-11-11T16:00:00.000Z');
  assert.deepEqual(plan.items.map((item) => [item.name, item.remainingPercent]), [
    ['5 小时剩余', 100], ['每周剩余', 94], ['工具调用', 0], ['ZCode MCP', 100],
  ]);
  assert.equal(plan.items[0].total, null);
  assert.equal(plan.items[3].total, 500);
  assert.equal(plan.items[3].resetAt, new Date(1794144000000).toISOString());
  assert.equal(plan.campaign.label, '150% 配额');
});

test('MCP zero, missing and invalid quotas are distinct; expiry supports valid date ranges', () => {
  const subscription = [{ productName: '未来可以改名的套餐', status: 'VALID', valid: '2026-11-01 - 2026-11-11' }];
  const [plan] = normalizeCoding({ limits: [] }, subscription, { total_usage: { limit: 100, remaining: 0 } });
  assert.equal(plan.name, subscription[0].productName);
  assert.equal(plan.endsAt, '2026-11-11T00:00:00.000Z');
  assert.equal(plan.items[0].remainingPercent, 0);
  assert.equal(normalizeCoding({ limits: [] }, subscription, { total_usage: { limit: 100, remaining: -1 } })[0].items[0].remainingPercent, 0);
  for (const mcp of [null, {}, { total_usage: { limit: 0, remaining: 0 } }, { total_usage: { limit: -1, remaining: 0 } }]) {
    assert.deepEqual(normalizeCoding({ limits: [] }, subscription, mcp), []);
  }
});
