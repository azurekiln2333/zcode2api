#!/usr/bin/env node
/**
 * zcgw-server — 多账号版 ZCode → Anthropic 反代（服务器部署版）
 *
 * 与本地单账号版 (server.mjs) 的区别：
 *   - 不读 ~/.zcode/v2/credentials.json，改读 ./accounts.json（明文 JWT 数组）或 vault/ 加密库
 *   - 自动多账号轮询：3012/1005 时换下一个号重试
 *   - 对外要求 Authorization: Bearer <GATEWAY_KEY>
 *
 * 部署：
 *   accounts.json: [{ "label": "acc1", "jwt": "eyJ..." }, ...]
 *   GATEWAY_KEY=xxx PORT=8787 node zcgw-server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeBilling, normalizeCoding } from './zcgw-quota.mjs';
import { metadataUserId, sessionIdFor, requestId, userIdFromJwt, deviceIdFor } from './zcgw-fingerprint.mjs';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';
// 面板访问控制：设置 PANEL_KEY 后，除 /health、/v1/*、登录接口外的所有请求都要带会话 cookie。
// 不设置则完全不拦截（本机/内网模式），不影响现有部署。
const PANEL_KEY = process.env.PANEL_KEY || '';
const PANEL_COOKIE = 'zcgw_panel';
const PANEL_TTL_MS = 7 * 86400_000;

function panelSign(expiresAt) {
  return crypto.createHmac('sha256', PANEL_KEY).update(`zcgw-panel:${expiresAt}`).digest('base64url');
}

function panelAuthed(req) {
  if (!PANEL_KEY) return true;
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${PANEL_COOKIE}=([A-Za-z0-9._-]+)`));
  if (!m) return false;
  const [expStr, sig] = m[1].split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(panelSign(exp)));
  } catch {
    return false;
  }
}
const UPSTREAM_ORIGIN = process.env.ZCODE_UPSTREAM_ORIGIN || 'https://zcode.z.ai';
const UPSTREAM_URL = `${UPSTREAM_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`;
const APP_VERSION = process.env.ZCODE_APP_VERSION || '3.16.3';
const DEFAULT_MODEL = process.env.ZCODE_MODEL || 'GLM-5.3-Flash';
const VERBOSE = process.env.ZCGW_VERBOSE === '1';
const PROFILE_FILE = path.join(import.meta.dirname, 'zcode-profile.json');
// 数据文件目录：Docker 里指向挂载卷 /app/data，本机默认与程序同目录
const DATA_DIR = process.env.ZCGW_DATA_DIR || import.meta.dirname;

const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
const GATEWAY_VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const SESSION_ID = `session_${crypto.randomBytes(16).toString('hex')}`;

/** 把 plan_id / plan 名译成中文意图（活动包 / 每日免费 / 付费套餐） */
function describePlan(id, name) {
  const s = `${id || ''} ${name || ''}`.toUpperCase();
  if (s.includes('WEEKEND') || /(^|[-_ ])WK($|[-_ ])/.test(s)) {
    return { kind: 'promo', kindZh: '臭鸡蛋', nameZh: 'Weekend Build' };
  }
  if (s.includes('OFF-PEAK') || s.includes('OFFPEAK')) {
    return { kind: 'offpeak', kindZh: '夜间不限量', nameZh: '夜间免费 (Off-Peak)' };
  }
  if (s.includes('START-PLAN') || s.includes('START PLAN')) {
    return { kind: 'daily', kindZh: '注册礼包', nameZh: '新号体验包 (Start Plan · 4天)' };
  }
  if (s.includes('CODING-PLAN') || s.includes('CODING PLAN')) {
    return { kind: 'paid', kindZh: '付费套餐', nameZh: '编程套餐 (Coding Plan)' };
  }
  return { kind: 'other', kindZh: '其他', nameZh: name || id || '未知' };
}

/** 账号归属：国内 / 国际（按登录身份判断，可由 accounts.json 的 realm 覆盖） */
function realmFromIdentity(email) {
  const e = String(email || '').trim();
  if (!e) return 'unknown';
  if (/@phone\.local$/i.test(e)) return 'cn';
  if (/^1\d{10}$/.test(e)) return 'cn';
  if (e.includes('@')) return 'intl';
  return 'unknown';
}

function detectRealm(jwt, hint, email) {
  if (hint === 'cn' || hint === 'intl') return hint;
  const byEmail = realmFromIdentity(email);
  if (byEmail !== 'unknown') return byEmail;
  // JWT 里没有 email（只有 user_id），这里只能当兑底
  try {
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    const byJwt = realmFromIdentity(p.email);
    if (byJwt !== 'unknown') return byJwt;
  } catch {}
  return 'unknown';
}

/** 身份展示：手机号（服务端已打码）优先，其次真邮箱；未知返回 null */
function displayIdentity(account) {
  const email = String(account.email || '').trim();
  const phone = String(account.phone || '').trim();
  // 真邮箱（国际号）优先；@phone.local 是国产手机号的内部占位，不当邮箱用
  if (email && !/@phone\.local$/i.test(email)) return email;
  if (phone) return phone;
  const raw = email.replace(/@phone\.local$/i, '');
  if (/^1\d{10}$/.test(raw)) return `${raw.slice(0, 3)}****${raw.slice(-4)}`;
  return raw || null;
}

const REALM_ZH = { cn: '国内', intl: '国际', unknown: '未标注' };

/** 安全 JSON：空响应 / 非 JSON 不抛异常（否则一个坏响应就能把进程打死） */
async function safeJson(r) {
  const text = await r.text();
  if (!text) return { __error: 'empty body', __status: r.status };
  try {
    return JSON.parse(text);
  } catch {
    return { __error: text.slice(0, 200), __status: r.status };
  }
}

// ── 账号加载 ──
const ACC_FILE = path.join(DATA_DIR, 'accounts.json');

// ── 官方身份接口（客户端 OEM 的 zai adapter 同款端点）──
// 关键：这个接口认的是 OAuth access_token，不是 zcodejwttoken。
// 返回值带 email / phoneNumber(已打码) / countryCode，正好用来判国内 vs 国际。
const ZAI_ORIGIN = process.env.ZCODE_ZAI_ORIGIN || 'https://api.z.ai';
const CUSTOMERINFO_URL = `${ZAI_ORIGIN}/api/biz/customer/getCustomerInfo`;

