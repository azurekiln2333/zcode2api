import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLIENT_APP_VERSION, createVersionManager, latestFromChangelog, normalizeVersion } from '../zcgw-version.mjs';

test('release extraction ignores unrelated version strings and compares numbers', () => {
  assert.equal(latestFromChangelog('Chromium 999.0.0 <h2>Release v3.9.9</h2><a href="/releases/3.18.2/a">file</a> Release v3.17.2'), '3.18.2');
  assert.equal(latestFromChangelog('Electron 99.1.2'), null);
  assert.equal(normalizeVersion(' 03.017.2.1 '), '3.17.2');
  assert.equal(normalizeVersion('garbage'), null);
});

test('version refresh persists upgrades, protects against downgrade and shares concurrent lookups', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-version-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let calls = 0;
  const manager = createVersionManager({ dataDir, url: 'https://example.invalid/changelog', configuredVersion: '3.16.3',
    fetchImpl: async () => { calls++; return new Response('Release v3.18.2'); } });
  assert.equal(manager.reported(), CLIENT_APP_VERSION);
  const states = await Promise.all([manager.ensureFresh(), manager.ensureFresh()]);
  assert.equal(calls, 1);
  assert.ok(states.every((s) => s.reported === '3.18.2'));
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'zcode-version-cache.json'))).version, '3.18.2');
  const restarted = createVersionManager({ dataDir, url: '', configuredVersion: '3.17.0', fetchImpl: () => { throw new Error('should not fetch'); } });
  assert.equal((await restarted.ensureFresh()).reported, '3.18.2');
  const configured = createVersionManager({ dataDir, url: '', configuredVersion: '3.19.0' });
  assert.equal(configured.reported(), '3.19.0');
});

test('failed version lookup is throttled and stale cache refresh does not block account operations', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-version-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = Date.now(), calls = 0, mode = 'fail', release;
  const manager = createVersionManager({ dataDir, url: '', now: () => now, fetchImpl: async () => {
    calls++;
    if (mode === 'fail') throw new Error('network');
    if (mode === 'deferred') return new Promise((resolve) => { release = resolve; });
    return new Response('Release v3.18.2');
  } });
  assert.match((await manager.ensureFresh()).error, /本地已知版本/);
  await manager.ensureFresh();
  assert.equal(calls, 1);
  now += 61_000; mode = 'success';
  assert.equal((await manager.ensureFresh()).reported, '3.18.2');
  now += 7 * 3600_000; mode = 'deferred';
  assert.equal((await manager.ensureFresh()).reported, '3.18.2');
  assert.equal((await manager.ensureFresh()).stale, true);
  assert.equal(calls, 3);
  release(new Response('Release v3.17.2'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.snapshot().stale, false);
  assert.equal(manager.reported(), '3.18.2', 'known version never decreases');
});
