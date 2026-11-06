import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClaimAutomation, validateAutoClaimSettings, scheduleDue, nextScheduledAt } from '../zcgw-auto-claim.mjs';
import { createCaptchaBrowser } from '../zcgw-captcha-browser.mjs';

const account = (label) => ({ label, name: label, jwt: 'fixture-credential', deviceId: 'fixture-device' });
const offer = (id = 'arbitrary-plan') => ({ planId: id, name: '名称随时改变', campaign: null });
async function harness(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-auto-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-07T01:00:00Z');
  const calls = [];
  const args = { dataDir, getAccounts: () => [account('one')], reserve: () => true, release: () => {},
    refreshAccount: async (acc) => { calls.push(`refresh:${acc.label}`); return { eligibility: { plans: [offer()], error: null } }; },
    prepare: async (acc, planId) => { calls.push(`prepare:${acc.label}:${planId}`); return { plan: offer(planId), preparationId: 'prepared' }; },
    verify: async () => { calls.push('verify'); return { param: 'proof', region: 'cn' }; },
    submit: async (acc, prepared, proof) => { calls.push(`submit:${acc.label}`); assert.equal(proof.param, 'proof'); return { ok: true }; },
    afterClaim: async () => { calls.push('refresh-after-claim'); }, closeVerifier: async () => { calls.push('close'); },
    now: () => clock, ...overrides,
  };
  return { args, calls, service: createClaimAutomation(args), setClock: (value) => { clock = Date.parse(value); } };
}

test('daily schedule validates settings, handles timezones/DST and never repeats a local date', () => {
  const settings = validateAutoClaimSettings({ enabled: true, time: '09:00' });
  assert.equal(scheduleDue(Date.parse('2026-11-07T00:59:59Z'), settings, null), null);
  assert.equal(scheduleDue(Date.parse('2026-11-07T01:00:00Z'), settings, null), '2026-11-07');
  assert.equal(scheduleDue(Date.parse('2026-11-07T14:00:00Z'), settings, '2026-11-07'), null);
  assert.equal(nextScheduledAt(Date.parse('2026-11-07T14:00:00Z'), settings, '2026-11-07'), '2026-11-08T01:00:00.000Z');
  assert.equal(nextScheduledAt(Date.now(), { ...settings, enabled: false }, null), null);
  const dst = { enabled: true, time: '02:30', timezone: 'America/New_York' };
  assert.equal(nextScheduledAt(Date.parse('2026-03-08T06:00:00Z'), dst, null), '2026-03-08T07:00:00.000Z');
  assert.equal(scheduleDue(Date.parse('2026-11-01T06:30:00Z'), { ...dst, time: '01:30' }, '2026-11-01'), null);
  for (const input of [{ time: '24:00' }, { time: '9:00' }, { enabled: 'true' }, { timezone: 'Mars/Olympus' }, []]) {
    assert.throws(() => validateAutoClaimSettings(input));
  }
});

test('scheduled claims are persisted before execution, serial, exclude disabled accounts and survive restart', async (t) => {
  let releaseRefresh;
  let checks = 0;
  const h = await harness(t, { getAccounts: () => [account('one'), { ...account('disabled'), disabled: true }],
    refreshAccount: async () => {
      checks++;
      if (checks === 1) await new Promise((resolve) => { releaseRefresh = resolve; });
      return { eligibility: { plans: [offer('first'), offer('second')] } };
    } });
  h.service.configure({ enabled: true });
  h.service.tick();
  await Promise.resolve();
  const id = h.service.snapshot().lastRun.id;
  const saved = JSON.parse(await readFile(path.join(h.args.dataDir, 'auto-claim.json')));
  assert.equal(saved.lastScheduledDate, '2026-11-07');
  assert.equal(saved.run.status, 'running');
  assert.equal(h.service.start().lastRun.id, id);
  h.service.tick();
  assert.equal(checks, 1);
  releaseRefresh();
  await h.service.settled();
  assert.equal(h.service.snapshot().lastRun.results.filter((r) => r.status === 'claimed').length, 2);
  assert.deepEqual(h.calls, ['prepare:one:first', 'verify', 'submit:one', 'refresh-after-claim', 'prepare:one:second', 'verify', 'submit:one', 'refresh-after-claim', 'close']);
  const restarted = createClaimAutomation(h.args);
  restarted.tick();
  assert.equal(restarted.snapshot().lastRun.id, id);
  h.setClock('2026-11-08T01:00:00Z');
  restarted.tick();
  await restarted.settled();
  assert.equal(restarted.snapshot().lastRun.results.filter((r) => r.status === 'skipped').length, 2);
  assert.equal(h.calls.filter((c) => c.startsWith('submit:')).length, 2);
  const serialized = await readFile(path.join(h.args.dataDir, 'auto-claim.json'), 'utf8');
  assert.ok(!serialized.includes('fixture-credential') && !serialized.includes('proof'));
});

test('interactive captcha skips that account, business failures stop its offers, and other accounts continue', async (t) => {
  let verifying = 0;
  const h = await harness(t, { getAccounts: () => ['interactive', 'rejected', 'success'].map(account),
    refreshAccount: async () => ({ eligibility: { plans: [offer('one'), offer('two')] } }),
    verify: async () => { if (++verifying === 1) throw Object.assign(new Error('需要人工验证'), { code: 'captcha_interactive' }); return { param: 'proof' }; },
    submit: async (acc) => acc.label === 'rejected' ? { ok: false, code: 3007, msg: '验证失败' } : { ok: true },
  });
  h.service.start();
  await h.service.settled();
  assert.deepEqual(h.service.snapshot().lastRun.results.map((r) => r.status), ['needs_verification', 'failed', 'claimed', 'claimed']);
  assert.equal(verifying, 4);
});

