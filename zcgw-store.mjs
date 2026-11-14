/**
 * zcgw-store — 数据目录的 SQLite 持久层
 *
 * 账号 / 对外密钥 / 调度参数 / 调度状态 / 接入流程 / 用量日志都落在
 * `data/zcode.sqlite`，不再整文件重写 JSON。约定（见 11-14 任务 design.md §2）：
 *   - 只用 node:sqlite 的最小 API 子集：exec / prepare().run|get|all / close
 *   - WAL + busy_timeout；运行时高频写入（用量、调度状态）synchronous=NORMAL
 *   - 账号 / 密钥 / 设置 / SSO 这类低频写入提交后 wal_checkpoint(FULL) 落盘
 *   - 所有写入在 BEGIN IMMEDIATE 事务内，先落库成功再发布内存状态
 *   - 首次启动检测到旧文件：单事务导入 + legacy_imports 清单 + 改名
 *     `<name>.migrated-<时间戳>.bak`；失败就抛错退出，绝不以空库启动
 *   - usage.jsonl 不导入、不改名、不删除（新用量进库）
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 单次写事务超过这个毫秒数就按操作名聚合上报（常量，不加 env） */
const SLOW_WRITE_MS = 50;
/** 慢写聚合窗口：同一操作名 60 秒内至多一条汇总 */
const SLOW_WINDOW_MS = 60_000;
/** 用量日志保留条数（与面板 /stats 的环形缓冲一致） */
const USAGE_KEEP = 6000;
/** 每插入多少条用量才摊销裁剪一次 */
const USAGE_TRIM_EVERY = 128;

/** 需要导入的旧文件；usage.jsonl 故意不在列表里 */
export const LEGACY_SOURCES = [
  'auth.json',
  'accounts.json',
  'pool-settings.json',
  'pool-state.json',
  'keys.json',
  'security.json',
  'onboard-flows.json',
];

const SCHEMA_MIGRATIONS = [
  `CREATE TABLE settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     data TEXT NOT NULL
   );
   CREATE TABLE auth (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     sso TEXT NOT NULL,
     session_secret TEXT NOT NULL
   );
   CREATE TABLE accounts (
     position INTEGER PRIMARY KEY,
     record TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE pool_state (
     uid TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE keys (
     id INTEGER PRIMARY KEY,
     position INTEGER NOT NULL,
     data TEXT NOT NULL
   );
   CREATE TABLE security (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     data TEXT NOT NULL
   );
   CREATE TABLE flows (
     id TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX flows_created_at ON flows (created_at);
   CREATE TABLE usage (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     t INTEGER NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX usage_t ON usage (t);
   CREATE TABLE meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   CREATE TABLE legacy_imports (
     source TEXT PRIMARY KEY,
     checksum TEXT NOT NULL,
     backup TEXT NOT NULL,
     imported_at TEXT NOT NULL,
     completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
   );`,
];

const checksumOf = (buffer) => createHash('sha256').update(buffer).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** JSON 解析失败时不带原文（原文里可能有凭证） */
function parseStoredJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`数据目录里的 ${label} 记录已损坏，请用备份恢复 data/zcode.sqlite`);
  }
}

function parseLegacyFile(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error(`旧的 ${label} 无法解析，已保留原文件；请修复后重启（不会以空库启动）`);
  }
}

export class ZcgwStore {
  constructor(directory, { readOnly = false, onSlowWrite = null, usageKeep = USAGE_KEEP } = {}) {
    this.directory = resolve(directory);
    this.file = join(this.directory, 'zcode.sqlite');
    this.readOnly = readOnly;
    this.onSlowWrite = onSlowWrite;
    this.usageKeep = usageKeep;
    this.depth = 0;
    this.usageInserts = 0;
    this.slowWindows = new Map();
    this.metricsState = { commits: 0, slow: 0, maxMs: 0, lastSlowAt: null };
    if (readOnly) {
      if (!existsSync(this.file)) throw new Error(`找不到 ${this.file}，请先启动一次网关完成初始化`);
      this.db = new DatabaseSync(this.file, { readOnly: true });
      return;
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const freshFile = !existsSync(this.file);
    this.db = new DatabaseSync(this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {}
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
    try {
      this.initialize();
      this.stateWritten = true;
      this.finishLegacyBackups();
    } catch (error) {
      // 迁移 / 导入失败：绝不留下一个"看起来能启动"的空库
      this.close();
      if (freshFile && !this.stateWritten) this.removeFiles();
      throw error;
    }
  }

  // ── 事务与观测 ──

  transaction(action, { op = 'write', sync = false } = {}) {
    if (this.depth > 0) return action();
    const started = process.hrtime.bigint();
    let committed = false;
    this.db.exec('BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const result = action();
      this.db.exec('COMMIT');
      committed = true;
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      this.depth -= 1;
      if (committed) {
        this.metricsState.commits += 1;
        this.recordWrite(op, Number(process.hrtime.bigint() - started) / 1e6);
        if (sync) this.checkpoint();
      }
    }
  }

  /** 低频写入（账号 / 密钥 / 设置 / SSO）提交后落盘 */
  checkpoint() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(FULL)');
    } catch {}
  }