async function fetchCustomerInfo(accessToken) {
  if (!accessToken) return null;
  try {
    const r = await fetch(CUSTOMERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    const j = await safeJson(r);
    // 这个接口的成功码是 200（不是 0），且外层有 success 字段
    if (j.code !== 200 || !j.data) return null;
    return j.data;
  } catch {
    return null;
  }
}

/** 从官方客户档案判断归属：有邮箱=国际，有手机号=国内，countryCode 兜底 */
function realmFromCustomer(d) {
  if (!d) return 'unknown';
  const email = String(d.email || '').trim();
  const phone = String(d.phoneNumber || '').trim();
  if (email) return 'intl';
  if (phone) return 'cn';
  if (String(d.countryCode || '') === '+86') return 'cn';
  return 'unknown';
}

/** 把一次 customerInfo 结果合并回 accounts.json 的记录；有变更返回 true */
function mergeCustomerInfo(rec, d) {
  if (!d) return false;
  let changed = false;
  const email = String(d.email || '').trim();
  const phone = String(d.phoneNumber || '').trim();
  const realm = realmFromCustomer(d);
  const nick = String(d.nickName || d.customerName || '').trim();

  // 手机号账号的 email 是空的：把历史的 xxx@phone.local 占位清掉，改用真实打码手机号
  if (phone && rec.phone !== phone) { rec.phone = phone; changed = true; }
  if (phone && rec.email && /@phone\.local$/i.test(rec.email)) { rec.email = null; changed = true; }
  if (email && rec.email !== email) { rec.email = email; changed = true; }
  if (realm !== 'unknown' && rec.realm !== realm) { rec.realm = realm; changed = true; }
  if (d.countryCode && rec.countryCode !== d.countryCode) { rec.countryCode = d.countryCode; changed = true; }
  if (nick && !rec.name) { rec.name = nick; changed = true; }
  return changed;
}

/** 读本地 ZCode 客户端的 oauth:zai:access_token（当前登录号才有） */
function localAccessToken() {
  try {
    const f = path.join(zcodeDir(), 'credentials.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const at = decryptCredential(raw['oauth:zai:access_token'] ?? '').trim();
    const jwt = decryptCredential(raw['zcodejwttoken'] ?? '').trim();
    if (!at.startsWith('eyJ') || !jwt.startsWith('eyJ')) return null;
    return { accessToken: at, uid: userIdFromJwt(jwt) };
  } catch {
    return null;
  }
}

/** 启动时把本地客户端的 access_token 补给对应账号（免重新登录） */
function seedLocalAccessToken() {
  try {
    const local = localAccessToken();
    if (!local) return 0;
    const arr = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8'));
    let n = 0;
    for (const a of arr) {
      if (userIdFromJwt(a.jwt) === local.uid && !a.zaiAccessToken) {
        a.zaiAccessToken = local.accessToken;
        n += 1;
      }
    }
    if (n) fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
    return n;
  } catch {
    return 0;
  }
}

/** 对所有带 access_token 的账号刷一遍真实身份（不调会报错，只吞异常） */
let lastIdentifyAt = 0;
async function identifyAll(force = false) {
  if (!force && Date.now() - lastIdentifyAt < 5 * 60_000) return { updated: 0, skipped: true };
  lastIdentifyAt = Date.now();
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8'));
  } catch {
    return { updated: 0, total: 0, withToken: 0 };
  }
  let updated = 0;
  for (const rec of arr) {
    if (!rec.zaiAccessToken) continue;
    const d = await fetchCustomerInfo(rec.zaiAccessToken);
    if (d && mergeCustomerInfo(rec, d)) updated += 1;
  }
  if (updated) {
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
    accounts = readAccountFile();
    log(`自动识别账号身份：更新 ${updated} 个`);
  }
  return { updated, total: arr.length, withToken: arr.filter((a) => a.zaiAccessToken).length };
}

/** 解本地 ZCode 客户端的加密凭证（单账号回退模式用） */
function credentialSecret() {
  if (process.env.ZCODE_CREDENTIAL_SECRET) return process.env.ZCODE_CREDENTIAL_SECRET;
  let user = 'unknown';
  try {
    user = os.userInfo().username;
  } catch {}
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${user}`;
}

function zcodeDir() {
  return process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode', 'v2');
}

function decryptCredential(value) {
  const PREFIX = 'enc:v1:';
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  const parts = value.slice(PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('unsupported ciphertext');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
  const key = crypto.createHash('sha256').update(credentialSecret()).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** 读本地 ZCode 登录态里的 JWT；读不到返回 null */
function localJwt() {
  try {
    const f = path.join(zcodeDir(), 'credentials.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return decryptCredential(raw['zcodejwttoken'] ?? '').trim() || null;
  } catch {
    return null;
  }
}

function loadAccounts() {
  // 优先用 accounts.json；没有就回退到本地 ZCode 客户端凭证（单账号模式）
  if (fs.existsSync(ACC_FILE)) return readAccountFile();

  const jwt = localJwt();
  if (!jwt) {
    // 空池不能退出：面板必须先起来，用户才能用「登录新账号」按钮纳管账号，
    // 否则容器 crash loop，永远进不了面板（先有鸡还是先有蛋）
    console.error('既没有 accounts.json，也没有本地 ZCode 登录态 —— 以空账号池启动。');
    console.error('请打开面板点「登录新账号」纳管账号，或在 data/ 放一个 accounts.json 后重启。');
    return [];
  }
  log('未找到 accounts.json，使用本地 ZCode 客户端凭证（单账号模式）');
  const uid = userIdFromJwt(jwt);
  return [
    {
      label: `local-${uid.slice(0, 8)}`,
      jwt,
      uid,
      local: true, // 每次请求重读客户端凭证，客户端刷新 token 后自动跟上
      deviceId: deviceIdFor(uid),
      sessionId: sessionIdFor(uid),
      cooldownUntil: 0,
      failures: 0,
      consecutiveFails: 0,
      inFlight: 0,
      degradeUntil: 0,
      lastSuccess: null,
      lastErr: null,
    },
  ];
}

function readAccountFile() {
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8'));
  } catch (e) {
    console.error(`accounts.json 读取/解析失败（${e.message}）—— 以空账号池启动，请修复该文件后重启。`);
    return [];
  }
  if (!Array.isArray(arr)) {
    console.error('accounts.json 格式不对（顶层应为数组）—— 以空账号池启动。');
    return [];
  }
  return arr
    .filter((a) => a.jwt?.startsWith('eyJ'))
    .map((a) => {
      const uid = userIdFromJwt(a.jwt);
      const realm = detectRealm(a.jwt, a.realm, a.email);
      return {
        label: a.label || (uid ?? a.jwt.slice(20, 28)),
        jwt: a.jwt,
        uid,
        email: a.email || null,
        phone: a.phone || null,
        countryCode: a.countryCode || null,
        name: a.name || null,
        realm,
        realmZh: REALM_ZH[realm],
        identity: displayIdentity({ email: a.email, phone: a.phone, realm }),
        hasAccessToken: !!a.zaiAccessToken,
        zaiAccessToken: a.zaiAccessToken || null,
        codingPlanApiKey: a.codingPlanApiKey || null,
        codingPlanProvider: a.codingPlanProvider || (realm === 'cn' ? 'bigmodel' : 'zai'),
        weight: Number(a.weight) || 1,
        disabled: !!a.disabled, // 手动停用：不参与调度（区别于 weight=0 的软暂停）
        // 指纹按账号派生：同号恒定、跨号隔离（见 zcgw-fingerprint.mjs）
        deviceId: a.deviceId || deviceIdFor(uid),
        sessionId: sessionIdFor(uid),
        cooldownUntil: 0,
        failures: 0,
        consecutiveFails: 0,
        inFlight: 0,
        degradeUntil: 0,
        lastSuccess: null,
        lastErr: null,
      };
    });
}

/** 把新账号写回 accounts.json（保留已有账号） */
function persistAccount(jwt, label, extra = {}) {
  const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')) : [];
  const uid = userIdFromJwt(jwt);
  const email = extra.email || null;
  const realm = extra.realm || detectRealm(jwt, null, email);
  const accessToken = extra.accessToken || null;
  const existing = arr.find((a) => userIdFromJwt(a.jwt) === uid);
  if (existing) {
    if (email) existing.email = email;
    if (extra.name) existing.name = extra.name;
    if (extra.phone) existing.phone = extra.phone;
    if (accessToken) existing.zaiAccessToken = accessToken;
    if (realm !== 'unknown') existing.realm = realm;
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
    return { added: false, label: existing.label };
  }
  arr.push({
    label,
    jwt,
    email,
    name: extra.name || null,
    realm,
    ...(accessToken ? { zaiAccessToken: accessToken } : {}),
  });
  fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
  return { added: true, label };
}

let accounts = loadAccounts();

// ── 调度参数：环境变量为默认值，面板可在线改（持久化到 pool-settings.json）──
const SETTINGS_FILE = path.join(DATA_DIR, 'pool-settings.json');

// 调度设置的可调范围（面板表单校验用）
const POOL_LIMITS = {
  maxInFlight: [1, 20],
  breakerThreshold: [2, 10],
  breakerCooldownMin: [5, 360],
  blockedCooldownMin: [1, 120],
  quotaCooldownMin: [5, 360],
  busyCooldownSec: [10, 900],
  stickyTtlMin: [1, 240],
  topN: [1, 10],
  idleWeightPerHour: [0, 5],
  idleWeightMax: [0, 20],
  minPickGapMs: [0, 2000],
  weightBalFactor: [0, 20],
  weightSuccFactor: [0, 10],
};

const POOL_DEFAULTS = {
  maxInFlight: 5,
  breakerThreshold: 3,
  breakerCooldownMin: 30,
  blockedCooldownMin: 10,
  quotaCooldownMin: 30,
  busyCooldownSec: 90,
  stickyTtlMin: 30,
  topN: 3,
  idleWeightPerHour: 0.5,
  idleWeightMax: 5,
  minPickGapMs: 120,
  weightBalFactor: 10,
  weightSuccFactor: 3,
};

function clamp(v, [lo, hi]) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function readSettings() {
  const env = {
    maxInFlight: process.env.ZCGW_MAX_INFLIGHT,
    breakerThreshold: process.env.ZCGW_BREAKER_THRESHOLD,
    breakerCooldownMin: process.env.ZCGW_BREAKER_COOLDOWN_MS ? Number(process.env.ZCGW_BREAKER_COOLDOWN_MS) / 60000 : undefined,
    blockedCooldownMin: process.env.ZCGW_BLOCKED_COOLDOWN_MS ? Number(process.env.ZCGW_BLOCKED_COOLDOWN_MS) / 60000 : undefined,
    quotaCooldownMin: process.env.ZCGW_QUOTA_COOLDOWN_MS ? Number(process.env.ZCGW_QUOTA_COOLDOWN_MS) / 60000 : undefined,
    busyCooldownSec: process.env.ZCGW_BUSY_COOLDOWN_MS ? Number(process.env.ZCGW_BUSY_COOLDOWN_MS) / 1000 : undefined,
    stickyTtlMin: process.env.ZCGW_STICKY_TTL_MS ? Number(process.env.ZCGW_STICKY_TTL_MS) / 60000 : undefined,
    topN: process.env.ZCGW_TOPN,
  };
  const out = { ...POOL_DEFAULTS };
  for (const k of Object.keys(POOL_DEFAULTS)) {
    if (env[k] !== undefined && env[k] !== '') out[k] = clamp(env[k], POOL_LIMITS[k]);
  }
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    for (const k of Object.keys(POOL_DEFAULTS)) {
      if (saved[k] !== undefined) out[k] = clamp(saved[k], POOL_LIMITS[k]);
    }
    out.__fromFile = true;
  } catch {}
  return out;
}

const POOL = readSettings();
const STATE_FILE = path.join(DATA_DIR, 'pool-state.json');

function applyPoolSettings(body) {
  const applied = {};
  for (const k of Object.keys(POOL_DEFAULTS)) {
    if (body[k] === undefined) continue;
    const v = clamp(body[k], POOL_LIMITS[k]);
    POOL[k] = v;
    applied[k] = v;
  }
  try {
    const cur = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...cur, ...applied }, null, 2));
  } catch {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(applied, null, 2));
  }
  log('调度参数已更新:', JSON.stringify(applied));
  return applied;
}

/** sessionKey -> {label, expireAt}。目的：让同一会话尽量落在同一号上，保住 prompt cache */
const sticky = new Map();
const lastPickAt = new Map(); // label -> ts，防惊群窗口
let lastPick = null; // 上一次抽中的号（同进程内防连击）

// ── 调度状态持久化：重启不丢冷却/降权/统计 ──
function savePoolState() {
  try {
    const data = {
      version: 1,
      savedAt: Date.now(),
      accounts: accounts.map((a) => ({
        uid: a.uid,
        cooldownUntil: a.cooldownUntil || 0,
        degradeUntil: a.degradeUntil || 0,
        consecutiveFails: a.consecutiveFails || 0,
        failures: a.failures || 0,
        successCount: a.successCount || 0,
        errTotal: a.errTotal || 0,
        lastSuccess: a.lastSuccess || null,
        lastUsedAt: a.lastUsedAt || 0,
      })),
    };
    fs.writeFileSync(POOL.stateFile, JSON.stringify(data));
  } catch {}
}

function loadPoolState() {
  try {
    const data = JSON.parse(fs.readFileSync(POOL.stateFile, 'utf8'));
    let n = 0;
    for (const a of accounts) {
      const s = data.accounts?.find((x) => x.uid === a.uid);
      if (!s) continue;
      // 冷却已过期的直接丢弃，防止带着旧冷却启动
      a.cooldownUntil = s.cooldownUntil > Date.now() ? s.cooldownUntil : 0;
      a.degradeUntil = s.degradeUntil > Date.now() ? s.degradeUntil : 0;
      a.consecutiveFails = s.consecutiveFails || 0;
      a.failures = s.failures || 0;
      a.successCount = s.successCount || 0;
      a.errTotal = s.errTotal || 0;
      a.lastSuccess = s.lastSuccess || null;
      a.lastUsedAt = s.lastUsedAt || 0;
      n++;
    }
    if (n) log(`已恢复账号池调度状态 ${n} 个（pool-state.json）`);
  } catch {}
}
const persistState = debounce(savePoolState, 2000);
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function stickyGet(key) {
  if (!key) return null;
  const hit = sticky.get(key);
  if (!hit) return null;
  if (hit.expireAt <= Date.now()) {
    sticky.delete(key);
    return null;
  }
  return hit.label;
}

/** 每次命中都滚动续期（参考 workbuddy2api TTL 滚动） */
function stickySet(key, label) {
  if (!key) return;
  sticky.set(key, { label, expireAt: Date.now() + POOL.stickyTtlMs });
  if (sticky.size > 2000) {
    const now = Date.now();
    for (const [k, v] of sticky) if (v.expireAt <= now) sticky.delete(k);
  }
}

function stickyUnbind(key) {
  if (key) sticky.delete(key);
}

/**
 * 加权随机选号（参考 workbuddy2api 三因子 + Top-N + 防惊群）：
 *   weight = 余额占比 ×10 + 闲置补偿 + 成功率 ×3
 * 余额来自最近一次 /quota 的缓存（quotaCache），没有就用中性值。
 */
let quotaCache = new Map(); // Billing totals for scheduling only; UI uses separate sources.
const quotaSources = new Map();
const eligibilityCache = new Map();
const accountRefreshes = new Map();
function setQuotaCache(list) {
  for (const a of list) {
    if (!a.label || a.error) continue;
    const rem = (a.balances ?? []).reduce((s, b) => s + (b.remaining || 0), 0);
    const tot = (a.balances ?? []).reduce((s, b) => s + (b.total || 0), 0);
    quotaCache.set(a.label, { remaining: rem, total: tot, plans: a.plans || [], balances: a.balances || [], ts: Date.now() });
  }
}

function weightOf(acc, maxRemaining, now) {
  const qc = quotaCache.get(acc.label);
  const remaining = qc?.remaining || 0;
  // 0) 账号手动权重（面板可调，默认 1）：直接乘在总分上
  const manual = Math.max(0, Math.min(20, Number(acc.weight) || 1));
  // 1) 余额占比 ×10：余额多的多干活；没数据给中性 5
  const balFactor = maxRemaining > 0 ? (remaining / maxRemaining) * POOL.weightBalFactor : POOL.weightBalFactor / 2;
  // 2) 闲置补偿：1 小时没干活 +0.5，封顶 5；从未用过给满分
  const idleHours = acc.lastUsedAt ? (now - acc.lastUsedAt) / 3600_000 : 999;
  const idleWeight = Math.min(idleHours * POOL.idleWeightPerHour, POOL.idleWeightMax);
  // 3) 成功率 ×3：无记录给中性 1.5
  const totalReq = (acc.successCount || 0) + (acc.errTotal || 0);
  const successRate = totalReq >= 5 ? (acc.successCount || 0) / totalReq : 0.5;
  const succWeight = successRate * POOL.weightSuccFactor;
  return (balFactor + idleWeight + succWeight) * manual;
}

function pickAccount(sessionKey) {
  const now = Date.now();

  const usable = (a) =>
    !a.disabled && a.cooldownUntil <= now && a.inFlight < POOL.maxInFlight && a.degradeUntil <= now;

  // 1) 粘性：优先回到上次那个号
  const pinned = stickyGet(sessionKey);
  if (pinned) {
    const acc = accounts.find((a) => a.label === pinned);
    if (acc && usable(acc)) return acc;
  }

  // 2) 健康过滤
  let candidates = accounts.filter(usable);

  // 3) 防惊群：把 POOL.minPickGapMs 内刚被选过的号排到队尾而不是剔除（号少时避免无谓的全冷却兑底）
  if (candidates.length > 1 && lastPick) {
    const gap = now - (lastPickAt.get(lastPick) || 0);
    if (gap < POOL.minPickGapMs) {
      candidates = [...candidates.filter((a) => a.label !== lastPick), ...candidates.filter((a) => a.label === lastPick)];
    }
  }

  if (!candidates.length) {
    // 全冷却兑底：从非永久禁用的号里选最早恢复的顶班（参考 workbuddy2api 全冷却兜底）
    const recovering = accounts
      .filter((a) => !a.disabled && a.inFlight < POOL.maxInFlight)
      .sort((x, y) => Math.min(x.cooldownUntil, x.degradeUntil) - Math.min(y.cooldownUntil, y.degradeUntil));
    if (recovering.length) {
      log(`[pool] 全部冷却中，选最早恢复的 ${recovering[0].label} 顶班`);
      return recovering[0];
    }
    return null;
  }

  // 4) 权重计算 + Top-N 截断 + 加权随机
  const maxRemaining = Math.max(1, ...candidates.map((a) => quotaCache.get(a.label)?.remaining || 0));
  const scored = candidates
    .map((a) => ({ a, w: weightOf(a, maxRemaining, now) }))
    .sort((x, y) => y.w - x.w)
    .slice(0, Math.max(1, Math.min(POOL.topN, candidates.length)));

  const totalW = scored.reduce((s, x) => s + x.w, 0);
  let roll = Math.random() * totalW;
  let picked = scored[scored.length - 1].a; // 兑底
  for (const x of scored) {
    roll -= x.w;
    if (roll <= 0) {
      picked = x.a;
      break;
    }
  }

  lastPick = picked.label;
  lastPickAt.set(picked.label, now);
  return picked;
}

function markFailure(acc, ms) {
  acc.failures = (acc.failures || 0) + 1;
  acc.errTotal = (acc.errTotal || 0) + 1;
  acc.consecutiveFails = (acc.consecutiveFails || 0) + 1;
  // 已在更长的冷却中 → 不推进不延长（防止重试把冷却越叠越厚，参考 workbuddy2api）
  if (acc.cooldownUntil > Date.now() && acc.cooldownUntil >= Date.now() + ms) {
    persistState();
    return;
  }
  acc.cooldownUntil = Date.now() + ms;
  if (acc.consecutiveFails >= POOL.breakerThreshold) {
    // 连败降权：30m 起每次翻倍封顶 6h（参考 workbuddy2api breaker 指数退避）
    const blows = acc.consecutiveFails - POOL.breakerThreshold + 1;
    const cd = Math.min(POOL.breakerCooldownMs * 2 ** (blows - 1), 6 * 3600_000);
    acc.degradeUntil = Date.now() + cd;
    log(`[${acc.label}] 连败 ${acc.consecutiveFails} 次，降权 ${Math.round(cd / 60000)}min 至 ${new Date(acc.degradeUntil).toISOString()}`);
  }
  persistState();
}

function markSuccess(acc) {
  acc.consecutiveFails = 0;
  acc.failures = 0;
  acc.successCount = (acc.successCount || 0) + 1;
  acc.lastSuccess = new Date().toISOString();
  acc.lastUsedAt = Date.now();
  acc.lastErr = null;
  persistState();
}

/** 从请求里取粘性会话键（参考 workbuddy2api 提取顺序）：
 *  显式头 → metadata.conversation_id → metadata.user_id → 首条 user 文本指纹 */
function sessionKeyOf(req, inbound) {
  const hdr =
    req.headers['x-zcgw-session'] || req.headers['x-session-id'] || req.headers['x-conversation-id'];
  if (hdr) return String(hdr);
  const meta = inbound?.metadata ?? {};
  const fromMeta = meta.conversation_id || meta.conversationId || meta.user_id || inbound?.conversation_id;
  if (fromMeta) return `conv:${fromMeta}`;
  const msgs = inbound?.messages ?? [];
  const first = msgs.find((m) => m.role === 'user');
  if (!first) return null;
  const text =
    typeof first.content === 'string'
      ? first.content
      : (first.content ?? []).map((b) => b?.text ?? '').join('');
  if (!text) return null;
  return crypto.createHash('sha256').update(text.slice(0, 2000)).digest('hex').slice(0, 16);
}

// ── helpers ──
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

const urlPathnameOf = (req) => { try { return new URL(req.url, 'http://x').pathname; } catch { return req.url; } };

function upstreamHeaders(acc) {
  // local 模式：重读客户端凭证，token 刷新后自动跟上
  if (acc.local) {
    const fresh = localJwt();
    if (fresh) acc.jwt = fresh;
  }
  return {
    ...(profile.headers || {}),
    authorization: `Bearer ${acc.jwt}`,
    'x-api-key': acc.jwt,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'mid-conversation-system-2026-04-07',
    'user-agent': `ZCode/${APP_VERSION} ai-sdk/provider-utils/4.0.27 runtime/node.js/24`,
    'http-referer': UPSTREAM_ORIGIN,
    'x-zcode-app-version': APP_VERSION,
    'x-title': 'Z Code@electron',
    'x-release-channel': 'production',
    'x-platform': 'linux-x64',
    'x-os-category': 'linux',
    'x-os-version': '5.15.0',
    'x-client-timezone': 'Asia/Shanghai',
    'x-client-language': 'zh-CN',
    'x-device-mid': acc.deviceId, // 缺这个 header，billing/balance 会回 3001
    'x-session-id': acc.sessionId,
    'x-query-id': crypto.randomUUID(),
    'x-request-id': requestId(),
    'x-zcode-trace-id': crypto.randomUUID(),
    'x-zcode-agent': 'glm',
    'x-zcode-query-source': 'main_turn',
    'x-zcode-session-type': 'main',
    accept: 'text/event-stream, application/json',
  };
}

function buildUserId(acc) {
  return metadataUserId(acc.uid);
}

/**
 * 思考强度归一化 → 上游 output_config.effort（GLM 认 low/high/max 三档，即客户端 reasoning variants）。
 * 优先级：显式 effort（OpenAI reasoning_effort / 直接传 output_config.effort）→ Anthropic thinking.budget_tokens 分档 → profile 默认。
 */
function effortOf(inbound) {
  const v = inbound?.output_config?.effort ?? inbound?.reasoning_effort;
  if (typeof v === 'string' && v) {
    const s = v.toLowerCase();
    if (s === 'max' || s === 'xhigh' || s === 'ultra') return 'max';
    if (s === 'high' || s === 'medium') return 'high';
    if (s === 'low' || s === 'minimal' || s === 'none') return 'low';
  }
  const budget = Number(inbound?.thinking?.budget_tokens);
  if (Number.isFinite(budget) && budget > 0) {
    if (budget <= 8192) return 'low';
    if (budget <= 32768) return 'high';
    return 'max';
  }
  return profile.output_config?.effort || 'low';
}

function buildUpstreamBody(inbound, acc) {
  const msgs = JSON.parse(JSON.stringify(inbound.messages ?? []));
  let sysText = '';
  if (typeof inbound.system === 'string') sysText = inbound.system;
  else if (Array.isArray(inbound.system)) {
    sysText = inbound.system.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).filter(Boolean).join('\n\n');
  }
  if (sysText.trim()) {
    const banner = `<pi_system_instructions>\n${sysText}\n</pi_system_instructions>`;
    const firstUser = msgs.find((m) => m.role === 'user');
    if (firstUser) {
      if (typeof firstUser.content === 'string') firstUser.content = `${banner}\n\n${firstUser.content}`;
      else if (Array.isArray(firstUser.content)) firstUser.content.unshift({ type: 'text', text: banner });
    } else msgs.unshift({ role: 'user', content: banner });
  }
  return {
    model: inbound.model || DEFAULT_MODEL,
    max_tokens: Math.min(Number(inbound.max_tokens) || profile.max_tokens || 128000, profile.max_tokens || 128000),
    stream: inbound.stream !== false,
    metadata: { user_id: buildUserId(acc) },
    system: profile.system,
    messages: msgs,
    tool_choice: profile.tool_choice ?? { type: 'auto' },
    thinking: profile.thinking ?? { type: 'enabled' },
    output_config: { ...(profile.output_config ?? {}), effort: effortOf(inbound) },
    ...(Array.isArray(inbound.tools) && inbound.tools.length ? { tools: inbound.tools } : {}),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function sendJson(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

// ── 多密钥分发（对外反代网关的 API Key）──
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl');
const KEY_PREFIX = 'zck_';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function readKeys() {
  try {
    const obj = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    return Array.isArray(obj.keys) ? obj : { version: 1, keys: [] };
  } catch {
    return { version: 1, keys: [] };
  }
}

function writeKeys(db) {
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    log('写 keys.json 失败:', e.message);
  }
}

let keyDb = readKeys();

function newKeyMaterial() {
  const full = KEY_PREFIX + crypto.randomBytes(24).toString('hex');
  return { full, prefix: full.slice(0, 12), hash: sha256(full) };
}

/** 对外可见的密钥视图（绝不含 hash） */
function publicKey(k) {
  const now = Date.now();
  const exhausted = k.quotaTokens > 0 && k.usedTokens >= k.quotaTokens;
  const expired = k.expiresAt > 0 && now > k.expiresAt;
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    enabled: !!k.enabled,
    realm: k.realm || '',
    realmZh: REALM_ZH[k.realm] || '不限',
    expiresAt: k.expiresAt || 0,
    expired,
    exhausted,
    models: k.models ?? [],
    ipAllowlist: k.ipAllowlist ?? [],
    quotaTokens: k.quotaTokens || 0,
    usedTokens: k.usedTokens || 0,
    requests: k.requests || 0,
    createdAt: k.createdAt || 0,
    lastUsedAt: k.lastUsedAt || 0,
    note: k.note || '',
    status: !k.enabled ? 'disabled' : expired ? 'expired' : exhausted ? 'exhausted' : 'ok',
  };
}

function clientIp(req) {
  if (!req || !req.headers) return '';
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  let ip = xff || req.socket?.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// ── 全局 IP 管控 + 拦截审计（参考 wb2api security 页）──
const SEC_FILE = path.join(DATA_DIR, 'security.json');
const security = {
  enabled: false,          // 总开关；关=不检查 IP 规则
  mode: 'blacklist',       // blacklist(默认放行，命中拒绝) | whitelist(默认拒绝，命中放行)
  rules: [],               // [{ type:'allow'|'deny', cidr:'1.2.3.4/32', note:'', createdAt }]
  blockedLog: [],          // 拦截审计（环形 500 条）
};

try {
  if (fs.existsSync(SEC_FILE)) Object.assign(security, JSON.parse(fs.readFileSync(SEC_FILE, 'utf8')));
} catch {}

function saveSecurity() {
  try {
    fs.writeFileSync(SEC_FILE, JSON.stringify({
      enabled: security.enabled,
      mode: security.mode,
      rules: security.rules.slice(-200),
      blockedLog: security.blockedLog.slice(-500),
    }, null, 2));
  } catch {}
}

/** IPv4/IPv6-CIDR 匹配（v4 用整型段，v6 前缀逐段比） */
function ipMatch(ip, cidr) {
  if (!cidr || cidr === '0.0.0.0/0') return true;
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr ?? 32);
  if (range.includes(':') !== ip.includes(':')) {
    // v4-mapped v6 归一
    if (ip.includes(':') && /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(ip)) return ipMatch(ip.slice(7), cidr);
    return false;
  }
  if (!range.includes(':')) {
    const toInt = (s) => s.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    const a = toInt(ip), b = toInt(range);
    if (Number.isNaN(a) || Number.isNaN(b)) return ip === range;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }
  const pa = ip.split(':'), pb = range.split(':');
  const seg = Math.ceil(bits / 16);
  for (let i = 0; i < seg; i++) {
    if ((parseInt(pa[i] || '0', 16) >> (16 - Math.min(16, bits - i * 16))) !==
        (parseInt(pb[i] || '0', 16) >> (16 - Math.min(16, bits - i * 16)))) return false;
  }
  return true;
}

/** 返回命中的拒绝/放行规则或 null；只在 security.enabled 时有意义 */
function secCheckIp(ip) {
  if (!security.enabled) return { allowed: true };
  const hits = security.rules.filter((r) => ipMatch(ip, r.cidr));
  const deny = hits.find((r) => r.type === 'deny');
  if (security.mode === 'whitelist') {
    const allow = hits.find((r) => r.type === 'allow');
    return allow ? { allowed: true } : { allowed: false, reason: `IP ${ip} 不在白名单` };
  }
  return deny ? { allowed: false, reason: `IP ${ip} 命中黑名单` } : { allowed: true };
}

function secLogBlocked(req, pathname, reason, apiKeyOk) {
  security.blockedLog.push({
    t: Date.now(),
    ip: clientIp(req),
    path: pathname,
    reason,
    ua: String(req.headers['user-agent'] || '').slice(0, 120),
    hadKey: apiKeyOk === undefined ? undefined : !!apiKeyOk,
  });
  if (security.blockedLog.length > 500) security.blockedLog = security.blockedLog.slice(-500);
  saveSecurity();
}

/** 校验对外密钥；无 key 且无 GATEWAY_KEY 时放行（本机自用模式） */
function authenticate(req, model) {
  // 兼容两种风格：Anthropic 的 x-api-key 与 OpenAI 风格 Authorization: Bearer
  const got = (
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() ||
    String(req.headers['x-api-key'] || '').trim()
  );
  const active = keyDb.keys.filter((k) => !k.deleted);

  // openMode（无任何 key）仅限本机回环访问；对外网卡一律拒绝，防止删光 key 后裸奍
  const openMode = !active.length && !GATEWAY_KEY;
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientIp(req));

  if (!got) {
    if (openMode && loopback) return { ok: true, key: null };
    return { ok: false, status: 401, message: '缺少 API Key' };
  }
  if (GATEWAY_KEY && got === GATEWAY_KEY) {
    return { ok: true, key: { id: 0, name: 'master', models: [], ipAllowlist: [], quotaTokens: 0, usedTokens: 0, requests: 0 } };
  }
  const h = sha256(got);
  const k = active.find((x) => x.hash === h);
  if (!k) {
    if (openMode && loopback) return { ok: true, key: null };
    return { ok: false, status: 401, message: 'API Key 无效' };
  }
  if (!k.enabled) return { ok: false, status: 403, message: 'API Key 已禁用' };
  if (k.expiresAt > 0 && Date.now() > k.expiresAt) return { ok: false, status: 403, message: 'API Key 已过期' };
  if (k.quotaTokens > 0 && (k.usedTokens || 0) >= k.quotaTokens) {
    return { ok: false, status: 429, message: 'API Key 配额已用尽' };
  }
  if ((k.ipAllowlist ?? []).length) {
    const ip = clientIp(req);
    if (!k.ipAllowlist.includes(ip)) return { ok: false, status: 403, message: `IP ${ip} 不在白名单` };
  }
  if ((k.models ?? []).length && model && !k.models.includes(model)) {
    return { ok: false, status: 403, message: `该 Key 不允许使用模型 ${model}` };
  }
  return { ok: true, key: k };
}

// ── 用量采集（内存环形 + jsonl 落盘）──
const USAGE_MAX = 6000;
let usageLog = [];

try {
  if (fs.existsSync(USAGE_FILE)) {
    const lines = fs.readFileSync(USAGE_FILE, 'utf8').trim().split('\n').slice(-USAGE_MAX);
    for (const l of lines) {
      try {
        usageLog.push(JSON.parse(l));
      } catch {}
    }
    log(`已载入历史用量记录 ${usageLog.length} 条`);
  }
} catch {}

function recordUsage(req, rec) {
  // 请求日志带来源 IP 与 UA（wb2api logs 风格，方便事后审计谁在用什么打进来）
  if (req && req.headers) {
    rec.ip = clientIp(req);
    rec.ua = String(req.headers['user-agent'] || '').slice(0, 80) || undefined;
  }
  usageLog.push(rec);
  if (usageLog.length > USAGE_MAX) usageLog = usageLog.slice(-USAGE_MAX);
  try {
    fs.appendFileSync(USAGE_FILE, JSON.stringify(rec) + '\n');
  } catch {}

  // 同步累到密钥头上
  if (rec.keyId) {
    const k = keyDb.keys.find((x) => x.id === rec.keyId);
    if (k) {
      k.usedTokens = (k.usedTokens || 0) + (rec.in || 0) + (rec.out || 0) + (rec.cacheRead || 0) + (rec.cacheCreate || 0);
      k.requests = (k.requests || 0) + 1;
      k.lastUsedAt = rec.t;
      writeKeys(keyDb);
    }
  }
}

/** 从文本里抽出所有 `"key": {...}` 的 JSON 对象（支持嵌套，正则拿不下 server_tool_use） */
function extractJsonObjects(text, key) {
  const out = [];
  const needle = `"${key}"`;
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    const i = text.indexOf('{', idx + needle.length);
    if (i === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break;
    out.push(text.slice(i, end + 1));
    idx = end;
  }
  return out;
}

/** 从 SSE 文本里抽 usage（message_start / message_delta 两处合并取最大） */
function usageFromSse(text) {
  const out = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
  for (const seg of extractJsonObjects(text, 'usage')) {
    try {
      const u = JSON.parse(seg);
      if (u.input_tokens > out.in) out.in = u.input_tokens;
      if (u.output_tokens > out.out) out.out = u.output_tokens;
      if (u.cache_read_input_tokens > out.cacheRead) out.cacheRead = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens > out.cacheCreate) out.cacheCreate = u.cache_creation_input_tokens;
    } catch {}
  }
  return out;
}

function usageFromJson(obj) {
  const u = obj?.usage ?? {};
  return {
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
  };
}

// ── 主处理 ──
/** OpenAI /v1/chat/completions → Anthropic /v1/messages 转换适配 */
function openaiToAnthropic(body) {
  const msgs = [];
  let system = '';
  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') {
      system += (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join('\n')) + '\n\n';
    } else if (m.role === 'user' || m.role === 'assistant') {
      // OpenAI tool 消息（role=tool）合井成 assistant/tool_result 略复杂，先支持纯文本 + tool_calls 主流场景
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
      msgs.push({ role: m.role, content: text || ' ' });
    } else if (m.role === 'tool') {
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }] });
    }
  }
  if (!msgs.length) msgs.push({ role: 'user', content: ' ' });
  const out = {
    model: body.model || DEFAULT_MODEL,
    max_tokens: body.max_tokens || body.max_completion_tokens || 8192,
    stream: !!body.stream,
    messages: msgs,
  };
  if (system.trim()) out.system = system.trim();
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  // 思考强度：OpenAI 的 reasoning_effort 透传给 effortOf 归一化成 GLM 的 low/high/max
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort) out.reasoning_effort = body.reasoning_effort;
  return out;
}

function anthropicToOpenAI(env, model) {
  const text = (env.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const toolCalls = (env.content ?? []).filter((b) => b.type === 'tool_use').map((b, i) => ({
    id: b.id,
    type: 'function',
    function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
  }));
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: env.id || 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: env.stop_reason === 'tool_use' ? 'tool_calls' : env.stop_reason === 'max_tokens' ? 'length' : 'stop' }],
    usage: {
      prompt_tokens: env.usage?.input_tokens || 0,
      completion_tokens: env.usage?.output_tokens || 0,
      total_tokens: (env.usage?.input_tokens || 0) + (env.usage?.output_tokens || 0),
    },
  };
}

async function handleOpenAIChat(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: { message: 'bad JSON', type: 'invalid_request_error' } });
  }
  const inbound = openaiToAnthropic(body);

  // 鉴权 + IP 管控（与 /v1/messages 同一套）
  const sec = secCheckIp(clientIp(req));
  if (!sec.allowed) {
    secLogBlocked(req, urlPathnameOf(req), sec.reason);
    return sendJson(res, 403, { error: { message: sec.reason, type: 'permission_error' } });
  }
  const auth = authenticate(req, inbound.model);
  if (!auth.ok) {
    if (auth.status === 401 || auth.status === 403) secLogBlocked(req, urlPathnameOf(req), auth.message, false);
    return sendJson(res, auth.status, { error: { message: auth.message, type: 'authentication_error' } });
  }
  const reqKey = auth.key;
  const startedAt = Date.now();
  const basePayload = buildUpstreamBody(inbound, { uid: 'placeholder' });
  // OpenAI 入口永远非流式转换（stream:true 的 OpenAI 客户端后续再做 SSE 转发）
  basePayload.stream = false;
  const sessionKey = sessionKeyOf(req, inbound);

  if (!accounts.length) {
    return sendJson(res, 503, { error: { message: '尚未纳管任何账号：请打开面板点「登录新账号」，或在 data/accounts.json 配置 JWT', type: 'api_error' } });
  }
  if (!accounts.some((a) => !a.disabled)) {
    return sendJson(res, 503, { error: { message: '账号池内所有账号已被手动停用：请在面板「账号管理」里重新启用', type: 'api_error' } });
  }
  const maxAttempts = Math.min(accounts.length, 4);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) stickyUnbind(sessionKey);
    const acc = pickAccount(sessionKey);
    if (!acc) {
      const soonest = Math.min(...accounts.map((a) => Math.max(a.cooldownUntil, a.degradeUntil)));
      return sendJson(res, 429, { error: { message: `所有账号不可用，${Math.ceil((soonest - Date.now()) / 60000)} 分钟后重试`, type: 'rate_limit_error' } });
    }
    acc.lastUsedAt = Date.now();
    const payload = { ...basePayload, metadata: { user_id: buildUserId(acc) } };

    let upstream;
    acc.inFlight += 1;
    try {
      upstream = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers: upstreamHeaders(acc),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      acc.inFlight -= 1;
      markFailure(acc, 60_000);
      continue;
    }

    const rawBody = await upstream.text().catch(() => '');
    acc.inFlight -= 1;
    let env = null;
    try { env = JSON.parse(rawBody); } catch {}
    const biz = env?.error?.biz_code ?? env?.biz_code;

    if (upstream.ok && env) {
      markSuccess(acc);
      stickySet(sessionKey, acc.label);
      const u = usageFromJson(env);
      recordUsage(req, {
        t: Date.now(), keyId: reqKey?.id || 0, key: reqKey?.name || 'master', acc: acc.label,
        model: inbound.model, in: u.in, out: u.out, cacheRead: u.cacheRead, cacheCreate: u.cacheCreate,
        ms: Date.now() - startedAt, ok: true,
      });
      return sendJson(res, 200, anthropicToOpenAI(env, body.model || inbound.model));
    }

    if (biz === 3012) { markFailure(acc, POOL.blockedCooldownMin * 60_000); stickyUnbind(sessionKey); continue; }
    if (biz === 1005 || biz === 3009) {
      const heavy = acc.consecutiveFails >= 2;
      markFailure(acc, heavy ? POOL.quotaCooldownMin * 60_000 : POOL.busyCooldownSec * 1000);
      continue;
    }
    if (upstream.status >= 500) { markFailure(acc, 60_000); stickyUnbind(sessionKey); continue; }

    // 客户端错误直接透传（OpenAI 风格包装）
    recordUsage(req, {
      t: Date.now(), keyId: reqKey?.id || 0, key: reqKey?.name || 'master', acc: acc.label,
      model: inbound.model, in: 0, out: 0, cacheRead: 0, cacheCreate: 0,
      ms: Date.now() - startedAt, ok: false, err: biz ? String(biz) : `http-${upstream.status}`,
    });
    return sendJson(res, upstream.status, { error: { message: env?.error?.message || rawBody.slice(0, 300) || `upstream ${upstream.status}`, type: 'api_error' } });
  }
  recordUsage(req, {
    t: Date.now(), keyId: reqKey?.id || 0, key: reqKey?.name || 'master', acc: '-',
    model: inbound.model, in: 0, out: 0, cacheRead: 0, cacheCreate: 0,
    ms: Date.now() - startedAt, ok: false, err: 'all-accounts-failed',
  });
  sendJson(res, 502, { error: { message: '所有账号尝试失败', type: 'api_error' } });
}

async function handleMessages(req, res) {
  const raw = await readBody(req);
  let inbound;
  try {
    inbound = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad JSON' } });
  }
  const reqModel = inbound.model || DEFAULT_MODEL;
  // 全局 IP 管控（在密钥鉴权之前；拦截落审计日志）
  const sec = secCheckIp(clientIp(req));
  if (!sec.allowed) {
    secLogBlocked(req, urlPathnameOf(req), sec.reason);
    return sendJson(res, 403, { type: 'error', error: { type: 'permission_error', message: sec.reason } });
  }
  const auth = authenticate(req, reqModel);
  if (!auth.ok) {
    if (auth.status === 401 || auth.status === 403) secLogBlocked(req, urlPathnameOf(req), auth.message, false);
    return sendJson(res, auth.status, {
      type: 'error',
      error: { type: 'authentication_error', message: auth.message },
    });
  }
  const reqKey = auth.key;
  const startedAt = Date.now();
  const basePayload = buildUpstreamBody(inbound, { uid: 'placeholder' });
  const sessionKey = sessionKeyOf(req, inbound);

  if (!accounts.length) {
    return sendJson(res, 503, { type: 'error', error: { type: 'api_error', message: '尚未纳管任何账号：请打开面板点「登录新账号」，或在 data/accounts.json 配置 JWT' } });
  }
  if (!accounts.some((a) => !a.disabled)) {
    return sendJson(res, 503, { type: 'error', error: { type: 'api_error', message: '账号池内所有账号已被手动停用：请在面板「账号管理」里重新启用' } });
  }
  const maxAttempts = Math.min(accounts.length, 4);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 重试时先解绑粘性：粘住的号已经失败过，继续粘着只会再撞一次墙
    if (attempt > 0) stickyUnbind(sessionKey);
    const acc = pickAccount(sessionKey);
    if (!acc) {
      const soonest = Math.min(...accounts.map((a) => Math.max(a.cooldownUntil, a.degradeUntil)));
      return sendJson(res, 429, {
        type: 'error',
        error: { type: 'rate_limit_error', message: `所有账号不可用，${Math.ceil((soonest - Date.now()) / 60000)} 分钟后重试` },
      });
    }
    acc.lastUsedAt = Date.now();

    // metadata.user_id 必须按当前账号派生，否则会把不同号关联到同一台设备
    const payload = { ...basePayload, metadata: { user_id: buildUserId(acc) } };

    let upstream;
    acc.inFlight += 1;
    try {
      upstream = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers: upstreamHeaders(acc),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      acc.inFlight -= 1;
      acc.lastErr = `network: ${e.message}`;
      log(`[${acc.label}] network error: ${e.message}`);
      markFailure(acc, 60_000);
      continue;
    }

    const ctype = upstream.headers.get('content-type') || 'application/json';
    const isStream = ctype.includes('text/event-stream');

    if (!isStream) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      acc.inFlight -= 1;
      const text = buf.toString('utf8');
      let env;
      try {
        env = JSON.parse(text);
      } catch {}
      const biz = env?.code;
      if (biz === 3012) {
        acc.lastErr = '3012 blocked';
        log(`[${acc.label}] 3012 blocked, cooling ${POOL.blockedCooldownMs / 60000}min, next account`);
        markFailure(acc, POOL.blockedCooldownMs);
        stickyUnbind(sessionKey); // 粘住的号失效了，解绑让下一次请求重新选号
        continue;
      }
      if (biz === 1005 || biz === 3009) {
        // 这两个码既是“额度用完”也是“并发超限”，不可一律重罚：
        // 先按瞬态短冷却，连续多次才当真的额度耗尽
        const heavy = acc.consecutiveFails >= 2;
        const ms = heavy ? POOL.quotaCooldownMs : POOL.busyCooldownMs;
        acc.lastErr = `${biz} ${heavy ? 'quota' : 'busy'}`;
        log(`[${acc.label}] ${biz} -> 冷却 ${Math.round(ms / 1000)}s，换下一个号`);
        markFailure(acc, ms);
        stickyUnbind(sessionKey);
        continue;
      }
      if (upstream.status >= 500) {
        acc.lastErr = `http-${upstream.status}`;
        markFailure(acc, 60_000);
        stickyUnbind(sessionKey);
        continue;
      }
      if (upstream.ok) {
        markSuccess(acc);
        stickySet(sessionKey, acc.label);
      }
      const u = upstream.ok ? usageFromJson(env) : { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
      recordUsage(req, {
        t: Date.now(),
        keyId: reqKey?.id || 0,
        key: reqKey?.name || 'master',
        acc: acc.label,
        model: payload.model,
        ...u,
        ms: Date.now() - startedAt,
        ok: upstream.ok,
        err: upstream.ok ? '' : biz ? String(biz) : `http-${upstream.status}`,
      });
      res.writeHead(upstream.status, { 'content-type': ctype, 'content-length': buf.length, 'x-zcgw-account': acc.label });
      return res.end(buf);
    }

    if (VERBOSE) log(`[${acc.label}] stream ${upstream.status} model=${payload.model} sticky=${!!sessionKey}`);
    if (upstream.ok) {
      markSuccess(acc);
      stickySet(sessionKey, acc.label);
    }
    res.writeHead(upstream.status, {
      'content-type': ctype,
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-zcgw-account': acc.label,
    });
    if (!upstream.body) {
      acc.inFlight -= 1;
      return res.end();
    }
    const reader = upstream.body.getReader();
    let sseBuf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        if (sseBuf.length < 400_000) sseBuf += buf.toString('utf8');
        if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
      }
    } catch (e) {
      if (VERBOSE) log('stream error:', e.message);
    } finally {
      acc.inFlight -= 1;
      const u = upstream.ok ? usageFromSse(sseBuf) : { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
      recordUsage(req, {
        t: Date.now(),
        keyId: reqKey?.id || 0,
        key: reqKey?.name || 'master',
        acc: acc.label,
        model: payload.model,
        ...u,
        ms: Date.now() - startedAt,
        ok: upstream.ok,
        err: upstream.ok ? '' : `http-${upstream.status}`,
      });
      res.end();
    }
    return;
  }
  recordUsage(req, {
    t: Date.now(),
    keyId: reqKey?.id || 0,
    key: reqKey?.name || 'master',
    acc: '-',
    model: reqModel,
    in: 0,
    out: 0,
    cacheRead: 0,
    cacheCreate: 0,
    ms: Date.now() - startedAt,
    ok: false,
    err: 'all-accounts-failed',
  });
  sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: '所有账号尝试失败' } });
}

function handlePool(req, res) {
  const now = Date.now();
  sendJson(res, 200, {
    pool: {
      maxInFlight: POOL.maxInFlight,
      topN: POOL.topN,
      stickyTtlMin: POOL.stickyTtlMin,
    },
    stickySessions: sticky.size,
    accounts: accounts.map((a) => ({
      label: a.label,
      userId: a.uid,
      email: a.email,
      phone: a.phone,
      name: a.name,
      identity: a.identity,
      weight: a.weight ?? 1,
      disabled: !!a.disabled,
      hasAccessToken: a.hasAccessToken,
      realm: a.realm,
      realmZh: a.realmZh,
      local: !!a.local,
      deviceId: a.deviceId || deviceIdFor(a.uid),
      available: a.cooldownUntil <= now && a.degradeUntil <= now && a.inFlight < POOL.maxInFlight,
      cooling: a.cooldownUntil > now,
      cooldownMin: a.cooldownUntil > now ? Math.ceil((a.cooldownUntil - now) / 60000) : 0,
      degraded: a.degradeUntil > now,
      inFlight: a.inFlight,
      failures: a.failures,
      consecutiveFails: a.consecutiveFails,
      successCount: a.successCount || 0,
      errTotal: a.errTotal || 0,
      lastUsedAt: a.lastUsedAt || 0,
      manualWeight: a.weight ?? 1,
      weight: Math.round(weightOf(a, Math.max(1, ...accounts.map((x) => quotaCache.get(x.label)?.remaining || 0)), now) * 10) / 10,
      lastSuccess: a.lastSuccess,
      lastErr: a.lastErr,
    })),
  });
}

/** Read-only quota refresh; disabled accounts keep their own quota visibility. */
async function handleQuota(req, res) {
  const out = [];
  for (const acc of accounts) {
    await refreshQuotaAccount(acc);
    const cached = quotaCache.get(acc.label);
    const source = quotaSources.get(acc.label)?.billing;
    out.push({ label: acc.label, plans: (cached?.plans || []).map((p) => ({ ...p, endsAt: p.endsAt ? Date.parse(p.endsAt) / 1000 : null })), balances: (cached?.balances || []).map((b) => ({ ...b, periodEnd: b.periodEnd ? Date.parse(b.periodEnd) / 1000 : null })), error: source?.error || undefined });
  }
  sendJson(res, 200, { accounts: out });
}

async function quotaJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const j = await safeJson(r);
  if (!r.ok || j.__error || j.success === false || ![0, 200, '0', '200'].includes(j.code)) {
    // Never echo upstream payloads, which may contain credentials or personal data.
    throw new Error(`查询失败（HTTP ${r.status}，业务码 ${Number(j.code) || '未知'}）`);
  }
  if (!j.data || typeof j.data !== 'object') throw new Error('查询响应缺少 data');
  return j.data;
}

function sourceName(acc, id) {
  return id === 'billing' ? 'ZCode 套餐' : `${acc.codingPlanProvider === 'bigmodel' ? 'BigModel' : 'Z.ai'} Coding Plan`;
}

async function refreshQuotaSource(acc, id) {
  const key = `${acc.label}:${id}`;
  if (accountRefreshes.has(key)) return accountRefreshes.get(key);
  const run = (async () => {
    const previous = quotaSources.get(acc.label)?.[id];
    const base = { id, name: sourceName(acc, id), plans: previous?.plans || [], syncedAt: previous?.syncedAt || null };
    let source;
    try {
      let plans;
      if (id === 'billing') {
        const q = await quotaOf(acc);
        plans = q.plans;
        setQuotaCache([{ label: acc.label, ...q }]);
      } else {
        // The stored OAuth token belongs to Z.ai; never send it to a different provider.
        const token = acc.codingPlanApiKey || (acc.codingPlanProvider !== 'bigmodel' ? acc.zaiAccessToken : null);
        if (!token) {
          source = { ...base, plans: [], syncedAt: null, status: 'unconfigured', error: '未接入查询：请在编辑账号中配置 Coding Plan API Key' };
        } else {
          const origin = acc.codingPlanProvider === 'bigmodel'
            ? (process.env.ZCODE_BIGMODEL_ORIGIN || 'https://open.bigmodel.cn') : ZAI_ORIGIN;
          const data = await quotaJson(`${origin}/api/monitor/usage/quota/limit`, { authorization: `Bearer ${token}`, accept: 'application/json' });
          if (!Array.isArray(data.limits)) throw new Error('额度响应缺少 limits');
          plans = normalizeCoding(data);
        }
      }
      source ||= { ...base, plans, syncedAt: new Date().toISOString(), status: 'ready', error: null };
    } catch (e) {
      source = { ...base, status: 'error', error: `${e.message}${id === 'coding' && !acc.codingPlanApiKey ? '；可在编辑账号中配置对应平台的 Coding Plan API Key' : ''}` };
    }
    quotaSources.set(acc.label, { ...quotaSources.get(acc.label), [id]: source });
    return source;
  })();
  accountRefreshes.set(key, run);
  try { return await run; } finally { accountRefreshes.delete(key); }
}

async function refreshQuotaAccount(acc) {
  return Promise.all(['billing', 'coding'].map((id) => refreshQuotaSource(acc, id)));
}

/** 可领取的 plan 列表 + 候选 id（preview 为空时用来兑底） */
async function claimableFor(acc) {
  const data = await quotaJson(
    `${UPSTREAM_ORIGIN}/api/v1/zcode-plan/billing/preview?app_version=${APP_VERSION}&platform=win32-x64`,
    upstreamHeaders(acc),
  );
  if (!Array.isArray(data.plans)) throw new Error('资格响应缺少 plans');
  const plans = data.plans.map((p) => ({
    planId: String(p.plan_id || ''), name: String(p.name || p.plan_id || ''),
    description: String(p.description || ''),
    entitlements: (p.entitlements || []).map((e) => ({ model: e.show_name, grant: e.grant_units, period: e.period })),
  })).filter((p) => p.planId);
  return { plans, rawCode: 0, rawMsg: '' };
}

// ── 领取资格：双通道（对齐 zcode-switch）──
// billing/preview 只是其一；新版活动（客户端弹窗/banner）只经 marketing/touch 下发，
// deliveries 按钮带 claim_zcode_plan 的 plan_id。2026-11 的 GLOBAL BUILD 活动实测只出现在
// marketing 通道 —— 只猜日期编码会永远领不到。

/** 递归收集 delivery 里活动按钮的 plan_id（action.type = claim_zcode_plan） */
function collectClaimButtons(v, out) {
  if (Array.isArray(v)) {
    for (const it of v) collectClaimButtons(it, out);
  } else if (v && typeof v === 'object') {
    const action = v.action;
    if (action && typeof action === 'object') {
      const ty = action.type || '';
      if (ty === 'claim_zcode_plan' || ty === 'claim_plan') {
        const id = String(action.args?.plan_id || action.planId || '').trim();
        if (id) out.push(id);
      }
    }
    for (const val of Object.values(v)) collectClaimButtons(val, out);
  }
}

/** Both channels are queried independently; failure is not an empty eligibility result. */
async function marketingClaimableIds(acc) {
  const data = await quotaJson(`${UPSTREAM_ORIGIN}/api/v1/marketing/touch?seq=0`, upstreamHeaders(acc));
  if (!Array.isArray(data.deliveries)) throw new Error('活动响应缺少 deliveries');
  const ids = [];
  for (const d of data.deliveries) collectClaimButtons(d, ids);
  return [...new Set(ids)];
}

async function refreshEligibility(acc) {
  const key = `${acc.label}:eligibility`;
  if (accountRefreshes.has(key)) return accountRefreshes.get(key);
  const run = (async () => {
    const results = await Promise.allSettled([claimableFor(acc), marketingClaimableIds(acc)]);
    const plans = new Map();
    const errors = [];
    if (results[0].status === 'fulfilled') {
      for (const p of results[0].value.plans) plans.set(p.planId, p);
    } else errors.push(`套餐资格：${results[0].reason.message}`);
    if (results[1].status === 'fulfilled') {
      for (const id of results[1].value) if (!plans.has(id)) plans.set(id, { planId: id, name: id, description: '', entitlements: [] });
    } else errors.push(`活动资格：${results[1].reason.message}`);
    const state = {
      status: errors.length === 2 ? 'error' : errors.length ? 'partial' : 'ready',
      plans: [...plans.values()], checkedAt: new Date().toISOString(), error: errors.join('；') || null,
    };
    eligibilityCache.set(acc.label, state);
    return state;
  })();
  accountRefreshes.set(key, run);
  try { return await run; } finally { accountRefreshes.delete(key); }
}

async function claimCandidates(acc, planId) {
  if (planId) return [planId];
  const state = await refreshEligibility(acc);
  if (state.status === 'error') throw new Error(state.error);
  return state.plans.map((p) => p.planId);
}

// ── 阿里云验证码配置（claim 必带 X-Aliyun-Captcha-Verify-Param，否则 3007）──
let captchaConfigCache = { ts: 0, cfg: null };
const CAPTCHA_CFG_DEFAULT = { enabled: true, region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' };

async function captchaConfig() {
  if (captchaConfigCache.cfg && Date.now() - captchaConfigCache.ts < 600_000) return captchaConfigCache.cfg;
  try {
    const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/client/configs`, {
      headers: { 'user-agent': `ZCode/${APP_VERSION}`, 'http-referer': UPSTREAM_ORIGIN },
      signal: AbortSignal.timeout(8000),
    });
    const j = await safeJson(r);
    const c = j.data?.configs?.captcha;
    const cfg = c && c.enabled
      ? { enabled: true, region: c.region || 'cn', prefix: c.prefix || 'no8xfe', sceneId: c.sceneId || '11xygtvd' }
      : CAPTCHA_CFG_DEFAULT;
    captchaConfigCache = { ts: Date.now(), cfg };
    return cfg;
  } catch {
    return captchaConfigCache.cfg || CAPTCHA_CFG_DEFAULT;
  }
}

