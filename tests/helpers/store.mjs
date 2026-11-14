// 测试侧直接读 data/zcode.sqlite：网关进程持有连接时用独立只读连接观测落库结果。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const open = (dataDir, options) => new DatabaseSync(join(dataDir, 'zcode.sqlite'), options);

const withDatabase = (dataDir, options, action) => {
  const db = open(dataDir, options);
  try {
    return action(db);
  } finally {
    db.close();
  }
};

/** 账号配置记录（顺序与面板顺序一致） */
export function readAccountRecords(dataDir) {
  return withDatabase(dataDir, { readOnly: true }, (db) =>
    db
      .prepare('SELECT record FROM accounts ORDER BY position')
      .all()
      .map((row) => JSON.parse(row.record)));
}

/** 覆盖账号表，用于模拟"运行期间账号被外部删掉/改掉" */
export function writeAccountRecords(dataDir, records) {
  withDatabase(dataDir, {}, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM accounts');
      const insert = db.prepare('INSERT INTO accounts (position, record, updated_at) VALUES (?, ?, ?)');
      records.forEach((record, position) => insert.run(position, JSON.stringify(record), new Date().toISOString()));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

export function readAuth(dataDir) {
  return withDatabase(dataDir, { readOnly: true }, (db) => {
    const row = db.prepare('SELECT sso, session_secret FROM auth WHERE id = 1').get();
    if (!row) return { sso: {}, sessionSecret: '' };
    return { sso: JSON.parse(row.sso), sessionSecret: String(row.session_secret || '') };
  });
}

export function writeAuth(dataDir, { sso, sessionSecret }) {
  withDatabase(dataDir, {}, (db) => {
    db.prepare(`INSERT INTO auth (id, sso, session_secret) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sso = excluded.sso, session_secret = excluded.session_secret`)
      .run(JSON.stringify(sso ?? {}), String(sessionSecret ?? ''));
  });
}