  recordWrite(op, ms) {
    const state = this.metricsState;
    if (ms > state.maxMs) state.maxMs = ms;
    if (!(ms > SLOW_WRITE_MS)) return;
    state.slow += 1;
    state.lastSlowAt = new Date().toISOString();
    const now = Date.now();
    const window = this.slowWindows.get(op);
    if (window && now - window.startedAt < SLOW_WINDOW_MS) {
      window.count += 1;
      window.maxMs = Math.max(window.maxMs, ms);
      return;
    }
    // 上一个窗口已结束：先把它汇总出去，再开新窗口
    if (window) this.onSlowWrite?.(op, { count: window.count, maxMs: window.maxMs });
    this.slowWindows.set(op, { startedAt: now, count: 1, maxMs: ms });
  }

  metrics() {
    let changes = 0;
    try {
      changes = this.db.prepare('SELECT total_changes() AS c').get().c;
    } catch {}
    return {
      commits: this.metricsState.commits,
      slow: this.metricsState.slow,
      maxMs: this.metricsState.maxMs,
      lastSlowAt: this.metricsState.lastSlowAt,
      changes,
      windows: [...this.slowWindows].map(([op, window]) => ({ op, count: window.count, maxMs: window.maxMs })),
    };
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {}
    this.db = null;
  }