/** 从 balance 里看当前已激活的非日包（周末包等） */
async function activeGrants(acc) {
  try {
    const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`, {
      headers: upstreamHeaders(acc),
      signal: AbortSignal.timeout(20000),
    });
    const j = await safeJson(r);
    const now = Date.now() / 1000;
    return (j.data?.plans ?? []).filter((p) => p.status === 'active' && (p.ends_at ?? 0) > now);
  } catch {
    return [];
  }
}

/** Discover candidates from preview and marketing; one captcha authorizes one claim. */
async function claimFor(acc, planId, captchaParam) {
  if (!captchaParam || !captchaParam.trim()) {
    // 上游 claim 已强制阿里云人机验证（3007 captcha verify failed），无验证参数直接拒绝，
    // 避免白白消耗候选重试。前端负责跑阿里云 SDK 拿 captchaVerifyParam。
    return { ok: false, code: 'captcha_required', msg: '需要人机验证：请从面板发起领取（会自动完成无痕验证）' };
  }
  const candidates = await claimCandidates(acc, planId);
  const captchaHeaders = {
    'x-aliyun-captcha-verify-param': captchaParam.trim(),
  };

  const tried = [];
  const claimed = [];
  const dup = [];
  const deadline = Date.now() + Number(process.env.ZCGW_CLAIM_BUDGET_MS || 25000);
  for (const pid of [...new Set(candidates)]) {
    if (Date.now() > deadline) {
      tried.push({ planId: '(...)', code: 'budget', msg: '候选太多，已超时中止' });
      break;
    }
    let j = null;
    try {
      const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/zcode-plan/billing/claim`, {
        method: 'POST',
        headers: { ...upstreamHeaders(acc), ...captchaHeaders },
        body: JSON.stringify({ plan_id: pid }),
        signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
      });
      const text = await r.text();
      try {
        j = JSON.parse(text);
      } catch {
        tried.push({ planId: pid, code: `http-${r.status}`, msg: text.slice(0, 80) || '(空响应)' });
        continue;
      }
    } catch (e) {
      tried.push({ planId: pid, code: 'network', msg: e.message });
      continue;
    }

    const code = j.code;
    const msg = j.data?.message || j.msg || '';
    tried.push({ planId: pid, code, msg });
    log(`[${acc.label}] claim ${pid} -> ${code} ${msg}`);

    // 3007 验证码校验失败（参数过期/已用）：验证参数是一次性的，换下一个候选也没用，直接终态
    if (code === 3007) {
      return { ok: false, code: 3007, msg: '验证码参数已过期或已使用，请重新发起领取', tried };
    }
    // 领到了：验证参数已消费，收工（一次验证领一个套餐）
    if (code === 0 && j.data?.plan) {
      claimed.push({ planId: pid, plan: j.data.plan });
      break;
    }
    // 1003 已领过：记下来，不阻断其它候选
    if (code === 1003) {
      dup.push({ planId: pid, msg });
      continue;
    }
    // 1001 套餐不存在：继续试下一个候选
  }

  if (claimed.length) {
    return {
      ok: true,
      claimed: claimed.map((c) => c.planId).join(', '),
      claimedList: claimed.map((c) => c.planId),
      alreadyClaimedPlans: dup.map((d) => d.planId),
      tried,
    };
  }
  if (dup.length) {
    // 缺失的类型回 1003 → 上游确实领过，但不在生效列表里 → 该一次性体验包已过期/用尽
    return {
      ok: true,
      alreadyClaimed: true,
      expired: true,
      claimed: dup[0].planId,
      upstreamMsg: dup[0].msg || '',
      msg: '上游返回 1003（target already exists）：该号此前已领过体验包，当前不在生效列表，体验窗口已结束，无法重复领取',
      tried,
    };
  }
  return { ok: false, msg: tried.at(-1)?.msg || '没有可领取的套餐', tried };
}

