import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelCaptcha } from '../zcgw-captcha-panel.mjs';

const first = 'first-browser-00001', second = 'second-browser-0002';
const config = { enabled: true, sceneId: 'fixture', region: 'sgp', prefix: 'fixture' };
const poll = (broker, clientId = first, available = true) => broker.poll({ clientId, available });

test('one authenticated tab receives each proof task; foreign and duplicate replies cannot resolve it', async () => {
  const broker = createPanelCaptcha();
  poll(broker); poll(broker, second);
  const proof = broker.verify({ ...config, accountToken: 'must-not-travel' });
  const task = poll(broker).task;
  assert.deepEqual(task.config, config);
  assert.equal(poll(broker).task, null, 'polling again must not repeat an assigned verification');
  assert.equal(poll(broker, second).task, null);
  assert.equal(broker.complete({ clientId: second, taskId: task.id, param: 'foreign' }), false);
  assert.equal(broker.complete({ clientId: first, taskId: task.id, param: ' proof ', region: 'untrusted' }), true);
  assert.deepEqual(await proof, { param: 'proof', region: 'sgp' });
  assert.equal(broker.complete({ clientId: first, taskId: task.id, param: 'replay' }), false);
  assert.ok(!JSON.stringify(broker.status()).includes('proof'));
});

test('offline/busy browsers, timeout and cancellation never turn into successful verification', async () => {
  let clock = Date.now();
  const broker = createPanelCaptcha({ now: () => clock, timeoutMs: 10, clientTtlMs: 100 });
  await assert.rejects(broker.verify(config), (e) => e.code === 'browser_unavailable');
  poll(broker, first, false);
  await assert.rejects(broker.verify(config), /在线/);
  poll(broker);
  const timedOut = assert.rejects(broker.verify(config), /超时|离线/);
  const old = poll(broker).task;
  await timedOut;
  assert.equal(broker.complete({ clientId: first, taskId: old.id, param: 'late' }), false);
  const cancelled = assert.rejects(broker.verify(config), (e) => e.code === 'captcha_cancelled');
  const pending = poll(broker).task;
  await broker.close();
  await cancelled;
  assert.equal(broker.complete({ clientId: first, taskId: pending.id, param: 'late' }), false);
  clock += 101;
  assert.equal(broker.status().connectedPanels, 0);
  assert.throws(() => broker.poll({ clientId: '../bad', available: true }), /无效/);
});

test('interactive results keep their category and arbitrary browser errors are never copied into logs', async () => {
  const broker = createPanelCaptcha();
  poll(broker);
  const interactive = assert.rejects(broker.verify(config), (e) => e.code === 'captcha_interactive');
  let task = poll(broker).task;
  broker.complete({ clientId: first, taskId: task.id, error: 'captcha_interactive' });
  await interactive;
  const failed = assert.rejects(broker.verify(config), (e) => e.code === 'browser_unavailable' && !e.message.includes('secret'));
  task = poll(broker).task;
  assert.throws(() => broker.complete({ clientId: first, taskId: task.id, param: '' }), /无效/);
  broker.complete({ clientId: first, taskId: task.id, error: 'url?token=secret' });
  await failed;
});