test('ambiguous submission and interrupted run are never replayed after restart', async (t) => {
  let submissions = 0;
  const h = await harness(t, { submit: async () => { submissions++; throw new Error('socket closed'); } });
  h.service.start();
  await h.service.settled();
  assert.equal(h.service.snapshot().lastRun.results[0].status, 'unknown');
  const file = path.join(h.args.dataDir, 'auto-claim.json');
  const saved = JSON.parse(await readFile(file));
  saved.run.status = 'running';
  await writeFile(file, JSON.stringify(saved));
  const restarted = createClaimAutomation(h.args);
  assert.equal(restarted.snapshot().lastRun.status, 'interrupted');
  h.setClock('2026-11-09T01:00:00Z');
  restarted.start();
  await restarted.settled();
  assert.equal(submissions, 1);
  assert.equal(restarted.snapshot().lastRun.results[0].status, 'unknown');
});

test('cancel or changed credentials after verification prevent submission; corrupted storage fails closed', async (t) => {
  let resolveProof;
  let currentAccount = account('one');
  const h = await harness(t, { getAccounts: () => [currentAccount],
    verify: () => new Promise((resolve) => { resolveProof = resolve; }) });
  h.service.start();
  while (!resolveProof) await new Promise((resolve) => setImmediate(resolve));
  h.service.cancel();
  resolveProof({ param: 'proof' });
  await h.service.settled();
  assert.equal(h.service.snapshot().lastRun.status, 'cancelled');
  assert.ok(!h.calls.some((c) => c.startsWith('submit:')));
  resolveProof = null;
  h.service.start();
  while (!resolveProof) await new Promise((resolve) => setImmediate(resolve));
  currentAccount = { ...currentAccount, jwt: 'new-credential' };
  resolveProof({ param: 'proof' });
  await h.service.settled();
  assert.ok(!h.calls.some((c) => c.startsWith('submit:')));
  await writeFile(path.join(h.args.dataDir, 'auto-claim.json'), '{broken');
  const broken = createClaimAutomation(h.args);
  assert.match(broken.snapshot().error, /记录无法读取/);
  assert.throws(() => broken.start(), /记录无法读取/);
});

test('SDK worker returns a fresh proof, never submits credentials and closes contexts for challenges', async () => {
  let browserCloses = 0, contextCloses = 0, sdkStarts = 0, challenges = false;
  const oldWindow = globalThis.window;
  globalThis.window = { initAliyunCaptcha: (cfg) => {
    sdkStarts++;
    cfg.getInstance({ startTracelessVerification: () => challenges ? cfg.fail() : cfg.success('fresh-proof'), destroy() {} });
  } };
  const worker = createCaptchaBrowser({ launch: async () => ({
    newContext: async () => ({
      close: async () => { contextCloses++; },
      newPage: async () => ({ setDefaultTimeout() {}, route: async () => {}, goto: async () => {},
        evaluate: async (fn, arg) => arg.url ? true : fn(arg) }),
    }),
    close: async () => { browserCloses++; },
  }) });
  try {
    const config = { enabled: true, sceneId: 'scene', region: 'cn', prefix: 'prefix' };
    assert.deepEqual(await worker.verify(config), { param: 'fresh-proof', region: 'cn' });
    challenges = true;
    await assert.rejects(worker.verify(config), (e) => e.code === 'captcha_interactive');
    assert.equal(sdkStarts, 2);
    assert.equal(contextCloses, 2);
    await worker.close();
    assert.equal(browserCloses, 1);
  } finally { globalThis.window = oldWindow; }
});

test('SDK worker runs in real Chromium with a local mock SDK, without external requests', {
  skip: !process.env.ZCGW_TEST_CHROMIUM_PATH,
}, async () => {
  const { chromium } = await import('playwright-core');
  let launched;
  let challenge = false;
  let external = 0;
  const worker = createCaptchaBrowser({ executablePath: process.env.ZCGW_TEST_CHROMIUM_PATH, launch: async (options) => {
    launched = await chromium.launch(options);
    const newContext = launched.newContext.bind(launched);
    launched.newContext = async () => {
      const context = await newContext();
      await context.route('**/*', (route) => {
        if (route.request().url().includes('/captcha-frontend/')) return route.fulfill({ contentType: 'application/javascript', body:
          `window.initAliyunCaptcha = (o) => o.getInstance({startTracelessVerification() { ${challenge ? 'o.fail()' : "o.success({captchaVerifyParam: 'mock-proof'})"}; }, destroy() {}});` });
        external++;
        return route.abort();
      });
      return context;
    };
    return launched;
  } });
  try {
    const config = { enabled: true, sceneId: 'fixture', region: 'cn', prefix: 'fixture' };
    assert.deepEqual(await worker.verify(config), { param: 'mock-proof', region: 'cn' });
    challenge = true;
    await assert.rejects(worker.verify(config), (error) => error.code === 'captcha_interactive');
    assert.equal(launched.contexts().length, 0);
    assert.equal(external, 0);
  } finally { await worker.close(); }
});
