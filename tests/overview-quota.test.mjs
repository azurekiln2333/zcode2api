import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOverviewQuota } from '../web/src/overview-quota.ts';

const item = (overrides = {}) => ({ id: 'bucket', name: 'GLM', unit: 'token', total: 100,
  remaining: 50, used: 50, remainingPercent: 50, resetAt: null, ...overrides });
const source = (items, overrides = {}) => ({ id: 'billing', name: 'ZCode 套餐', status: 'ready', error: null,
  syncedAt: '2026-11-07T00:00:00Z', plans: [{ id: 'plan', name: '任意套餐', status: 'active', endsAt: null, items }], ...overrides });

test('overview merges token models and plans using their actual totals without changing account details', () => {
  const sources = [source([item({ total: 3000000, remaining: 1500000 }), item({ id: 'flash', total: 5000000, remaining: 5000000, unit: 'Tokens' })]),
    source([item({ total: 2000000, remaining: 500000 })], { id: 'second-plan' })];
  const before = structuredClone(sources);
  const quota = summarizeOverviewQuota(sources);
  assert.equal(quota.mode, 'amount');
  assert.equal(quota.unit, 'Tokens');
  assert.equal(quota.total, 10000000);
  assert.equal(quota.remaining, 7000000);
  assert.equal(quota.used, 3000000);
  assert.equal(quota.percent, 70);
  assert.equal(quota.plans, 2);
  assert.deepEqual(sources, before);
});

test('mixed units and overlapping Coding Plan windows yield one normalized percentage', () => {
  const quota = summarizeOverviewQuota([source([item({ remaining: 80 }), item({ unit: 'Credits', remaining: 20 })])]);
  assert.equal(quota.mode, 'percent');
  assert.equal(quota.percent, 50);
  assert.equal(quota.total, null);
  assert.equal(quota.remaining, null);
  const coding = summarizeOverviewQuota([source([
    item({ unit: '单位', total: null, remaining: null, remainingPercent: 75 }),
    item({ unit: '单位', total: null, remaining: null, remainingPercent: 25 }),
  ], { id: 'coding' })]);
  assert.equal(coding.percent, 50);
  assert.equal(coding.mode, 'percent');
  assert.equal(coding.unit, null);
});

test('overview uses authoritative Coding Plan percentages even when rolling counters differ', () => {
  const coding = summarizeOverviewQuota([source([
    item({ unit: '单位', total: 1000, remaining: 1000, remainingPercent: 94, display: 'percent' }),
    item({ unit: '次', total: 500, remaining: 500, remainingPercent: 100, display: 'percent' }),
  ], { id: 'coding' })]);
  assert.equal(coding.mode, 'percent');
  assert.equal(coding.percent, 97);
});

test('zero, unknown and partial quotas remain distinct and empty source errors are hidden', () => {
  const exhausted = summarizeOverviewQuota([source([item({ remaining: 0 })])]);
  assert.equal(exhausted.remaining, 0);
  assert.equal(exhausted.percent, 0);
  const zero = summarizeOverviewQuota([source([item({ total: 0, remaining: 0 })])]);
  assert.equal(zero.percent, 0);
  const unknown = summarizeOverviewQuota([source([item({ total: null, remaining: null, remainingPercent: null })])]);
  assert.equal(unknown.percent, null);
  assert.equal(unknown.total, null);
  const partial = summarizeOverviewQuota([source([item(), item({ total: null, remaining: null, remainingPercent: null })])]);
  assert.equal(partial.percent, 50);
  assert.equal(partial.partial, true);
  const empty = summarizeOverviewQuota([source([], { status: 'error', error: '401', syncedAt: null })]);
  assert.equal(empty.mode, 'empty');
  assert.equal(empty.percent, null);
  assert.equal(empty.stale, false);
});

test('overview retains stale snapshots and clamps invalid balances to a bounded bar', () => {
  const quota = summarizeOverviewQuota([source([item({ remaining: 140 })]),
    source([item({ remaining: 0 })], { status: 'error', error: 'temporary', syncedAt: '2026-11-06T23:00:00Z' })]);
  assert.equal(quota.percent, 50);
  assert.equal(quota.remaining, 100);
  assert.equal(quota.stale, true);
  assert.equal(quota.syncedAt, '2026-11-06T23:00:00Z');
  const remainingOnly = summarizeOverviewQuota([source([item({ total: null, remaining: 12, remainingPercent: null })])]);
  assert.equal(remainingOnly.remaining, 12);
  assert.equal(remainingOnly.total, null);
  assert.equal(remainingOnly.percent, null);
});
