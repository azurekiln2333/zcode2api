import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { default: Dialog } = await server.ssrLoadModule('/src/components/ClaimDetailsDialog.vue');
  const plan = { planId: 'arbitrary-offer', name: '任意活动套餐', description: '', effectiveAt: 0,
    startsAt: 1794049200000, endsAt: Date.now() + 86400_000,
    entitlements: [{ model: 'Model A', grant: 3000000, period: 'daily' }],
    campaign: { title: '活动标题', body: '<script>must remain text</script>', campaignId: 'activity-id' } };
  const account = { name: '测试账号', identity: 'demo@example.invalid', label: 'test-account',
    eligibility: { plans: [plan], currentPlans: [{ ...plan, planId: 'owned', userPlanId: 'owned-1', status: 'active' }],
      checkedAt: new Date().toISOString(), status: 'ready' } };
  let submissions = 0;
  const render = (initialPlanId, refreshing = false) => renderToString(createSSRApp({ render: () => h(Dialog, {
    account, initialPlanId, refreshing, busy: false, onClaim: () => { submissions++; },
  }) }));
  const html = await render('arbitrary-offer');
  for (const text of ['活动与套餐详情', '状态', '账号', '测试账号', '活动开始', '生效时间', '立即生效', '结束时间', '3,000,000', '领取此套餐']) assert.ok(html.includes(text), `missing detail: ${text}`);
  assert.ok(html.includes('&lt;script&gt;must remain text&lt;/script&gt;'), 'activity text must be escaped');
  assert.equal(submissions, 0, 'opening details cannot claim');
  assert.ok(!(await render('owned')).includes('领取此套餐'), 'owned plan details must not have a claim action');
  assert.match(await render('arbitrary-offer', true), /<button[^>]*class="button primary"[^>]*disabled[^>]*>.*?领取此套餐/s, 'refreshing disables claim action');
  console.log('Claim dialog verified: required fields, chosen plan, escaping and claim availability');
} finally { await server.close(); }