/** Legacy endpoint shares the same eligibility result as the console. */
async function handleClaimable(req, res) {
  const out = [];
  for (const acc of accounts) {
    const state = await refreshEligibility(acc);
    out.push({ label: acc.label, claimable: state.plans, ...state });
  }
  sendJson(res, 200, { accounts: out });
}

/** 一键领取：POST { label?, planId? } */
async function handleClaim(req, res, labelOverride) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}

  const targetLabel = labelOverride || body.label;
  // 上游 claim 强制阿里云人机验证：无验证参数时直接给出明确错误（前端负责跑 SDK 拿参数）
  const captchaParam = String(body.captchaParam || body.captchaVerifyParam || '').trim();
  if (!captchaParam) {
    return sendJson(res, 200, {
      results: [{ label: targetLabel ?? '(all)', ok: false, code: 'captcha_required', msg: '需要人机验证：请从面板「账号管理」的领取按钮发起（会自动完成无痕验证）' }],
    });
  }
  // 一键领取只处理已启用账号；指定 label 时精确到号（停用号保留领取资格）
  const targets = targetLabel
    ? accounts.filter((a) => a.label === targetLabel)
    : accounts.filter((a) => !a.disabled);
  const results = [];
  for (const acc of targets) {
    try {
      const result = await claimFor(acc, body.planId, captchaParam);
      results.push({ label: acc.label, ...result });
      if (result.ok) await Promise.all([refreshQuotaAccount(acc), refreshEligibility(acc)]);
    } catch (e) {
      results.push({ label: acc.label, ok: false, msg: e.message });
    }
  }
  sendJson(res, 200, { results });
}

