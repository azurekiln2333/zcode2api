import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaimPlan, parseMarketingPlans, mergeClaimPlans, parseCurrentPlans, claimFailure } from '../zcgw-claim.mjs';

test('reference plan contract handles renamed plans, campaign metadata and immediate effective time', () => {
  const payload = { plan_id: 'anything-2099', name: '后续任意活动', priority: 20, starts_at: 1700000000, ends_at: 1800000000,
    entitlements: [
      { meter: 'model_usage', unit_type: 'token', show_name: 'Model A', grant_units: 300, effective_at: 0 },
      { meter: 'model_usage', unitType: 'token', showName: 'Model B', grantUnits: 200, effectiveAt: 1790000000 },
      { meter: 'other', unit_type: 'token', show_name: 'Ignore' },
    ] };
  const delivery = { campaign_id: 'arbitrary-campaign', resource_position: 'home', banner: {
    background: { args: { zcode_plan: payload } },
    success_popup: { title: { content: '活动文案', format: 'plaintext' }, description: { content: '<p>第一行</p><p>第二行</p>', format: 'html' } },
    buttons: [{ action: { type: 'claim_zcode_plan', args: { plan_id: payload.plan_id } } }],
  } };
  const plans = parseMarketingPlans([delivery, delivery]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].name, payload.name);
  assert.equal(plans[0].effectiveAt, 0);
  assert.equal(plans[0].startsAt, 1700000000000);
  assert.equal(plans[0].endsAt, 1800000000000);
  assert.deepEqual(plans[0].entitlements.map((e) => e.model), ['Model A', 'Model B']);
  assert.deepEqual(plans[0].campaign, { campaignId: 'arbitrary-campaign', position: 'home', title: '活动文案', body: '第一行 第二行',
    startsAt: 1700000000000, endsAt: 1800000000000, buttons: [{ kind: 'claim_zcode_plan', planId: payload.plan_id }] });
  const merged = mergeClaimPlans([parseClaimPlan({ planId: payload.plan_id, name: 'Preview name', priority: 5 })], plans);
  assert.equal(merged[0].name, 'Preview name');
  assert.equal(merged[0].priority, 5);
  assert.equal(merged[0].campaign.campaignId, 'arbitrary-campaign');
  const current = parseCurrentPlans([null, { ...payload, status: 'active', userPlanId: 'account-plan' }]);
  assert.equal(current.length, 1);
  assert.equal(current[0].userPlanId, 'account-plan');
  assert.equal(current[0].effectiveAt, 0);
  assert.equal(current[0].startsAt, 1700000000000);
});

test('button-only marketing offers retain the activity metadata needed by the confirmation dialog', () => {
  const [plan] = parseMarketingPlans([{ campaignId: 'campaign-id', title: '可变化的活动名称', starts_at: 1790000000,
    description: '活动详情', buttons: [{ action: { type: 'claim_plan', planId: 'offer-button' } }] }]);
  assert.equal(plan.planId, 'offer-button');
  assert.equal(plan.campaign.title, '可变化的活动名称');
  assert.equal(plan.campaign.campaignId, 'campaign-id');
  assert.equal(plan.campaign.startsAt, 1790000000000);
});

test('challenge response headers and exhausted allocation are terminal claim failures', () => {
  const challenge = claimFailure(-1, { status: 403, headers: new Headers({ 'x-aliyun-captcha-verify-param': 'secret' }), body: '' }, null);
  assert.equal(challenge.code, -2);
  assert.equal(challenge.ok, false);
  assert.ok(!JSON.stringify(challenge).includes('secret'));
  const limited = claimFailure(1005, { status: 200, headers: new Headers(), body: '' }, { data: { plan: { ends_at: 1790000000 } } });
  assert.equal(limited.nextAt, 1790000000000);
});
