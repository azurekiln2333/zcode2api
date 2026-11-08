import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCaptchaBrowser } from '../zcgw-captcha-browser.mjs';

const config = { enabled: true, sceneId: 'fixture', region: 'cn', prefix: 'fixture' };

test('no implicit local Chromium; remote failures never expose endpoint credentials', async () => {
  const absent = createCaptchaBrowser({ endpoint: '', executablePath: '' });
  assert.equal(absent.mode, 'panel');
  await assert.rejects(absent.verify(config), (e) => e.code === 'browser_unavailable');
  const endpoint = 'https://browser.invalid/?token=private-endpoint-secret';
  let launches = 0;
  const remote = createCaptchaBrowser({ endpoint, launch: () => { launches++; }, connect: async () => { throw new Error(endpoint); } });
  await assert.rejects(remote.verify(config), (e) => /外部浏览器/.test(e.message) && !e.message.includes('private-endpoint-secret'));
  assert.equal(launches, 0);
  const invalid = createCaptchaBrowser({ endpoint: 'file:///private-secret' });
  await assert.rejects(invalid.verify(config), (e) => /地址无效/.test(e.message) && !e.message.includes('private-secret'));
});

test('a connection established after cancellation is immediately disconnected without opening a page', async () => {
  let resolveConnection;
  let closes = 0, contexts = 0;
  const worker = createCaptchaBrowser({ endpoint: 'http://browser.invalid', connect: () => new Promise((r) => { resolveConnection = r; }) });
  const pending = assert.rejects(worker.verify(config), (e) => e.code === 'captcha_cancelled');
  await worker.close();
  resolveConnection({ close: async () => { closes++; }, newContext: () => { contexts++; } });
  await pending;
  assert.equal(closes, 1);
  assert.equal(contexts, 0);
});

test('real CDP verification leaves the external browser and its original tab running', {
  skip: !process.env.ZCGW_TEST_CHROMIUM_PATH, timeout: 30000,
}, async () => {
  const { chromium } = await import('playwright-core');
  const profile = await mkdtemp(path.join(os.tmpdir(), 'zcgw-cdp-'));
  let host, worker, connected;
  let externalRequests = 0;
  try {
    host = await chromium.launchPersistentContext(profile, { executablePath: process.env.ZCGW_TEST_CHROMIUM_PATH,
      headless: true, args: ['--remote-debugging-port=0', '--no-sandbox'] });
    const original = host.pages()[0];
    await original.setContent('<title>existing-user-tab</title>');
    const [port] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    worker = createCaptchaBrowser({ endpoint: `http://127.0.0.1:${port}`, connect: async (...args) => {
      connected = await chromium.connectOverCDP(...args);
      const newContext = connected.newContext.bind(connected);
      connected.newContext = async () => {
        const context = await newContext();
        await context.route('**/*', (route) => {
          if (route.request().url().includes('/captcha-frontend/')) return route.fulfill({ contentType: 'application/javascript',
            body: "window.initAliyunCaptcha = (o) => o.getInstance({startTracelessVerification() {o.success('remote-proof')}, destroy(){}})" });
          externalRequests++;
          return route.abort();
        });
        return context;
      };
      return connected;
    } });
    assert.deepEqual(await worker.verify(config), { param: 'remote-proof', region: 'cn' });
    assert.equal(connected.contexts().length, 1, 'only the external default context remains');
    await worker.close();
    assert.equal(connected.isConnected(), false);
    assert.equal(await original.title(), 'existing-user-tab');
    const stillAlive = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    assert.equal(stillAlive.contexts()[0].pages().length, 1);
    await stillAlive.close();
    assert.equal(await original.title(), 'existing-user-tab');
    assert.equal(externalRequests, 0);
  } finally {
    await worker?.close();
    await host?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