// ── 无头登录（设备授权流）：登录即纳管，纳管即自动领取 ──
// flow 要落盘：网关重启不该把你正在等的那次授权弄丢
const FLOW_FILE = path.join(DATA_DIR, 'onboard-flows.json');
// 领领取的速度：每个候选 15s 就够，否则一个卡死的候选会拖到分钟级
const CLAIM_TIMEOUT_MS = Number(process.env.ZCGW_CLAIM_TIMEOUT_MS || 15000);

function readFlows() {
  try {
    const obj = JSON.parse(fs.readFileSync(FLOW_FILE, 'utf8'));
    const map = new Map();
    const cut = Date.now() - 20 * 60_000;
    for (const [k, v] of Object.entries(obj)) if (v.createdAt > cut) map.set(k, v);
    return map;
  } catch {
    return new Map();
  }
}

function writeFlows(map) {
  try {
    fs.writeFileSync(FLOW_FILE, JSON.stringify(Object.fromEntries(map), null, 2));
  } catch {}
}

const pendingFlows = readFlows(); // flowId -> { pollToken, createdAt }


/** 读某个账号的余额（统一格式，带中文标签） */
async function quotaOf(acc) {
  const data = await quotaJson(`${UPSTREAM_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`, upstreamHeaders(acc));
  if (!Array.isArray(data.plans) || !Array.isArray(data.balances)) throw new Error('套餐余额响应缺少 plans / balances');
  const plans = normalizeBilling(data).map((p) => {
    const d = describePlan(p.id, p.name);
    return { ...p, nameZh: p.name, kind: d.kind, kindZh: d.kindZh };
  });
  const balances = plans.flatMap((p) => p.items.map((item) => ({
    planId: p.id, model: item.name, kind: p.kind, kindZh: p.kindZh, typeZh: `${p.name} · ${item.name}`,
    remaining: item.remaining, total: item.total, periodEnd: item.resetAt,
  })));
  return { plans, balances };
}

/** 手动添加：POST { jwt, label?, email?, accessToken? } —— flow 丢了或想直接粘贴 token 时用 */
async function handleAccountAdd(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}
  const jwt = String(body.jwt || '').trim();
  if (!jwt.startsWith('eyJ')) return sendJson(res, 400, { error: 'jwt 格式不对（应以 eyJ 开头）' });
  const uid = userIdFromJwt(jwt);
  if (!uid) return sendJson(res, 400, { error: 'jwt 里解析不出 user_id' });

  // 粘的是 access_token（更长的那个）而不是 zcodejwt 时，也认识一下
  const accessToken = String(body.accessToken || body.zaiAccessToken || '').trim().startsWith('eyJ')
    ? String(body.accessToken || body.zaiAccessToken).trim()
    : null;

  // 有 access_token 就直接查官方客户档案，完全免手填
  let customer = null;
  if (accessToken) customer = await fetchCustomerInfo(accessToken);

  const email = String(customer?.email || body.email || '').trim() || null;
  const phone = String(customer?.phoneNumber || '').trim() || null;
  let realm = realmFromCustomer(customer);
  if (realm === 'unknown') realm = body.realm || realmFromIdentity(email);
  const nick = String(customer?.nickName || customer?.customerName || body.name || '').trim() || null;

  const label = body.label || (nick ? `${nick}-${uid.slice(0, 8)}` : `acc-${uid.slice(0, 8)}`);
  const { added } = persistAccount(jwt, label, { email, phone, name: nick, realm, accessToken });
  accounts = readAccountFile();
  const acc = accounts.find((a) => a.uid === uid);

  let claim = null;
  let quota = null;
  if (acc) {
    try {
      claim = await claimFor(acc);
      quota = await quotaOf(acc);
    } catch (e) {
      claim = { ok: false, msg: e.message };
    }
  }
  // 只粘了 zcodejwt 也没关系：用 zaiAccessToken 反查客户档案补全身份（免手填）
  if (acc && !acc.email && !acc.phone && acc.zaiAccessToken) {
    try {
      const c = await fetchCustomerInfo(acc.zaiAccessToken);
      if (c) {
        acc.email = c.email || acc.email;
        acc.phone = c.phoneNumber || acc.phone;
        acc.name = c.nickName || c.customerName || acc.name;
        acc.identity = displayIdentity(acc);
        const r2 = realmFromCustomer(c);
        if (r2 !== 'unknown') acc.realm = r2;
        persistAccount(jwt, acc.label, acc);
        accounts = readAccountFile();
      }
    } catch {}
  }
  sendJson(res, 200, {
    status: 'ready',
    added,
    label: acc?.label ?? label,
    userId: uid,
    email: acc?.email ?? email,
    phone: acc?.phone ?? phone,
    identity: acc?.identity ?? displayIdentity({ email, phone }),
    realm: acc?.realm ?? realm,
    hasAccessToken: acc?.hasAccessToken ?? !!accessToken,
    claim,
    quota,
  });
}

/** 重新识别所有账号身份：POST /accounts/identify */
async function handleIdentifyAll(req, res) {
  const seeded = seedLocalAccessToken();
  if (seeded) {
    accounts = readAccountFile();
    log(`从本地 ZCode 客户端补入 access_token ${seeded} 个`);
  }
  const r = await identifyAll(true);
  accounts = readAccountFile();
  sendJson(res, 200, {
    ok: true,
    seeded,
    updated: r.updated ?? 0,
    withToken: r.withToken ?? 0,
    total: r.total ?? 0,
    accounts: accounts.map((a) => ({
      label: a.label,
      identity: a.identity,
      realm: a.realm,
      realmZh: a.realmZh,
      hasAccessToken: a.hasAccessToken,
    })),
  });
}


const ONBOARD_PROVIDERS = ['zai', 'bigmodel'];

