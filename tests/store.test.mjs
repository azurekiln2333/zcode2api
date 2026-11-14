import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { ZcgwStore } from '../zcgw-store.mjs';

const jwt = (id) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ user_id: id })).toString('base64url')}.test`;

const tempDir = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zcgw-store-'));
  const opened = [];
  // 单个 after 钩子：先关连接再删目录（Windows 上顺序反了会 EPERM）
  t.after(() => {
    for (const store of opened) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    open: (options) => {
      const store = new ZcgwStore(dir, options);
      opened.push(store);
      return store;
    },
  };
};

const writeLegacy = (dir, name, value) =>
  writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));

const legacyFixture = (dir) => {
  writeLegacy(dir, 'accounts.json', [
    { label: 'one', jwt: jwt('one'), realm: 'cn', zaiAccessToken: 'token-one' },
    { label: 'two', jwt: jwt('two'), realm: 'intl', weight: 3, disabled: true },
  ]);
  writeLegacy(dir, 'pool-settings.json', { maxInFlight: 7, topN: 2 });
  writeLegacy(dir, 'pool-state.json', { version: 1, accounts: [{ uid: 'one', cooldownUntil: 123, successCount: 4 }] });
  writeLegacy(dir, 'keys.json', { version: 1, keys: [{ id: 1, name: 'k1', hash: 'h1', usedTokens: 5, requests: 2 }] });
  writeLegacy(dir, 'security.json', { enabled: true, mode: 'whitelist', rules: [{ type: 'allow', cidr: '10.0.0.0/8' }], blockedLog: [] });
  writeLegacy(dir, 'onboard-flows.json', { flow1: { pollToken: 'p', createdAt: Date.now(), provider: 'zai' } });
  writeLegacy(dir, 'auth.json', { sso: { enabled: false, providerName: 'Legacy' }, sessionSecret: 's'.repeat(40) });
  writeLegacy(dir, 'usage.jsonl', '{"t":1,"ok":true}\n');
};

const backups = (dir) => readdirSync(dir).filter((name) => name.endsWith('.bak')).sort();

test('legacy files are imported once, renamed to .bak, and usage.jsonl is left alone', (t) => {
  const { dir, open } = tempDir(t);
  legacyFixture(dir);
  const usageBefore = readFileSync(path.join(dir, 'usage.jsonl'), 'utf8');

  const store = open();

  assert.deepEqual(store.readAccountRecords().map((a) => a.label), ['one', 'two']);
  assert.equal(store.readAccountRecords()[1].weight, 3);
  assert.deepEqual(store.readPoolSettings(), { maxInFlight: 7, topN: 2 });
  assert.deepEqual(store.readPoolState().accounts, [{ uid: 'one', cooldownUntil: 123, successCount: 4 }]);
  assert.deepEqual(store.readKeys().keys.map((k) => [k.id, k.usedTokens]), [[1, 5]]);
  assert.equal(store.readSecurity().mode, 'whitelist');
  assert.deepEqual([...store.readFlows(0).keys()], ['flow1']);
  assert.equal(store.readAuth().sso.providerName, 'Legacy');
  assert.equal(store.readAuth().sessionSecret, 's'.repeat(40));

  // 旧日志不导入、不改名、不删除
  assert.equal(store.readUsage().length, 0);
  assert.equal(readFileSync(path.join(dir, 'usage.jsonl'), 'utf8'), usageBefore);
  const names = backups(dir);
  assert.equal(names.length, 7);
  for (const source of ['accounts.json', 'auth.json', 'keys.json', 'onboard-flows.json', 'pool-settings.json', 'pool-state.json', 'security.json'])
    assert.ok(names.some((name) => name.startsWith(`${source}.migrated-`) && name.endsWith('.bak')), `${source} backup`);
  for (const name of ['accounts.json', 'auth.json', 'keys.json', 'pool-settings.json', 'pool-state.json', 'security.json', 'onboard-flows.json'])
    assert.equal(existsSync(path.join(dir, name)), false, `${name} should be renamed away`);
});

test('a restart reuses the database and never reimports', (t) => {
  const { dir, open } = tempDir(t);
  legacyFixture(dir);
  const first = open();
  first.writeAccountRecords([{ label: 'edited', jwt: jwt('edited') }]);
  first.close();

  const second = open();
  assert.deepEqual(second.readAccountRecords().map((a) => a.label), ['edited']);
  assert.equal(backups(dir).length, 7, 'no second round of backups');
});

test('a crash between commit and rename is recovered from the manifest', (t) => {
  const { dir, open } = tempDir(t);
  legacyFixture(dir);
  const first = open();
  first.close();

  // 模拟"事务已提交、改名还没做"：把备份改回原名，并把清单标记回未完成
  const backup = backups(dir).find((name) => name.startsWith('accounts.json.'));
  renameSync(path.join(dir, backup), path.join(dir, 'accounts.json'));
  const db = new DatabaseSync(path.join(dir, 'zcode.sqlite'));
  db.prepare("UPDATE legacy_imports SET completed = 0 WHERE source = 'accounts.json'").run();
  db.close();

  const second = open();
  assert.equal(existsSync(path.join(dir, 'accounts.json')), false, 'the leftover file is renamed again');
  assert.equal(second.readAccountRecords().length, 2, 'the imported rows are not duplicated');
  const check = new DatabaseSync(path.join(dir, 'zcode.sqlite'), { readOnly: true });
  const row = check.prepare("SELECT completed FROM legacy_imports WHERE source = 'accounts.json'").get();
  check.close();
  assert.equal(row.completed, 1);
});

test('a corrupt legacy file aborts startup and leaves no empty database', (t) => {
  const { dir } = tempDir(t);
  writeLegacy(dir, 'accounts.json', '{not json');
  assert.throws(() => new ZcgwStore(dir), /accounts\.json/);
  assert.equal(existsSync(path.join(dir, 'zcode.sqlite')), false, 'no half-initialised database is left behind');
  assert.equal(readFileSync(path.join(dir, 'accounts.json'), 'utf8'), '{not json', 'the legacy file is untouched');
});

test('legacy files that reappear beside the database are refused', (t) => {
  const { dir, open } = tempDir(t);
  legacyFixture(dir);
  const first = open();
  first.close();
  writeLegacy(dir, 'keys.json', { version: 1, keys: [] });
  assert.throws(() => new ZcgwStore(dir), /旧的 keys\.json 在迁移完成后又出现了/);
});

test('a failed write throws and leaves the stored rows unchanged', (t) => {
  const { dir, open } = tempDir(t);
  const store = open();
  store.writeAccountRecords([{ label: 'one', jwt: jwt('one') }]);
  store.close();
  assert.throws(() => store.writeAccountRecords([{ label: 'two', jwt: jwt('two') }]));

  const reopened = open();
  assert.deepEqual(reopened.readAccountRecords().map((a) => a.label), ['one']);
});

test('account writes touch only the changed rows', (t) => {
  const { open } = tempDir(t);
  const store = open();
  const records = Array.from({ length: 5 }, (_, index) => ({ label: `a${index}`, jwt: jwt(`a${index}`) }));
  store.writeAccountRecords(records);

  const before = store.metrics().changes;
  records[2].weight = 9;
  store.writeAccountRecords(records);
  assert.equal(store.metrics().changes - before, 1, 'only the edited account row is rewritten');

  const usageBefore = store.metrics().changes;
  store.appendUsage({ t: Date.now(), ok: true });
  assert.equal(store.metrics().changes - usageBefore, 1, 'one usage record is one inserted row');
});

test('usage rows are trimmed to the retention limit', (t) => {
  const { open } = tempDir(t);
  const store = open({ usageKeep: 5 });
  for (let index = 0; index < 200; index += 1) store.appendUsage({ t: 1000 + index, ok: true });
  const kept = store.readUsage();
  assert.ok(kept.length <= 5, `kept ${kept.length} rows`);
  assert.equal(kept.at(-1).t, 1199, 'the newest record survives');
});

test('slow writes are aggregated per operation instead of logged per write', (t) => {
  const { open } = tempDir(t);
  const reports = [];
  const store = open({ onSlowWrite: (op, info) => reports.push({ op, ...info }) });
  // 直接驱动观测逻辑：真实写事务在测试机上通常远低于 50ms
  store.recordWrite('accounts', 80);
  store.recordWrite('accounts', 120);
  store.recordWrite('accounts', 60);
  assert.deepEqual(reports, [], 'the window is still open, nothing is emitted yet');
  store.slowWindows.get('accounts').startedAt -= 61_000;
  store.recordWrite('accounts', 70);
  assert.deepEqual(reports, [{ op: 'accounts', count: 3, maxMs: 120 }]);
  assert.equal(store.metrics().slow, 4);
  assert.equal(store.metrics().maxMs, 120);
});
