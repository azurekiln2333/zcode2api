import test from 'node:test';
import assert from 'node:assert/strict';
import { claimDetails, effectiveFromCopy, formatClaimTime } from '../web/src/claim-details.ts';

const at = (year, month, day, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime();
const now = at(2026, 11, 7, 12);
const offer = (overrides = {}) => ({ planId: 'offer', name: '任意活动', description: '', entitlements: [],
  effectiveAt: null, campaign: null, ...overrides });

test('details distinguish activity start, explicit activation, estimated copy and missing time', () => {
  const source = { plans: [
    offer({ planId: 'activity-only', startsAt: at(2026, 11, 7, 8) }),
    offer({ planId: 'immediate', effectiveAt: 0, description: '将于2026年11月8日23:00生效' }),
    offer({ planId: 'estimated', campaign: { body: '活动2026年11月7日19:00开始，将于2026年11月7日23:00生效', startsAt: at(2026, 11, 7, 19) } }),
    offer({ planId: 'explicit', effectiveAt: at(2026, 11, 8, 9), description: '将于2026年11月9日23:00生效' }),
  ] };
  const rows = claimDetails(source, now);
  assert.equal(rows[0].effectiveText, '领取后确认');
  assert.equal(rows[0].startsAt, at(2026, 11, 7, 8));
  assert.equal(rows[1].effectiveText, '立即生效');
  assert.equal(rows[2].effectiveText, '预计 2026-11-07 23:00 生效（据活动说明）');
  assert.equal(rows[3].effectiveText, '2026-11-08 09:00');
  assert.equal(formatClaimTime(null), '未提供');
  assert.equal(formatClaimTime('invalid'), '未提供');
});

test('detail groups prefer current ownership and distinguish pending activation and expired plans', () => {
  const campaign = { title: '活动标题', body: '活动说明', campaignId: 'campaign-any', position: 'banner', startsAt: at(2026, 11, 1) };
  const result = claimDetails({ plans: [offer({ campaign }), offer({ planId: 'expired-offer', endsAt: now - 1 })], currentPlans: [
    offer({ userPlanId: 'user-plan', status: 'active', effectiveAt: now + 3600_000 }),
    offer({ planId: 'past', userPlanId: 'past-plan', status: 'expired' }),
  ] }, now);
  assert.equal(result.length, 3);
  assert.equal(result.filter((r) => r.status === 'claimable').length, 0, 'owned or expired offers cannot be claimed from the dialog');
  const current = result.find((r) => r.key === 'user-plan');
  assert.equal(current.title, campaign.title);
  assert.equal(current.statusText, '已领取 · 待生效');
  assert.equal(current.campaignId, campaign.campaignId);
  assert.equal(current.startsAt, campaign.startsAt);
  assert.equal(result.find((r) => r.planId === 'past').status, 'expired');
});

test('copy fallback rejects invalid dates and unrelated activity windows and handles year rollover', () => {
  assert.equal(effectiveFromCopy('活动2026-11-07 19:00开始', now), null);
  assert.equal(effectiveFromCopy('将于2026年2月30日23:00生效', now), null);
  assert.equal(effectiveFromCopy('将于11月7日23:00生效', now), at(2026, 11, 7, 23));
  assert.equal(effectiveFromCopy('将于1/5 09:00生效', now), at(2027, 1, 5, 9));
  assert.equal(effectiveFromCopy('将于2026-11-07 23:00生效', now), at(2026, 11, 7, 23));
});