async function handleOnboardStart(req, res) {
  const raw = await readBody(req).catch(() => null);
  let body = {};
  try { body = raw?.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {}
  // 国内号走 bigmodel.cn 登录页，国际号走 chat.z.ai —— provider 选错整条授权链就是死的
  const provider = ONBOARD_PROVIDERS.includes(body.provider) ? body.provider
    : (ONBOARD_PROVIDERS.includes(process.env.ZCGW_ONBOARD_PROVIDER) ? process.env.ZCGW_ONBOARD_PROVIDER : 'zai');
  const pollToken = crypto.randomBytes(32).toString('hex');
  let j;
  try {
    const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/oauth/cli/init`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pollToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
      signal: AbortSignal.timeout(10_000),
    });
    j = await safeJson(r);
  } catch (e) {
    return sendJson(res, 502, { error: `上游授权服务不可达（${e.message}），请稍后重试`, code: 'upstream_unreachable' });
  }
  if (j.code !== 0) return sendJson(res, 502, { error: j.msg || 'init 失败', raw: j });
  const { flow_id, authorize_url, expires_at, poll_interval_sec } = j.data;
  // state 是授权链接的全局唯一标识：手动粘贴回调链接时靠它反查是哪个流程
  let state = '';
  try { state = new URL(authorize_url).searchParams.get('state') || ''; } catch {}
  pendingFlows.set(flow_id, { pollToken, createdAt: Date.now(), provider, state });
  writeFlows(pendingFlows);
  log(`onboard flow 已创建 ${flow_id} (provider=${provider})`);
  sendJson(res, 200, { flowId: flow_id, authorizeUrl: authorize_url, expiresAt: expires_at, pollIntervalSec: poll_interval_sec, provider });
}

/**
 * 轮询上游授权状态，ready 时完成入库/领额度。
 * 返回 { http, body } 由调用方 sendJson —— 永远快速返回 JSON，绝不悬挂，
 * 否则反代（nginx 默认 60s read_timeout）会先吐 HTML 502，面板只能看到笼统报错。
 */
async function pollOnboardFlow(flowId, flow) {
  let j;
  try {
    const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
      headers: { authorization: `Bearer ${flow.pollToken}` },
      signal: AbortSignal.timeout(8000),
    });
    j = await safeJson(r);
  } catch (e) {
    return { http: 503, body: { error: `上游暂时不可达（${e.message}），会继续自动重试`, code: 'upstream_unreachable' } };
  }
  // 上游返回了非 JSON（限流 429 / 网关页）：瞬态，让面板继续等
  if (j.__error) return { http: 503, body: { error: `上游响应异常（HTTP ${j.__status}），会继续自动重试`, code: 'upstream_unreachable' } };
  // 3004 = flow 不存在/已过期/已消费，重试没有意义，让面板停下来提示重新发起
  if (j.code === 3004) return { http: 410, body: { error: '授权流程已过期或已失效，请重新发起登录', code: 'flow_missing' } };
  if (j.code !== 0) return { http: 502, body: { error: j.msg || 'poll 失败', code: 'upstream_error', raw: j } };

  const st = j.data?.status;
  if (st !== 'ready') return { http: 200, body: { status: st || 'pending' } };

  // 授权完成：拿 JWT + OAuth access_token → 入库 → 查真实身份 → 立即领取 → 回读余额
  const jwt = j.data.token;
  const uid = userIdFromJwt(jwt);
  const user = j.data.user ?? {};
  // ★ 关键：官方客户端就是从 data.zai.access_token 拿的（zai adapter），以前被我们丢掉了
  const accessToken = j.data.zai?.access_token || j.data.zai?.accessToken || null;

  // 先用官方客户档案查真实邮箱/手机号 → 国内/国际自动判定
  let customer = null;
  if (accessToken) customer = await fetchCustomerInfo(accessToken);

  let email = String(customer?.email || user.email || '').trim() || null;
  let phone = String(customer?.phoneNumber || '').trim() || null;
  let realm = realmFromCustomer(customer);
  if (realm === 'unknown') realm = realmFromIdentity(email);
  const nick = String(customer?.nickName || customer?.customerName || user.name || '').trim() || null;
  const label = nick ? `${nick}-${uid.slice(0, 8)}` : uid.slice(0, 8);

  const { added } = persistAccount(jwt, label, { email, phone, name: nick, realm, accessToken });
  pendingFlows.delete(flowId);
  writeFlows(pendingFlows);
  log(
    `授权完成 uid=${uid} 身份=${displayIdentity({ email, phone }) ?? '-'} ` +
      `归属=${REALM_ZH[realm]} access_token=${accessToken ? '已捕获' : '缺失'} added=${added}`,
  );

  accounts = readAccountFile();
  const acc = accounts.find((a) => a.uid === uid);

  let claim = null;
  let quota = null;
  if (acc) {
    // 并行跑且各自有超时：串行最坏 40s+，叠加 nginx 60s 就会 502 —— 那时账号其实已入库
    try {
      [claim, quota] = await Promise.all([
        claimFor(acc).catch((e) => ({ ok: false, msg: e.message })),
        quotaOf(acc).catch((e) => null),
      ]);
    } catch (e) {
      claim = { ok: false, msg: e.message };
    }
  }

  return {
    http: 200,
    body: {
      status: 'ready',
      added,
      label: acc?.label ?? label,
      userId: uid,
      email: acc?.email ?? email,
      phone: acc?.phone ?? phone,
      identity: acc?.identity ?? displayIdentity({ email, phone }),
      realm: acc?.realm ?? realm,
      hasAccessToken: acc?.hasAccessToken ?? !!accessToken,
      claim,
      quota,
    },
  };
}

async function handleOnboardPoll(req, res, flowId) {
  const flow = pendingFlows.get(flowId);
  if (!flow) return sendJson(res, 410, { error: 'flow 不存在或已过期，请重新发起登录', code: 'flow_missing' });
  const r = await pollOnboardFlow(flowId, flow);
  return sendJson(res, r.http, r.body);
}

/** 粘贴授权完成链接兑付：POST { url? / flowId? / code? + state? }
 *  浏览器授权完最后落在 zcode.z.ai/api/v1/oauth/cli/callback/<provider>?code=..&state=..
 *  —— 正常情况下浏览器自己访问它就完成了，这里允许把该链接交给服务端代访一次，
 *  用来兜「浏览器到上游回调不通」的场景；code 已被浏览器消费过也没关系，直接落到 poll。
 *  流程定位顺序：显式 flowId → 按链接里的 state 反查 → 待决流程只有一个时兜底。 */
async function handleOnboardRedeem(req, res) {
  const raw = await readBody(req);
  let body = {};
  try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {}

  let code = String(body.code || '').trim();
  let state = String(body.state || '').trim();
  const pasted = String(body.url || '').trim();
  if ((!code || !state) && pasted) {
    // 容忍三种粘贴形态：完整 URL、裸查询串 code=..&state=..、或 JSON 里直接给 code/state
    const u = /^https?:\/\//i.test(pasted) ? pasted : `https://local/?${pasted.replace(/^[?&]+/, '')}`;
    try {
      const q = new URL(u).searchParams;
      code = code || (q.get('code') || '').trim();
      state = state || (q.get('state') || '').trim();
    } catch {}
  }

  let flowId = String(body.flowId || '').trim();
  let flow = flowId ? pendingFlows.get(flowId) : null;
  if (!flow && state) {
    for (const [id, f] of pendingFlows) {
      if (f.state === state) { flowId = id; flow = f; break; }
    }
  }
  if (!flow && !flowId && pendingFlows.size === 1) {
    [flowId, flow] = [...pendingFlows.entries()][0];
  }
  if (!flow) {
    return sendJson(res, 410, {
      error: '没有匹配的授权流程：链接里的 state 过期/不认识（授权流程 20 分钟有效），请重新点「登录新账号」再走一遍',
      code: 'flow_missing',
    });
  }

  // 先裸 poll：浏览器可能已经自己完成了回调，此时绝不能再代访（坏 code 会把流程打死）
  let r = await pollOnboardFlow(flowId, flow);
  if (r.body.status !== 'pending' || !code || !state) return sendJson(res, r.http, r.body);

  // 确实还 pending 且手里有 code+state：代访一次上游 callback 再 poll 判定
  const cb = `${UPSTREAM_ORIGIN}/api/v1/oauth/cli/callback/${flow.provider || 'zai'}`
    + `?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  try {
    await fetch(cb, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000) });
    // 不看响应：code 失效/已消费/成功，统一由随后的 poll 判定真实状态
  } catch (e) {
    log(`onboard redeem 回调代访失败（继续 poll）：${e.message}`);
  }
  r = await pollOnboardFlow(flowId, flow);
  // 代访后立刻 3004 ≈ code 无效把流程打死了，提示语说清楚根因
  if (r.http === 410) {
    r.body.error = '链接无效或 code 已失效（上游已关闭该授权流程），请重新点「登录新账号」再走一遍';
  }
  return sendJson(res, r.http, r.body);
}


/** 修正账号身份信息（邮箱/手机号/昵称/归属）：POST { label, email?, name?, realm? } */
async function handleAccountUpdate(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}
  if (!body.label) return sendJson(res, 400, { error: '缺少 label' });

  const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')) : [];
  const target = arr.find((a) => (a.label || '') === body.label);
  if (!target) return sendJson(res, 404, { error: `找不到账号 ${body.label}` });

  const email = String(body.email || '').trim();
  if (email) {
    target.email = email;
    const r = realmFromIdentity(email);
    target.realm = body.realm || (r === 'unknown' ? target.realm : r);
  }
  if (body.realm === 'cn' || body.realm === 'intl') target.realm = body.realm;
  if (body.name) target.name = String(body.name).trim();
  // 手动权重：0 = 暂停该号（不参与调度，除非全部不可用兑底），默认 1
  if (body.weight !== undefined) {
    const w = Number(body.weight);
    target.weight = Number.isFinite(w) ? Math.max(0, Math.min(20, w)) : 1;
  }
  // 手动停用：true = 彻底退出调度（含全冷却兜底），与 weight=0 的软暂停不同
  if (body.disabled !== undefined) target.disabled = !!body.disabled;

  fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
  accounts = readAccountFile();
  const acc = accounts.find((a) => a.label === target.label);
  sendJson(res, 200, {
    ok: true,
    label: acc.label,
    email: acc.email,
    realm: acc.realm,
    weight: acc.weight,
    identity: acc.identity,
  });
}

/** 面板自检：不经过对外密钥鉴权，直接拿一个可用账号打一次小请求 */
async function handleSelfTest(req, res) {
  const acc = accounts.find((a) => a.available) || accounts[0];
  if (!acc) return sendJson(res, 503, { ok: false, error: '没有可用账号' });
  const started = Date.now();
  try {
    const body = buildUpstreamBody(
      { model: DEFAULT_MODEL, max_tokens: 64, messages: [{ role: 'user', content: '请只回复两个字：正常' }] },
      acc,
    );
    body.stream = false;
    const r = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: upstreamHeaders(acc),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const j = await safeJson(r);
    if (j.code && j.code !== 0) {
      return sendJson(res, 502, { ok: false, error: `${j.code} ${j.msg || ''}`, account: acc.label });
    }
    const txt = (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    markSuccess(acc);
    return sendJson(res, 200, { ok: true, account: acc.label, text: txt, ms: Date.now() - started });
  } catch (e) {
    markFailure(acc, 60_000);
    return sendJson(res, 502, { ok: false, error: e.message, account: acc.label });
  }
}

// ── 密钥 / 用量接口 ──
function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function handleKeys(req, res) {
  const active = keyDb.keys.filter((k) => !k.deleted);
  sendJson(res, 200, {
    keys: active.map(publicKey),
    total: active.length,
    masterKeyEnabled: !!GATEWAY_KEY,
    openMode: !active.length && !GATEWAY_KEY,
  });
}

async function handleKeyCreate(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: '请填写密钥名称' });

  const mat = newKeyMaterial();
  const id = (keyDb.keys.reduce((m, k) => Math.max(m, k.id || 0), 0) || 0) + 1;
  const days = Number(body.expiresInDays) || 0;
  const rec = {
    id,
    name,
    prefix: mat.prefix,
    hash: mat.hash,
    enabled: true,
    realm: ['cn', 'intl'].includes(body.realm) ? body.realm : '',
    expiresAt: days > 0 ? Date.now() + days * 86400_000 : 0,
    models: Array.isArray(body.models) ? body.models.filter(Boolean) : [],
    ipAllowlist: Array.isArray(body.ipAllowlist) ? body.ipAllowlist.filter(Boolean) : [],
    quotaTokens: Number(body.quotaTokens) || 0,
    usedTokens: 0,
    requests: 0,
    createdAt: Date.now(),
    lastUsedAt: 0,
    note: String(body.note || ''),
  };
  keyDb.keys.push(rec);
  writeKeys(keyDb);
  log(`新建密钥 ${name} (${mat.prefix}…)`);
  // 完整密钥只在这里返回一次
  sendJson(res, 200, { key: publicKey(rec), secret: mat.full });
}

async function handleKeyUpdate(req, res, id) {
  const k = keyDb.keys.find((x) => x.id === id && !x.deleted);
  if (!k) return sendJson(res, 404, { error: '密钥不存在' });
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}

  if (typeof body.name === 'string' && body.name.trim()) k.name = body.name.trim();
  if (typeof body.enabled === 'boolean') k.enabled = body.enabled;
  if (Array.isArray(body.models)) k.models = body.models.filter(Boolean);
  if (Array.isArray(body.ipAllowlist)) k.ipAllowlist = body.ipAllowlist.filter(Boolean);
  if (body.quotaTokens !== undefined) k.quotaTokens = Number(body.quotaTokens) || 0;
  if (body.realm !== undefined) k.realm = ['cn', 'intl'].includes(body.realm) ? body.realm : '';
  if (body.note !== undefined) k.note = String(body.note || '');
  if (body.expiresInDays !== undefined) {
    const d = Number(body.expiresInDays) || 0;
    k.expiresAt = d > 0 ? Date.now() + d * 86400_000 : 0;
  }
  writeKeys(keyDb);
  sendJson(res, 200, { key: publicKey(k) });
}

function handleKeyDelete(req, res, id) {
  const k = keyDb.keys.find((x) => x.id === id && !x.deleted);
  if (!k) return sendJson(res, 404, { error: '密钥不存在' });
  // 软删除：只标记，不物理删文件（便于审计与误删恢复）
  k.deleted = true;
  k.enabled = false;
  k.deletedAt = Date.now();
  writeKeys(keyDb);
  log(`密钥 ${k.name} 已删除（软删除）`);
  sendJson(res, 200, { ok: true, id });
}

function handleKeyReset(req, res, id) {
  const k = keyDb.keys.find((x) => x.id === id && !x.deleted);
  if (!k) return sendJson(res, 404, { error: '密钥不存在' });
  k.usedTokens = 0;
  k.requests = 0;
  writeKeys(keyDb);
  sendJson(res, 200, { key: publicKey(k) });
}

function handleStats(req, res, url) {
  const range = url.searchParams.get('range') || 'today';
  const now = Date.now();
  let from;
  let bucketMs;
  let count;
  if (range === '7d') {
    from = startOfDay(now - 6 * 86400_000);
    bucketMs = 86400_000;
    count = 7;
  } else if (range === '14d') {
    from = startOfDay(now - 13 * 86400_000);
    bucketMs = 86400_000;
    count = 14;
  } else if (range === '30d') {
    from = startOfDay(now - 29 * 86400_000);
    bucketMs = 86400_000;
    count = 30;
  } else {
    from = startOfDay(now);
    bucketMs = 3600_000;
    count = 24;
  }
  const buckets = Array.from({ length: count }, (_, i) => ({
    t: from + i * bucketMs,
    requests: 0,
    tokens: 0,
    fails: 0,
  }));

  const rows = usageLog.filter((r) => r.t >= from);
  const byModel = new Map();
  const byKey = new Map();
  const byAccount = new Map();
  const totals = { requests: 0, ok: 0, fail: 0, in: 0, out: 0, cacheRead: 0, cacheCreate: 0, tokens: 0, msSum: 0 };

  const bump = (map, key, r) => {
    const cur = map.get(key) ?? { name: key, requests: 0, tokens: 0, in: 0, out: 0, cacheRead: 0, cacheCreate: 0, fail: 0 };
    cur.requests += 1;
    cur.in += r.in || 0;
    cur.out += r.out || 0;
    cur.cacheRead += r.cacheRead || 0;
    cur.cacheCreate += r.cacheCreate || 0;
    cur.tokens += (r.in || 0) + (r.out || 0) + (r.cacheRead || 0) + (r.cacheCreate || 0);
    if (!r.ok) cur.fail += 1;
    map.set(key, cur);
  };

  for (const r of rows) {
    const toks = (r.in || 0) + (r.out || 0) + (r.cacheRead || 0) + (r.cacheCreate || 0);
    totals.requests += 1;
    totals.ok += r.ok ? 1 : 0;
    totals.fail += r.ok ? 0 : 1;
    totals.in += r.in || 0;
    totals.out += r.out || 0;
    totals.cacheRead += r.cacheRead || 0;
    totals.cacheCreate += r.cacheCreate || 0;
    totals.tokens += toks;
    totals.msSum += r.ms || 0;
    const bi = Math.floor((r.t - from) / bucketMs);
    if (buckets[bi]) {
      buckets[bi].requests += 1;
      buckets[bi].tokens += toks;
      if (!r.ok) buckets[bi].fails += 1;
    }
    bump(byModel, r.model || 'unknown', r);
    bump(byKey, r.key || 'master', r);
    bump(byAccount, r.acc || '-', r);
  }

  const promptTotal = totals.in + totals.cacheRead + totals.cacheCreate;
  sendJson(res, 200, {
    range,
    from,
    to: now,
    bucketMs,
    totals: {
      ...totals,
      avgMs: totals.requests ? Math.round(totals.msSum / totals.requests) : 0,
      cacheHitRate: promptTotal ? Math.round((totals.cacheRead / promptTotal) * 1000) / 10 : 0,
    },
    buckets,
    byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    byKey: [...byKey.values()].sort((a, b) => b.tokens - a.tokens),
    byAccount: [...byAccount.values()].sort((a, b) => b.tokens - a.tokens),
    recent: rows.slice(-50).reverse(),
  });
}

function handleLogs(req, res, url) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
  const key = url.searchParams.get('key');
  const acc = url.searchParams.get('acc');
  const model = url.searchParams.get('model');
  let rows = usageLog;
  if (key) rows = rows.filter((r) => r.key === key);
  if (acc) rows = rows.filter((r) => r.acc === acc);
  if (model) rows = rows.filter((r) => r.model === model);
  sendJson(res, 200, { total: rows.length, logs: rows.slice(-limit).reverse() });
}

/** 在线修改调度参数（面板「轮换设置」弹窗） */
async function handlePoolSettings(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}
  const applied = applyPoolSettings(body);
  sendJson(res, 200, { ok: true, applied, pool: POOL });
}

/** IP 管控规则增删与开关（面板「安全」页） */
async function handleSecurityUpdate(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {}
  const out = { toggled: false, ruleAdded: false, ruleRemoved: -1 };
  if (typeof body.enabled === 'boolean') { security.enabled = body.enabled; out.toggled = true; }
  if (body.mode === 'blacklist' || body.mode === 'whitelist') security.mode = body.mode;
  if (body.action === 'add' && body.cidr) {
    const cidr = String(body.cidr).trim();
    const type = body.type === 'allow' ? 'allow' : 'deny';
    if (!/^[\da-fA-F.:]+\/\d{1,3}$/.test(cidr) && !/^[\da-fA-F.:]+$/.test(cidr)) {
      return sendJson(res, 400, { error: 'IP/CIDR 格式不对' });
    }
    security.rules.push({ type, cidr: cidr.includes('/') ? cidr : `${cidr}/32`, note: String(body.note || ''), createdAt: Date.now() });
    out.ruleAdded = true;
  }
  if (body.action === 'remove' && body.index !== undefined) {
    const i = Number(body.index);
    if (security.rules[i]) { security.rules.splice(i, 1); out.ruleRemoved = i; }
  }
  saveSecurity();
  log(`[security] enabled=${security.enabled} mode=${security.mode} rules=${security.rules.length}`);
  sendJson(res, 200, { ok: true, ...out, security: { enabled: security.enabled, mode: security.mode, rules: security.rules } });
}

/** 面板登录：POST { key } —— 与 PANEL_KEY 恒等比较，通过后签发 7 天会话 cookie */
async function handlePanelLogin(req, res) {
  const raw = await readBody(req);
  let body = {};
  try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {}
  const key = String(body.key || '');
  if (!PANEL_KEY) return sendJson(res, 400, { error: '未设置 PANEL_KEY，面板处于免登录模式' });
  let ok = false;
  try {
    ok = key.length === PANEL_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(PANEL_KEY));
  } catch {}
  if (!ok) return sendJson(res, 401, { error: '管理密钥不正确', code: 'panel_auth' });
  const exp = Date.now() + PANEL_TTL_MS;
  res.setHeader('set-cookie', `${PANEL_COOKIE}=${exp}.${panelSign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(PANEL_TTL_MS / 1000)}`);
  log('面板登录成功');
  return sendJson(res, 200, { ok: true });
}

// ── 控制台 API（/api/*，cnb2api-console 同款契约）──
const DIST_DIR = path.join(import.meta.dirname, 'web', 'dist');
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveDistFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': STATIC_MIME[ext] || 'application/octet-stream',
    'content-length': buf.length,
    ...(ext === '.html' ? { 'cache-control': 'no-store, must-revalidate' } : { 'cache-control': 'public, max-age=86400' }),
  });
  res.end(buf);
}

/** 托管 web/dist 构建产物；dist 不存在时回退旧版单文件面板。返回 true 表示已处理。 */
function serveConsoleStatic(req, res, pathname) {
  const indexFile = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(indexFile)) return false;
  if (pathname === '/' || pathname === '/dashboard' || pathname === '/index.html') {
    serveDistFile(res, indexFile);
    return true;
  }
  const candidate = path.resolve(DIST_DIR, '.' + pathname);
  if (candidate.startsWith(DIST_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    serveDistFile(res, candidate);
    return true;
  }
  return false;
}

function accountQuotaSnapshot(a) {
  const qc = quotaCache.get(a.label);
  if (!qc) return null;
  const total = Number(qc.total) || 0;
  const remaining = Math.max(0, Number(qc.remaining) || 0);
  const used = Math.max(0, total - remaining);
  return {
    org: a.label,
    credits: { total, used, freeze: 0 },
    dev: { total: 0, used: 0, freeze: 0 },
    ci: { total: 0, used: 0 },
    syncedAt: new Date(qc.ts || Date.now()).toISOString(),
  };
}

/** 汇聚成 cnb2api-console 的 Overview 形状（accounts/settings/hourly/stats）。 */
function buildOverview() {
  const now = Date.now();
  const usageBy = new Map();
  for (const r of usageLog) {
    const k = r.acc ?? '-';
    const cur = usageBy.get(k) ?? { requests: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    cur.requests++;
    if (!r.ok) cur.errors++;
    cur.input += r.in || 0;
    cur.output += r.out || 0;
    cur.cacheRead += r.cacheRead || 0;
    cur.cacheCreate += r.cacheCreate || 0;
    usageBy.set(k, cur);
  }
  const hourMs = 3600_000;
  const hourly = [];
  for (let i = 23; i >= 0; i--) {
    const start = Math.floor((now - i * hourMs) / hourMs) * hourMs;
    hourly.push({ at: new Date(start).toISOString(), requests: 0, errors: 0, durationMs: 0, accounts: {}, _ms: 0, _n: 0 });
  }
  const byHour = new Map(hourly.map((b) => [b.at, b]));
  let todayStart = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  const todayAgg = { requests: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, msSum: 0 };
  for (const r of usageLog) {
    if (r.t < now - 24 * hourMs) continue;
    const start = Math.floor(r.t / hourMs) * hourMs;
    const b = byHour.get(new Date(start).toISOString());
    if (!b) continue;
    b.requests++;
    if (!r.ok) b.errors++;
    b._ms += r.ms || 0;
    b._n++;
    const k = r.acc ?? '-';
    b.accounts[k] = (b.accounts[k] || 0) + 1;
  }
  for (const b of hourly) {
    b.durationMs = b._n ? Math.round(b._ms / b._n) : 0;
    delete b._ms;
    delete b._n;
  }
  for (const r of usageLog) {
    if (r.t < todayStart) continue;
    todayAgg.requests++;
    if (!r.ok) todayAgg.errors++;
    todayAgg.input += r.in || 0;
    todayAgg.output += r.out || 0;
    todayAgg.cacheRead += r.cacheRead || 0;
    todayAgg.cacheCreate += r.cacheCreate || 0;
    todayAgg.msSum += r.ms || 0;
  }
  const totalAgg = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const r of usageLog) {
    totalAgg.input += r.in || 0;
    totalAgg.output += r.out || 0;
    totalAgg.cacheRead += r.cacheRead || 0;
    totalAgg.cacheCreate += r.cacheCreate || 0;
  }
  const tokenTotals = (src, reported) => ({
    input: src.input || 0,
    output: src.output || 0,
    cacheRead: src.cacheRead || 0,
    cacheWrite: src.cacheCreate || 0,
    total: (src.input || 0) + (src.output || 0),
    reportedRequests: reported,
    missingRequests: 0,
    partialRequests: 0,
  });
  const startedAt = usageLog.length ? new Date(usageLog[0].t).toISOString() : new Date(now).toISOString();

  const mapped = accounts.map((a) => {
    const u = usageBy.get(a.label) ?? usageBy.get('-') ?? { requests: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    const iso = (ms) => (ms && ms > 0 ? new Date(ms).toISOString() : null);
    const cooling = a.cooldownUntil > now;
    const status = a.disabled ? 'pending' : cooling || a.degradeUntil > now ? 'unhealthy' : a.cooldownUntil <= now && a.degradeUntil <= now ? 'healthy' : 'unhealthy';
    return {
      id: a.label,
      name: a.name || a.label,
      label: a.label,
      uid: a.uid,
      group: a.realm === 'cn' ? '国内版' : a.realm === 'intl' ? '国际版' : '未标注',
      realm: a.realm ?? 'unknown',
      identity: a.identity ?? null,
      email: a.email ?? null,
      phone: a.phone ?? null,
      weight: Math.round(weightOf(a, Math.max(1, quotaCache.get(a.label)?.remaining || 0), now) * 10) / 10,
      manualWeight: a.weight ?? 1,
      priority: 1,
      enabled: !a.disabled,
      disabled: !!a.disabled,
      hasAccessToken: !!a.hasAccessToken,
      status,
      checkedAt: iso(a.lastSuccess),
      registeredAt: iso(a.lastSuccess),
      cooldownUntil: iso(a.cooldownUntil),
      cooldownMin: cooling ? Math.ceil((a.cooldownUntil - now) / 60000) : 0,
      failures: a.failures || 0,
      latencyMs: null,
      lastError: a.lastErr || '',
      quota: accountQuotaSnapshot(a),
      quotaSources: ['billing', 'coding'].map((id) => quotaSources.get(a.label)?.[id] || {
        id, name: sourceName(a, id), status: 'pending', plans: [], syncedAt: null, error: null,
      }),
      eligibility: eligibilityCache.get(a.label) || null,
      hasCodingPlanKey: !!a.codingPlanApiKey,
      codingPlanProvider: a.codingPlanProvider || (a.realm === 'cn' ? 'bigmodel' : 'zai'),
      plans: (quotaCache.get(a.label)?.plans || []).filter((p) => p.status === 'active'),
      requests: u.requests,
      errors: u.errors,
      activeRequests: a.inFlight || 0,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      tokenUsage: tokenTotals(u, u.requests),
    };
  });
  const quotaAccounts = mapped.filter((m) => m.quota);
  const remainingCredits = quotaAccounts.reduce((s, m) => s + Math.max(0, m.quota.credits.total - m.quota.credits.used - m.quota.credits.freeze), 0);
  const totalCredits = quotaAccounts.reduce((s, m) => s + m.quota.credits.total, 0);
  const stats = {
    total: mapped.length,
    ready: mapped.filter((m) => m.enabled && m.status === 'healthy').length,
    cooling: mapped.filter((m) => m.cooldownUntil && Date.parse(m.cooldownUntil) > now).length,
    disabled: mapped.filter((m) => !m.enabled).length,
    requests: todayAgg.requests,
    errors: todayAgg.errors,
    successRate: todayAgg.requests ? Math.round(((todayAgg.requests - todayAgg.errors) / todayAgg.requests) * 1000) / 10 : null,
    remainingCredits: quotaAccounts.length ? remainingCredits : null,
    totalCredits: quotaAccounts.length ? totalCredits : null,
    quotaOrganizations: quotaAccounts.length,
    averageDurationMs: todayAgg.requests ? Math.round(todayAgg.msSum / todayAgg.requests) : null,
    activeRequests: accounts.reduce((s, a) => s + (a.inFlight || 0), 0),
    tokenUsage: { today: tokenTotals(todayAgg, todayAgg.requests), total: tokenTotals(totalAgg, usageLog.length), startedAt },
  };
  const settings = {
    strategy: 'weighted',
    sessionAffinity: POOL.stickyTtlMin > 0,
    stickyTtlMin: POOL.stickyTtlMin,
    topN: POOL.topN,
    maxInFlight: POOL.maxInFlight,
    breakerThreshold: POOL.breakerThreshold,
    breakerCooldownMin: POOL.breakerCooldownMin,
    blockedCooldownMin: POOL.blockedCooldownMin,
    quotaCooldownMin: POOL.quotaCooldownMin,
    busyCooldownSec: POOL.busyCooldownSec,
    minPickGapMs: POOL.minPickGapMs,
    idleWeightPerHour: POOL.idleWeightPerHour,
    idleWeightMax: POOL.idleWeightMax,
    weightBalFactor: POOL.weightBalFactor,
    weightSuccFactor: POOL.weightSuccFactor,
    weekendGrab: true,
    limits: POOL_LIMITS,
  };
  return { accounts: mapped, settings, hourly, stats };
}

async function handleConsoleApi(req, res, url) {
  const p = url.pathname;
  // GET /api/overview —— 控制台主数据（cnb2api-console Overview 契约）
  if (req.method === 'GET' && p === '/api/overview') {
    return sendJson(res, 200, buildOverview());
  }
  // GET /api/logs —— q/outcome 过滤 + 分页 + 导出
  if (req.method === 'GET' && p === '/api/logs') {
    const download = url.searchParams.get('download') === '1';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 500);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const outcome = url.searchParams.get('outcome') || 'all';
    let rows = usageLog.slice().reverse().map((r, i) => ({
      id: `req-${r.t}-${usageLog.length - i}`,
      at: new Date(r.t).toISOString(),
      kind: 'request',
      accountId: r.acc ?? null,
      accountName: r.acc ?? '-',
      status: r.ok ? 200 : 502,
      ok: !!r.ok,
      err: r.err || null,
      message: r.err
        ? `${r.model ?? ''} ${r.err}`.trim() || '请求失败'
        : `${r.model ?? ''} 完成`.trim() || '请求完成',
      ip: r.ip ?? null,
      model: r.model ?? null,
      durationMs: r.ms ?? null,
      tokenUsage: {
        input: r.in || 0, output: r.out || 0, cacheRead: r.cacheRead || 0, cacheWrite: r.cacheCreate || 0,
        total: (r.in || 0) + (r.out || 0), reportedRequests: 1, missingRequests: 0, partialRequests: 0,
      },
    }));
    if (q) {
      rows = rows.filter((r) =>
        `${r.accountName} ${r.model ?? ''} ${r.ip ?? ''} ${r.message}`.toLowerCase().includes(q),
      );
    }
    if (outcome === 'success') rows = rows.filter((r) => r.ok);
    if (outcome === 'failure') rows = rows.filter((r) => !r.ok);
    if (download) {
      const buf = Buffer.from(JSON.stringify({ total: rows.length, logs: rows.slice(offset, offset + 1000) }, null, 2));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="requests-logs.json"',
        'content-length': buf.length,
      });
      return res.end(buf);
    }
    return sendJson(res, 200, { logs: rows.slice(offset, offset + limit), total: rows.length, limit, offset });
  }
  // GET /api/captcha/config —— 前端阿里云验证码 SDK 初始化参数（对齐 zcode-switch claim_captcha_config）
  if (req.method === 'GET' && p === '/api/captcha/config') {
    return sendJson(res, 200, await captchaConfig());
  }
  // GET /api/models
  if (req.method === 'GET' && p === '/api/models') {
    const models = [
      { id: 'GLM-5.3-Flash', name: 'GLM-5.3 Flash' },
      { id: 'GLM-5.3', name: 'GLM-5.3' },
      ...(process.env.ZCODE_EXTRA_MODELS || '').split(',').filter(Boolean).map((m) => ({ id: m.trim(), name: m.trim() })),
    ];
    const enabled = accounts.filter((a) => !a.disabled);
    return sendJson(res, 200, {
      models: models.map((m) => ({
        id: m.id,
        listed: true,
        configuredAccounts: enabled.map((a) => ({ id: a.label, name: a.name || a.label })),
        discoveredAccounts: [],
        eligibleAccounts: enabled.filter((a) => !a.cooldownUntil || a.cooldownUntil <= Date.now()).map((a) => ({ id: a.label, name: a.name || a.label })),
      })),
    });
  }
  // GET /api/access + POST /api/access/key
  if (req.method === 'GET' && p === '/api/access') {
    const masked = GATEWAY_KEY ? `${GATEWAY_KEY.slice(0, 6)}${'•'.repeat(18)}${GATEWAY_KEY.slice(-4)}` : '未设置 GATEWAY_KEY（开放模式）';
    return sendJson(res, 200, {
      publicUrl: '',
      maskedKey: masked,
      gatewayKeySet: !!GATEWAY_KEY,
      models: [
        { id: 'GLM-5.3-Flash', name: 'GLM-5.3 Flash', context: 1000000, maxOutput: 131072 },
        { id: 'GLM-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 131072 },
      ],
    });
  }
  if (req.method === 'POST' && p === '/api/access/key') {
    if (!GATEWAY_KEY) return sendJson(res, 404, { error: '未设置 GATEWAY_KEY（当前为开放模式，无需密钥）' });
    return sendJson(res, 200, { key: GATEWAY_KEY });
  }
  // PATCH /api/accounts/:id —— 启用停用 + 身份字段
  const mAcc = p.match(/^\/api\/accounts\/(.+?)(?:\/(selftest|claim|refresh))?$/);
  if (mAcc) {
    const id = decodeURIComponent(mAcc[1]);
    const sub = mAcc[2];
    if (sub === 'refresh' && req.method === 'POST') {
      const acc = accounts.find((a) => a.label === id);
      if (!acc) return sendJson(res, 404, { error: '找不到账号' });
      const [sources, eligibility] = await Promise.all([refreshQuotaAccount(acc), refreshEligibility(acc)]);
      return sendJson(res, 200, { quotaSources: sources, eligibility });
    }
    if (sub === 'selftest' && req.method === 'POST') {
      const acc = accounts.find((a) => a.label === id);
      if (!acc) return sendJson(res, 404, { ok: false, error: `找不到账号 ${id}` });
      if (acc.disabled) return sendJson(res, 502, { ok: false, error: '账号已停用', account: id });
      const started = Date.now();
      try {
        const body = buildUpstreamBody(
          { model: DEFAULT_MODEL, max_tokens: 64, messages: [{ role: 'user', content: '请只回复两个字：正常' }] },
          acc,
        );
        body.stream = false;
        const r = await fetch(UPSTREAM_URL, {
          method: 'POST',
          headers: upstreamHeaders(acc),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        const j = await safeJson(r);
        if (j.code && j.code !== 0) return sendJson(res, 502, { ok: false, error: `${j.code} ${j.msg || ''}`, account: id });
        const txt = (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
        markSuccess(acc);
        return sendJson(res, 200, { ok: true, account: id, text: txt, ms: Date.now() - started });
      } catch (e) {
        markFailure(acc, 60_000);
        return sendJson(res, 502, { ok: false, error: e.message, account: id });
      }
    }
    if (sub === 'claim' && req.method === 'POST') {
      return handleClaim(req, res, id);
    }
    if (req.method === 'PATCH') {
      const raw = await readBody(req);
      let body = {};
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {}
      const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')) : [];
      const target = arr.find((a) => (a.label || '') === id);
      if (!target) return sendJson(res, 404, { error: `找不到账号 ${id}` });
      if (body.codingPlanApiKey !== undefined) {
        if (typeof body.codingPlanApiKey !== 'string' || body.codingPlanApiKey.length > 4096) return sendJson(res, 400, { error: 'Coding Plan API Key 格式不正确' });
        target.codingPlanApiKey = body.codingPlanApiKey.trim();
      }
      if (body.codingPlanProvider === 'zai' || body.codingPlanProvider === 'bigmodel') target.codingPlanProvider = body.codingPlanProvider;
      if (body.enabled !== undefined) target.disabled = !body.enabled;
      const email = String(body.email || '').trim();
      if (email) {
        target.email = email;
        const r = realmFromIdentity(email);
        target.realm = body.realm || (r === 'unknown' ? target.realm : r);
      }
      if (body.realm === 'cn' || body.realm === 'intl') target.realm = body.realm;
      if (body.name) target.name = String(body.name).trim();
      if (body.weight !== undefined) {
        const w = Number(body.weight);
        target.weight = Number.isFinite(w) ? Math.max(0, Math.min(20, w)) : 1;
      }
      fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
      // Editing quota credentials must not reset scheduler cooldowns or in-flight counts.
      const previousAccounts = new Map(accounts.map((a) => [a.label, a]));
      accounts = readAccountFile().map((a) => {
        const previous = previousAccounts.get(a.label);
        if (!previous) return a;
        const runtime = Object.fromEntries(['cooldownUntil', 'failures', 'consecutiveFails', 'inFlight', 'degradeUntil', 'lastSuccess', 'lastErr'].map((field) => [field, previous[field]]));
        return Object.assign(previous, a, runtime);
      });
      if (body.codingPlanApiKey !== undefined || body.codingPlanProvider !== undefined) {
        const acc = accounts.find((a) => a.label === id);
        await accountRefreshes.get(`${id}:coding`);
        const sources = quotaSources.get(id);
        if (sources) delete sources.coding;
        await refreshQuotaSource(acc, 'coding');
      }
      return sendJson(res, 200, { ok: true, account: id });
    }
  }
  // PATCH /api/settings —— 调度参数
  if (req.method === 'PATCH' && p === '/api/settings') {
    const raw = await readBody(req);
    let body = {};
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {}
    const applied = applyPoolSettings(body);
    return sendJson(res, 200, { ok: true, applied, settings: buildOverview().settings });
  }
  return sendJson(res, 404, { error: `no console api route ${req.method} ${p}` });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // ── 面板控制台会话（cnb2api-console 契约 + 旧 /panel/* 兼容）──
  if (url.pathname === '/api/auth/config') {
    return sendJson(res, 200, { keyLoginEnabled: true, sso: { enabled: false, providerName: '', loginUrl: '' } });
  }
  if (url.pathname === '/api/session' || url.pathname === '/panel/session') {
    if (req.method === 'POST') return handlePanelLogin(req, res);
    if (req.method === 'DELETE') {
      res.setHeader('set-cookie', `${PANEL_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }
    const authed = panelAuthed(req);
    // 未登录返回 401：前端 establishSession() 靠抛异常进入登录页（cnb2api 同款契约）
    if (!authed) return sendJson(res, 401, { authenticated: false, error: '面板未登录', code: 'panel_auth' });
    return sendJson(res, 200, { authenticated: true, user: { name: '管理员', email: '', picture: '', provider: 'key' } });
  }
  if (url.pathname === '/panel/state') {
    return sendJson(res, 200, { authRequired: !!PANEL_KEY, authed: panelAuthed(req) });
  }
  // ── 鉴权门：数据面永远放行，控制台其余端点在设置 PANEL_KEY 后要求登录 ──
  const dataPlane =
    url.pathname === '/health' ||
    url.pathname === '/' ||
    url.pathname === '/dashboard' ||
    url.pathname.startsWith('/v1/') ||
    url.pathname === '/models' ||
    url.pathname === '/messages' ||
    url.pathname === '/chat/completions' ||
    url.pathname === '/api/auth/config' ||
    url.pathname.startsWith('/api/session') ||
    url.pathname.startsWith('/panel/session');
  if (PANEL_KEY && !dataPlane && !panelAuthed(req)) {
    return sendJson(res, 401, { error: '面板未登录或会话已过期', code: 'panel_auth' });
  }
  // ── 控制台 API（/api 前缀）──
  if (url.pathname.startsWith('/api/')) return handleConsoleApi(req, res, url);
  // ── 静态资源：web/dist 构建产物优先，缺失时回退旧版单文件面板 ──
  if (req.method === 'GET' && serveConsoleStatic(req, res, url.pathname)) return;
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    const f = path.join(import.meta.dirname, 'dashboard.html');
    if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'dashboard.html 缺失' });
    const buf = fs.readFileSync(f);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store, must-revalidate',
    });
    return res.end(buf);
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      version: GATEWAY_VERSION,
      accounts: accounts.length,
      keys: keyDb.keys.filter((k) => !k.deleted).length,
      upstream: UPSTREAM_URL,
      defaultModel: DEFAULT_MODEL,
      models: [DEFAULT_MODEL],
    });
  }
  if (req.method === 'GET' && url.pathname === '/pool/settings') {
    return sendJson(res, 200, {
      settings: {
        maxInFlight: POOL.maxInFlight,
        breakerThreshold: POOL.breakerThreshold,
        breakerCooldownMin: POOL.breakerCooldownMin,
        blockedCooldownMin: POOL.blockedCooldownMin,
        quotaCooldownMin: POOL.quotaCooldownMin,
        busyCooldownSec: POOL.busyCooldownSec,
        stickyTtlMin: POOL.stickyTtlMin,
        topN: POOL.topN,
        idleWeightPerHour: POOL.idleWeightPerHour,
        idleWeightMax: POOL.idleWeightMax,
        minPickGapMs: POOL.minPickGapMs,
        weightBalFactor: POOL.weightBalFactor,
        weightSuccFactor: POOL.weightSuccFactor,
      },
      limits: POOL_LIMITS,
      fromFile: !!POOL.__fromFile,
    });
  }
  if (req.method === 'POST' && url.pathname === '/pool/settings') return handlePoolSettings(req, res);
  if (req.method === 'GET' && url.pathname === '/security') {
    return sendJson(res, 200, {
      enabled: security.enabled,
      mode: security.mode,
      rules: security.rules,
      blocked: security.blockedLog.slice(-200).reverse(),
      blockedTotal: security.blockedLog.length,
    });
  }
  if (req.method === 'POST' && url.pathname === '/security') return handleSecurityUpdate(req, res);
  if (req.method === 'POST' && url.pathname === '/security/clear-blocked') {
    security.blockedLog = [];
    saveSecurity();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/pool/reset') {
    for (const a of accounts) {
      a.cooldownUntil = 0;
      a.degradeUntil = 0;
      a.consecutiveFails = 0;
      a.failures = 0;
      a.lastErr = null;
    }
    sticky.clear();
    log('已重置所有账号冷却');
    return sendJson(res, 200, { ok: true, accounts: accounts.length });
  }
  if (req.method === 'GET' && url.pathname === '/pool') return handlePool(req, res);
  if (req.method === 'GET' && url.pathname === '/keys') return handleKeys(req, res);
  if (req.method === 'POST' && url.pathname === '/keys') return handleKeyCreate(req, res);
  {
    const m = url.pathname.match(/^\/keys\/(\d+)\/(update|delete|reset)$/);
    if (m && req.method === 'POST') {
      const id = Number(m[1]);
      if (m[2] === 'update') return handleKeyUpdate(req, res, id);
      if (m[2] === 'delete') return handleKeyDelete(req, res, id);
      return handleKeyReset(req, res, id);
    }
  }
  if (req.method === 'GET' && url.pathname === '/stats') return handleStats(req, res, url);
  if (req.method === 'POST' && url.pathname === '/selftest') return handleSelfTest(req, res);
  if (req.method === 'GET' && url.pathname === '/logs') return handleLogs(req, res, url);
  if (req.method === 'GET' && url.pathname === '/quota') return handleQuota(req, res);
  if (req.method === 'GET' && url.pathname === '/claimable') return handleClaimable(req, res);
  if (req.method === 'POST' && url.pathname === '/claim') return handleClaim(req, res);
  if (req.method === 'POST' && url.pathname === '/accounts/identify') return handleIdentifyAll(req, res);
  if (req.method === 'POST' && url.pathname === '/accounts/add') return handleAccountAdd(req, res);
  if (req.method === 'POST' && url.pathname === '/accounts/update') return handleAccountUpdate(req, res);
  if (req.method === 'POST' && url.pathname === '/onboard/start') return handleOnboardStart(req, res);
  if (req.method === 'POST' && url.pathname === '/onboard/redeem') return handleOnboardRedeem(req, res);
  if (req.method === 'GET' && url.pathname.startsWith('/onboard/poll/')) {
    return handleOnboardPoll(req, res, decodeURIComponent(url.pathname.slice('/onboard/poll/'.length)));
  }
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    // OpenAI 风格模型列表；带 ?api=anthropic 时返回 Anthropic 风格
    const anthropicStyle = url.searchParams.get('api') === 'anthropic';
    const now = Math.floor(Date.now() / 1000);
    const models = [
      { id: 'GLM-5.3-Flash', name: 'GLM-5.3 Flash', context: 1000000, maxOutput: 131072 },
      { id: 'GLM-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 131072 },
      ...(process.env.ZCODE_EXTRA_MODELS || '').split(',').filter(Boolean).map((m) => ({ id: m.trim(), name: m.trim(), context: 1000000, maxOutput: 131072 })),
    ];
    if (anthropicStyle) {
      return sendJson(res, 200, { data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.name, created_at: '2026-01-01T00:00:00Z', context_window: m.context, max_output_tokens: m.maxOutput })) });
    }
    return sendJson(res, 200, {
      object: 'list',
      data: models.map((m) => ({ id: m.id, object: 'model', created: now, owned_by: 'zcode2api', context_window: m.context, max_output_tokens: m.maxOutput })),
    });
  }
  // /v1/v1/* 双重前缀兼容：用户 baseUrl 误带 /v1 时（Anthropic adapter 会再拼 /v1/messages）
  const path1 = url.pathname.replace(/^\/v1\/v1/, '/v1');
  if (req.method === 'POST' && (path1 === '/v1/chat/completions' || path1 === '/chat/completions')) {
    return handleOpenAIChat(req, res).catch((e) => {
      log('openai handler error:', e);
      if (!res.headersSent) sendJson(res, 500, { error: { message: e.message, type: 'api_error' } });
      else res.end();
    });
  }
  if (req.method === 'POST' && (path1 === '/v1/messages' || path1 === '/messages')) {
    return handleMessages(req, res).catch((e) => {
      log('handler error:', e);
      if (!res.headersSent) sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: e.message } });
      else res.end();
    });
  }
  sendJson(res, 404, { type: 'error', error: { type: 'not_found', message: `no route ${req.method} ${url.pathname}` } });
});