  removeFiles() {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${this.file}${suffix}`, { force: true });
      } catch {}
    }
  }

  // ── 初始化与旧数据导入 ──

  initialize() {
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY CHECK (version > 0), applied_at TEXT NOT NULL
      )`);
      const applied = this.db.prepare('SELECT version FROM schema_version ORDER BY version').all();
      if (applied.some((row, index) => row.version !== index + 1) || applied.length > SCHEMA_MIGRATIONS.length)
        throw new Error('data/zcode.sqlite 的 schema 版本不被支持；请用兼容版本的备份恢复');
      for (let index = applied.length; index < SCHEMA_MIGRATIONS.length; index += 1) {
        this.db.exec(SCHEMA_MIGRATIONS[index]);
        this.db.prepare('INSERT INTO schema_version VALUES (?, ?)').run(index + 1, new Date().toISOString());
      }
      if (this.db.prepare('SELECT 1 FROM auth WHERE id = 1').get()) return;
      const sources = LEGACY_SOURCES.filter((name) => existsSync(join(this.directory, name)));
      if (sources.length) {
        this.importLegacy(sources);
        return;
      }
      // 没有旧文件：全新部署允许空库；但库里有数据却没人认领，说明库被破坏了
      const claimed =
        this.db.prepare('SELECT 1 FROM legacy_imports LIMIT 1').get() ||
        this.db.prepare("SELECT 1 FROM meta WHERE key = 'accounts_initialized' LIMIT 1").get();
      if (claimed) return;
      if (this.db.prepare(`SELECT 1 FROM accounts UNION ALL SELECT 1 FROM keys UNION ALL SELECT 1 FROM settings
        UNION ALL SELECT 1 FROM security UNION ALL SELECT 1 FROM flows UNION ALL SELECT 1 FROM pool_state LIMIT 1`).get())
        throw new Error('data/zcode.sqlite 缺少设置行且没有可导入的旧文件；请用备份恢复');
    }, { op: 'initialize', sync: true });
  }

  importLegacy(sources) {
    const files = [];
    for (const name of sources) {
      const full = join(this.directory, name);
      const data = readFileSync(full);
      files.push({ name, data, checksum: checksumOf(data), json: parseLegacyFile(data, name) });
    }
    const byName = new Map(files.map((file) => [file.name, file.json]));

    if (byName.has('auth.json')) {
      const auth = byName.get('auth.json');
      if (!object(auth)) throw new Error('旧的 auth.json 格式不对（顶层应为对象）');
      if (auth.sso !== undefined && !object(auth.sso)) throw new Error('旧的 auth.json 里的 sso 格式不对');
      if (auth.sessionSecret !== undefined && typeof auth.sessionSecret !== 'string')
        throw new Error('旧的 auth.json 里的 sessionSecret 格式不对');
      this.writeAuth({ sso: auth.sso ?? {}, sessionSecret: auth.sessionSecret ?? '' });
    }

    if (byName.has('accounts.json')) {
      const accounts = byName.get('accounts.json');
      if (!Array.isArray(accounts)) throw new Error('旧的 accounts.json 格式不对（顶层应为数组）');
      for (const record of accounts) {
        if (!object(record)) throw new Error('旧的 accounts.json 里有非对象条目，已保留原文件');
      }
      this.writeAccountRecords(accounts);
      this.writeMeta('accounts_initialized', '1');
    }

    if (byName.has('pool-settings.json')) {
      const settings = byName.get('pool-settings.json');
      if (!object(settings)) throw new Error('旧的 pool-settings.json 格式不对（顶层应为对象）');
      this.writePoolSettings(settings);
    }

    if (byName.has('pool-state.json')) {
      const state = byName.get('pool-state.json');
      if (!object(state)) throw new Error('旧的 pool-state.json 格式不对（顶层应为对象）');
      if (state.accounts !== undefined && !Array.isArray(state.accounts))
        throw new Error('旧的 pool-state.json 里的 accounts 格式不对');
      this.writePoolState(Array.isArray(state.accounts) ? state.accounts : []);
    }

    if (byName.has('keys.json')) {
      const saved = byName.get('keys.json');
      if (!object(saved) || (saved.keys !== undefined && !Array.isArray(saved.keys)))
        throw new Error('旧的 keys.json 格式不对（顶层应为含 keys 数组的对象）');
      for (const key of saved.keys ?? []) {
        if (!object(key) || !Number.isInteger(key.id) || key.id <= 0)
          throw new Error('旧的 keys.json 里有缺少数字 id 的密钥，已保留原文件');
      }
      this.writeKeys({ version: 1, keys: saved.keys ?? [] });
    }

    if (byName.has('security.json')) {
      const saved = byName.get('security.json');
      if (!object(saved)) throw new Error('旧的 security.json 格式不对（顶层应为对象）');
      this.writeSecurity(saved);
    }

    if (byName.has('onboard-flows.json')) {
      const saved = byName.get('onboard-flows.json');
      if (!object(saved)) throw new Error('旧的 onboard-flows.json 格式不对（顶层应为对象）');
      this.writeFlows(new Map(Object.entries(saved)));
    }

    const importedAt = new Date().toISOString();
    const insert = this.db.prepare('INSERT INTO legacy_imports (source, checksum, backup, imported_at) VALUES (?, ?, ?, ?)');
    for (const file of files) {
      insert.run(file.name, file.checksum, `${file.name}.migrated-${Date.now()}.bak`, importedAt);
    }
  }

  /**
   * SQLite 的事务先提交，改名在之后：清单让"提交成功但还没改名"的崩溃可恢复。
   */
  finishLegacyBackups() {
    const imports = this.db.prepare('SELECT * FROM legacy_imports').all();
    for (const imported of imports) {
      if (!LEGACY_SOURCES.includes(imported.source) ||
          !new RegExp(`^${imported.source.replace('.', '\\.')}\\.migrated-\\d+\\.bak$`).test(imported.backup))
        throw new Error('legacy_imports 清单已损坏；请用备份恢复 data/zcode.sqlite');
      const source = join(this.directory, imported.source);
      const backup = join(this.directory, imported.backup);
      if (imported.completed) {
        if (existsSync(source))
          throw new Error(`旧的 ${imported.source} 在迁移完成后又出现了；请先移走再启动，避免两份数据互相覆盖`);
        continue;
      }
      if (existsSync(source)) {
        if (checksumOf(readFileSync(source)) !== imported.checksum)
          throw new Error(`旧的 ${imported.source} 在迁移期间被改动了；请先备份两份再重启`);
        if (existsSync(backup)) throw new Error(`${backup} 已存在；请先移走再重启`);
        renameSync(source, backup);
      }
      if (!existsSync(backup) || checksumOf(readFileSync(backup)) !== imported.checksum)
        throw new Error(`迁移备份 ${imported.backup} 缺失或已改变；请先恢复再重启`);
      this.transaction(() => {
        this.db.prepare('UPDATE legacy_imports SET completed = 1 WHERE source = ?').run(imported.source);
      }, { op: 'legacy-import' });
    }
    // 不静默地在两个数据源之间二选一
    for (const name of LEGACY_SOURCES) {
      if (existsSync(join(this.directory, name)) && !imports.some((entry) => entry.source === name))
        throw new Error(`data/ 里还有未导入的旧文件 ${name}，同时存在 zcode.sqlite；请先备份并移走其中一个`);
    }
  }

  // ── meta ──

  readMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  writeMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  // ── 面板登录 / SSO ──

  readAuth() {
    const row = this.db.prepare('SELECT sso, session_secret FROM auth WHERE id = 1').get();
    if (!row) return { sso: {}, sessionSecret: '' };
    return { sso: parseStoredJson(row.sso, 'auth.sso'), sessionSecret: String(row.session_secret || '') };
  }

  writeAuth({ sso, sessionSecret }) {
    this.transaction(() => {
      this.db
        .prepare(`INSERT INTO auth (id, sso, session_secret) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET sso = excluded.sso, session_secret = excluded.session_secret`)
        .run(JSON.stringify(sso ?? {}), String(sessionSecret ?? ''));
    }, { op: 'auth', sync: true });
  }

  // ── 调度参数 ──

  readPoolSettings() {
    const row = this.db.prepare('SELECT data FROM settings WHERE id = 1').get();
    return row ? parseStoredJson(row.data, 'pool-settings') : null;
  }

  writePoolSettings(settings) {
    this.transaction(() => {
      this.db
        .prepare(`INSERT INTO settings (id, data) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
        .run(JSON.stringify(settings ?? {}));
    }, { op: 'pool-settings', sync: true });
  }

  // ── 账号（配置记录，按顺序） ──

  /** 原始账号记录（顺序与 accounts.json 的数组一致） */
  readAccountRecords() {
    return this.db
      .prepare('SELECT record FROM accounts ORDER BY position')
      .all()
      .map((row) => parseStoredJson(row.record, 'accounts'));
  }

  /** 整表对齐，只写真正变化的行 */
  writeAccountRecords(records) {
    const fresh = records.length > 0 && this.readMeta('accounts_initialized') !== '1';
    this.transaction(() => {
      const existing = new Map(
        this.db.prepare('SELECT position, record FROM accounts').all().map((row) => [row.position, row.record]),
      );
      const update = this.db.prepare('UPDATE accounts SET record = ?, updated_at = ? WHERE position = ?');
      const insert = this.db.prepare('INSERT INTO accounts (position, record, updated_at) VALUES (?, ?, ?)');
      const now = new Date().toISOString();
      records.forEach((record, position) => {
        const json = JSON.stringify(record);
        if (existing.get(position) === json) {
          existing.delete(position);
          return;
        }
        if (existing.has(position)) update.run(json, now, position);
        else insert.run(position, json, now);
        existing.delete(position);
      });
      const remove = this.db.prepare('DELETE FROM accounts WHERE position = ?');
      for (const position of existing.keys()) remove.run(position);
      if (fresh) this.writeMeta('accounts_initialized', '1');
    }, { op: 'accounts', sync: true });
  }

  // ── 调度状态（冷却 / 降权 / 成功率，按 uid upsert） ──

  readPoolState() {
    const rows = this.db.prepare('SELECT data FROM pool_state').all();
    return { version: 1, accounts: rows.map((row) => parseStoredJson(row.data, 'pool-state')) };
  }

  writePoolState(rows) {
    this.transaction(() => {
      const existing = new Map(
        this.db.prepare('SELECT uid, data FROM pool_state').all().map((row) => [row.uid, row.data]),
      );
      const upsert = this.db.prepare(`INSERT INTO pool_state (uid, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(uid) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`);
      const now = new Date().toISOString();
      for (const row of rows ?? []) {
        const uid = typeof row?.uid === 'string' ? row.uid.trim() : '';
        if (!uid) continue;
        const json = JSON.stringify(row);
        if (existing.get(uid) === json) continue;
        upsert.run(uid, json, now);
      }
    }, { op: 'pool-state' });
  }

  // ── 对外密钥 ──

  readKeys() {
    const keys = this.db
      .prepare('SELECT data FROM keys ORDER BY position, id')
      .all()
      .map((row) => parseStoredJson(row.data, 'keys'));
    return { version: 1, keys };
  }

  /** 只写变化的密钥行（用量计数每请求更新，靠这个保持 O(1) 行） */
  writeKeys(db) {
    const list = Array.isArray(db?.keys) ? db.keys.filter((key) => Number.isInteger(key?.id) && key.id > 0) : [];
    this.transaction(() => {
      const existing = new Map(
        this.db.prepare('SELECT id, data FROM keys').all().map((row) => [row.id, row.data]),
      );
      const upsert = this.db.prepare(`INSERT INTO keys (id, position, data) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET position = excluded.position, data = excluded.data`);
      list.forEach((key, position) => {
        const json = JSON.stringify(key);
        if (existing.get(key.id) === json) {
          existing.delete(key.id);
          return;
        }
        upsert.run(key.id, position, json);
        existing.delete(key.id);
      });
      const remove = this.db.prepare('DELETE FROM keys WHERE id = ?');
      for (const id of existing.keys()) remove.run(id);
    }, { op: 'keys', sync: true });
  }

  // ── IP 管控 ──

  readSecurity() {
    const row = this.db.prepare('SELECT data FROM security WHERE id = 1').get();
    return row ? parseStoredJson(row.data, 'security') : null;
  }

  writeSecurity(security) {
    this.transaction(() => {
      this.db
        .prepare(`INSERT INTO security (id, data) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
        .run(JSON.stringify(security ?? {}));
    }, { op: 'security', sync: true });
  }

  // ── 登录授权流程 ──

  /** 只返回 createdAt 晚于 cut 的流程（与旧 readFlows 的 20 分钟过期一致） */
  readFlows(cut = 0) {
    const rows = this.db.prepare('SELECT id, data FROM flows WHERE created_at > ?').all(Number(cut) || 0);
    return new Map(rows.map((row) => [row.id, parseStoredJson(row.data, 'onboard-flows')]));
  }

  writeFlows(flows) {
    const entries = flows instanceof Map ? [...flows] : Object.entries(flows ?? {});
    this.transaction(() => {
      const existing = new Map(
        this.db.prepare('SELECT id, data FROM flows').all().map((row) => [row.id, row.data]),
      );
      const upsert = this.db.prepare(`INSERT INTO flows (id, data, created_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`);
      for (const [id, flow] of entries) {
        const json = JSON.stringify(flow ?? {});
        if (existing.get(id) === json) {
          existing.delete(id);
          continue;
        }
        upsert.run(id, json, Number(flow?.createdAt) || Date.now());
        existing.delete(id);
      }
      const remove = this.db.prepare('DELETE FROM flows WHERE id = ?');
      for (const id of existing.keys()) remove.run(id);
    }, { op: 'flows', sync: true });
  }

  // ── 用量日志（只追加，按条数摊销裁剪） ──

  /** 最近 limit 条用量记录，按时间升序 */
  readUsage(limit = this.usageKeep) {
    const rows = this.db
      .prepare('SELECT data FROM usage ORDER BY seq DESC LIMIT ?')
      .all(Number(limit) || this.usageKeep);
    return rows.reverse().map((row) => parseStoredJson(row.data, 'usage'));
  }

  appendUsage(record) {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO usage (t, data) VALUES (?, ?)')
        .run(Number(record?.t) || Date.now(), JSON.stringify(record ?? {}));
      this.usageInserts += 1;
      if (this.usageInserts % USAGE_TRIM_EVERY === 0) {
        this.db.prepare('DELETE FROM usage WHERE seq <= (SELECT MAX(seq) FROM usage) - ?').run(this.usageKeep);
      }
    }, { op: 'usage' });
  }
}