server.listen(PORT, HOST, () => {
  log(`zcgw-server listening on http://${HOST}:${PORT}`);
  log(`accounts: ${accounts.length ? accounts.map((a) => a.label).join(', ') : '(空) —— 打开面板点「登录新账号」纳管账号'}`);
  log(`gateway key: ${GATEWAY_KEY ? '(set)' : '(WARNING: 未设置，任何人可用)'}`);
  log(`scheduler: weighted-random topN=${POOL.topN} sticky=${POOL.stickyTtlMin}min`);

  // 服务器生产环境自检提示（一次性）
  if (HOST === '0.0.0.0') {
    if (!GATEWAY_KEY && keyDb.keys.filter((k) => !k.deleted).length === 0) {
      log('WARNING: 监听 0.0.0.0 且没有任何密钥 —— 任何人都能白嫖你的账号池！');
      log('         服务器部署请在面板「密钥」里建一把 key，或设置 GATEWAY_KEY 环境变量');
    }
    if (!GATEWAY_KEY && keyDb.keys.filter((k) => !k.deleted).length > 0) {
      log(`已启用密钥鉴权（${keyDb.keys.filter((k) => !k.deleted).length} 把），未带 key 的请求将被 401`);
    }
  }

  // 恢复上次的调度状态（冷却/降权/成功率），再启动后台余额刷新喂权重
  loadPoolState();
  const refreshQuotaWeights = async () => {
    try {
      for (const acc of accounts) await refreshQuotaAccount(acc);
    } catch {}
  };
  setTimeout(refreshQuotaWeights, 3000);
  setInterval(refreshQuotaWeights, 10 * 60_000); // 每 10 分钟刷一次权重缓存
  setInterval(savePoolState, 60_000); // 每分钟落盘一次调度状态

  // 周末额度自动抢领：周五 18:00 ～ 周日 24:00（北京时间）每 10 分钟试一轮，
  // 抢到即停；名额开闸第一时间拿到，避免 1005 名额已用完
  const WEEKEND_GRAB = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pool-settings.json'), 'utf8')).weekendGrab ?? true; }
    catch { return true; }
  })();
  if (WEEKEND_GRAB) {
    const grabTick = async () => {
      try {
        const bj = new Date(Date.now() + 8 * 3600_000);
        const day = bj.getUTCDay(), hour = bj.getUTCHours();
        // 周五(5) 18 点后 / 周六(6) 全天 / 周日(0) 24 点前
        const inWindow = (day === 5 && hour >= 18) || day === 6 || (day === 0);
        if (!inWindow) return;
        // 找缺 promo 的号（有访问资格才领）；手动停用的号不碰
        for (const acc of accounts.filter((a) => !a.disabled)) {
          const active = await activeGrants(acc);
          const kinds = new Set(active.map((p) => describePlan(p.plan_id, p.name).kind));
          if (kinds.has('promo')) continue;
          const r = await fetch(`http://127.0.0.1:${PORT}/claim`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label: acc.label }),
          });
          const j = await safeJson(r);
          const x = (j.results ?? [])[0] ?? {};
          if (x.code === 'captcha_required') {
            // 上游强制人机验证，服务端后台任务拿不到验证参数 —— 首轮提示一次即可
            log('[weekend-grab] 上游 claim 需要人机验证（阿里云验证码），后台自动抢领已不可用；请从面板手动领取');
            return;
          }
          if (x.ok && !x.alreadyClaimed) log(`[weekend-grab] ${acc.label} 抢领成功：${x.claimed}`);
          else if (x.code === 1005) log(`[weekend-grab] ${acc.label} 1005 名额未开/已尽，下轮再试`);
        }
      } catch (e) {
        if (VERBOSE) log('[weekend-grab] tick error:', e.message);
      }
    };
    setInterval(grabTick, 10 * 60_000);
    setTimeout(grabTick, 15_000);
    log('weekend-grab: 周末额度自动抢领已启用（周五18:00 起）');
  }

  // 启动后自动补齐身份：先吃本地客户端的 access_token，再拿官方客户档案反查邮箱/手机号
  setTimeout(async () => {
    try {
      const seeded = seedLocalAccessToken();
      if (seeded) {
        accounts = readAccountFile();
        log(`已从本地 ZCode 客户端补入 access_token：${seeded} 个账号`);
      }
      const r = await identifyAll(true);
      if (r.withToken) log(`身份自动识别：${r.updated} 个有变更 / ${r.withToken} 个可查（共 ${r.total}）`);
      const missing = accounts.filter((a) => !a.hasAccessToken).length;
      if (missing) log(`另有 ${missing} 个账号没有 access_token，需重新授权一次才能自动识别身份`);
    } catch (e) {
      log('启动身份识别失败:', e?.message ?? String(e));
    }
  }, 700);
});

// 不让单个坏请求 / 空响应把整个网关打死
process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.message ?? String(e)));
process.on('uncaughtException', (e) => log('uncaughtException:', e?.message ?? String(e)));
