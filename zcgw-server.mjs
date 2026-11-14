#!/usr/bin/env node
/**
 * zcgw-server — 多账号版 ZCode → Anthropic 反代（服务器部署版）
 *
 * 与本地单账号版 (server.mjs) 的区别：
 *   - 不读 ~/.zcode/v2/credentials.json，改读 data/zcode.sqlite（账号表，明文 JWT）
 *   - 自动多账号轮询：3012/1005 时换下一个号重试
 *   - 对外要求 Authorization: Bearer <GATEWAY_KEY>
 *
 * 部署：
 *   首次启动若 data/ 里有旧版 accounts.json 会自动导入数据库并改名 .migrated-*.bak
 *   GATEWAY_KEY=xxx PORT=8787 node zcgw-server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeBilling } from './zcgw-quota.mjs';
import { createCodingClient, codingIdentity, codingProviderOf, oauthProviderOf, oauthTokenOf, extractOAuthToken } from './zcgw-coding.mjs';
import { createVersionManager, CLIENT_APP_VERSION } from './zcgw-version.mjs';
import { createClaimAutomation } from './zcgw-auto-claim.mjs';
import { createCaptchaBrowser } from './zcgw-captcha-browser.mjs';
import { createPanelCaptcha } from './zcgw-captcha-panel.mjs';
import { zcodeRequest, responseJson } from './zcgw-upstream.mjs';
import { billingHeaders, parseClaimPlan, parseMarketingPlans, mergeClaimPlans, parseCurrentPlans, effectiveAt, claimFailure } from './zcgw-claim.mjs';
import { metadataUserId, sessionIdFor, requestId, userIdFromJwt, deviceIdFor } from './zcgw-fingerprint.mjs';
import {
  OidcError,
  buildAuthorizationUrl,
  createTransaction,
  discoverProvider,
  exchangeAuthorizationCode,
  fetchUserInfo,
  identityFromClaims,
  isAllowed,
  safeEqual,
  verifyIdTokenForConfig,
} from './zcgw-oidc.mjs';
import { InputError, sanitizeSso, validateSso, withSsoDefaults } from './zcgw-sso.mjs';
import { ZcgwStore } from './zcgw-store.mjs';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';
// 面板访问控制：设置 PANEL_ADMIN_KEY（旧名 PANEL_KEY 仍可用）后，除 /health、/v1/*、
// 登录相关接口外的所有请求都要带会话 cookie 或管理 bearer。两者都不设置且未启用 SSO
// 时完全不拦截（本机/内网模式），不影响现有部署。
const PANEL_ADMIN_KEY = process.env.PANEL_ADMIN_KEY || process.env.PANEL_KEY || '';
// 面板对外的公网地址（带或不带路径均可，只取 origin 部分）。设置后 SSO 回调地址
// 由它推导，否则按请求的 Host 推导。
const PANEL_PUBLIC_URL = process.env.PANEL_PUBLIC_URL || '';
// 服务间管理令牌：旧部署仍可用 `Authorization: Bearer <PLATFORM_TOKEN>`。
// 新部署直接用面板管理密钥，不再需要额外的变量。
const PLATFORM_TOKEN = process.env.PLATFORM_TOKEN || '';
const PANEL_COOKIE = 'zcgw_panel';
const PANEL_TTL_MS = 7 * 86400_000;
const OIDC_COOKIE = 'zcgw_oidc';
const OIDC_TRANSACTION_MS = 10 * 60 * 1000;
// 允许 http://127.0.0.1 这类回环地址作为 issuer（仅供本机 mock 与测试；默认关闭）
const allowLocal = process.env.ZCGW_SSO_ALLOW_LOCAL === '1';

const ssoState = () => authState.sso;
/** 面板是否需要登录：配置了管理密钥或启用了 SSO。 */
const authEnabled = () => Boolean(PANEL_ADMIN_KEY) || ssoState().enabled;

// 密钥登录的会话额外绑定当前管理密钥：轮换 key 后旧 cookie 立即失效
// （与 main 分支用 PANEL_KEY 做 HMAC 密钥的效果一致）。SSO 会话不绑定它，
// 因为 SSO 会话的生命周期由 SSO 配置指纹控制。
const keyBinding = () =>
  PANEL_ADMIN_KEY
    ? crypto.createHash('sha256').update(`zcgw-key:${PANEL_ADMIN_KEY}`).digest('base64url')
    : '-';

function panelSign(expiresAt, provider = 'key', fingerprint = '') {
  return crypto
    .createHmac('sha256', authState.sessionSecret)
    .update(`zcgw-panel:${expiresAt}:${provider}:${fingerprint}:${provider === 'key' ? keyBinding() : '-'}`)
    .digest('base64url');
}

/** 会话载荷：<过期时间>.<来源 key|oidc>.<SSO 配置指纹>.<签名> */
function sessionPayload(expiresAt, provider = 'key', fingerprint = '') {
  const fp = provider === 'oidc' ? fingerprint : '-';
  return {
    expiresAt,
    provider,
    fingerprint,
    value: `${expiresAt}.${provider}.${fp}.${panelSign(expiresAt, provider, fingerprint)}`,
  };
}

function cookieValue(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9._-]+)`));
  return m ? m[1] : '';
}

/** 解析会话 cookie；返回 { provider, fingerprint } 或 null */
function sessionOf(req) {
  const raw = cookieValue(req, PANEL_COOKIE);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [expStr, provider, fp, sig] = parts;
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  if (provider !== 'key' && provider !== 'oidc') return null;
  const fingerprint = provider === 'oidc' && fp !== '-' ? fp : '';
  const expected = Buffer.from(panelSign(expiresAt, provider, fingerprint));
  const supplied = Buffer.from(sig);
  if (supplied.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(supplied, expected)) return null;
  } catch {
    return null;
  }
  return { provider, fingerprint };
}

function panelAuthed(req) {
  return sessionOf(req) !== null;
}

function safeEqualText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

// 管理 bearer：面板管理密钥，或旧的 PLATFORM_TOKEN。常量时间比较；
// 面板密钥即使关闭了密钥登录也依然有效（服务间调用路径）。
function serviceAuthed(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!m) return false;
  const supplied = m[1].trim();
  if (!supplied) return false;
  if (PANEL_ADMIN_KEY.length >= 12 && safeEqualText(supplied, PANEL_ADMIN_KEY)) return true;
  if (PLATFORM_TOKEN.length >= 12 && safeEqualText(supplied, PLATFORM_TOKEN)) return true;
  return false;
}

function isSecureRequest(req) {
  if (PANEL_PUBLIC_URL) {
    try {
      return new URL(PANEL_PUBLIC_URL).protocol === 'https:';
    } catch {
      return false;
    }
  }
  return Boolean(req.socket && req.socket.encrypted);
}

function requestOrigin(req) {
  if (PANEL_PUBLIC_URL) {
    try {
      return new URL(PANEL_PUBLIC_URL).origin;
    } catch {
      // 配错时退回到请求头推导，避免整个面板不可用
    }
  }
  return `${isSecureRequest(req) ? 'https' : 'http'}://${req.headers.host || 'localhost'}`;
}

const ssoCallbackUrl = (req) => ssoState().callbackUrl || `${requestOrigin(req)}/api/auth/oidc/callback`;
const ssoFingerprint = (sso) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        sso.issuer,
        sso.clientId,
        sso.clientSecret,
        sso.scope,
        sso.allowedSubjects,
        sso.allowedEmails,
        sso.callbackUrl,
      ]),
    )
    .digest('base64url');

const oidcTransactions = new Map();
// 状态：给前端渲染登录页和 SSO 设置页；密钥永不返回。
function authSettingsView(callbackUrl) {
  return sanitizeSso(ssoState(), callbackUrl);
}

function authConfigView() {
  const sso = ssoState();
  return {
    keyLoginEnabled: sso.keyLoginEnabled,
    sso: {
      enabled: sso.enabled,
      providerName: sso.providerName || 'SSO',
      loginUrl: sso.enabled ? '/api/auth/oidc/login' : '',
    },
  };
}

const UPSTREAM_ORIGIN = process.env.ZCODE_UPSTREAM_ORIGIN || 'https://zcode.z.ai';const UPSTREAM_URL = `${UPSTREAM_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`;
const DEFAULT_MODEL = process.env.ZCODE_MODEL || 'GLM-5.3-Flash';
const VERBOSE = process.env.ZCGW_VERBOSE === '1';
const PROFILE_FILE = path.join(import.meta.dirname, 'zcode-profile.json');
// 数据文件目录：Docker 里指向挂载卷 /app/data，本机默认与程序同目录
const DATA_DIR = process.env.ZCGW_DATA_DIR || import.meta.dirname;

// 持久层：账号 / 密钥 / 调度参数 / 调度状态 / 接入流程 / 用量日志都在 data/zcode.sqlite。
// 首次启动会把旧的 JSON 文件导入并改名 .migrated-*.bak，usage.jsonl 不导入也不改名。
const store = new ZcgwStore(DATA_DIR, {
  onSlowWrite: (op, info) =>
    log(`[store] 慢写事务 ${op}：窗口内 ${info.count} 次超过 50ms，最大 ${info.maxMs.toFixed(1)}ms`),
});

/** 管理器生成的会话签名密钥：与面板管理密钥解耦，密钥轮换不会踢掉会话。 */
function newSessionSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

// 登录状态与 SSO 设置存在库里，重启不丢；写入先落库再发布内存状态。
const storedAuth = store.readAuth();
const authState = {
  sso: withSsoDefaults(storedAuth.sso),
  sessionSecret:
    typeof storedAuth.sessionSecret === 'string' && storedAuth.sessionSecret.length >= 32
      ? storedAuth.sessionSecret
      : newSessionSecret(),
};

function saveAuthState() {
  store.writeAuth(authState);
}

// 首次启动时把会话密钥落库，之后一直复用。
if (!storedAuth.sessionSecret) {
  try {
    saveAuthState();
  } catch (error) {
    console.warn(`[auth] 无法写入 ${store.file}：${error.message}，本次运行的会话在重启后失效`);
  }
}
const clientVersion = createVersionManager({ dataDir: DATA_DIR,
  url: process.env.ZCODE_CHANGELOG_URL || `${UPSTREAM_ORIGIN}/cn/changelog`, configuredVersion: process.env.ZCODE_APP_VERSION });

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

/** 账号归属：国内 / 国际（按登录身份判断，可由账号记录的 realm 覆盖） */
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
// 账号配置记录保存在 data/zcode.sqlite 的 accounts 表，形状与旧版 accounts.json 的数组元素一致。
function readAccountRecords() {
  return store.readAccountRecords();
}

function writeAccountRecords(records) {
  store.writeAccountRecords(records);
}

/** 账号来源是否已初始化（等价于旧代码里的“accounts.json 存在”） */
function accountsInitialized() {
  return store.readMeta('accounts_initialized') === '1' || readAccountRecords().length > 0;
}

// ── 官方身份接口（客户端 OEM 的 zai adapter 同款端点）──
// 关键：这个接口认的是 OAuth access_token，不是 zcodejwttoken。
// 返回值带 email / phoneNumber(已打码) / countryCode，正好用来判国内 vs 国际。
const ZAI_ORIGIN = process.env.ZCODE_ZAI_ORIGIN || 'https://api.z.ai';
const codingClient = createCodingClient({ zaiOrigin: ZAI_ORIGIN, zcodeOrigin: UPSTREAM_ORIGIN,
  bigmodelOrigin: process.env.ZCODE_BIGMODEL_ORIGIN || 'https://open.bigmodel.cn',
  bigmodelBizOrigin: process.env.ZCODE_BIGMODEL_BIZ_ORIGIN || process.env.ZCODE_BIGMODEL_ORIGIN || 'https://bigmodel.cn',
  persistCredential: persistCodingCredential });

function persistCodingCredential(snapshot, credential) {
  const records = readAccountRecords();
  const record = records.find((a) => a.jwt === snapshot.jwt && userIdFromJwt(a.jwt) === userIdFromJwt(snapshot.jwt));
  const current = accounts.find((a) => a.label === snapshot.label);
  // Discovery awaited upstream I/O. Never overwrite a newer authorization, manual key or provider edit.
  if (!record || !current || record.codingPlanApiKey ||
      codingIdentity({ ...record, realm: detectRealm(record.jwt, record.realm, record.email) }) !== codingIdentity(snapshot) ||
      codingIdentity(current) !== codingIdentity(snapshot)) return false;
  record.codingPlanCredential = { ...credential };
  writeAccountRecords(records);
  current.codingPlanCredential = { ...credential };
  return true;
}

async function fetchCustomerInfo(accessToken, provider = 'zai', jwt) {
  if (!accessToken) return null;
  const acc = { jwt, [provider === 'bigmodel' ? 'bigmodelAccessToken' : 'zaiAccessToken']: accessToken };
  return (await codingClient.identity(acc, provider)).profile;
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

/** Use an authorized profile ID; the gateway JWT may identify a different namespace. */
function profileUserId(profile) {
  for (const key of ['id', 'user_id', 'customerNumber', 'sub']) {
    const value = profile?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** 把一次 customerInfo 结果合并回账号记录；有变更返回 true */
function mergeCustomerInfo(rec, d) {
  if (!d) return false;
  let changed = false;
  const email = String(d.email || '').trim();
  const phone = String(d.phoneNumber || '').trim();
  const realm = realmFromCustomer(d);
  const nick = String(d.nickName || d.customerName || '').trim();
  const activationUserId = profileUserId(d);

  // 手机号账号的 email 是空的：把历史的 xxx@phone.local 占位清掉，改用真实打码手机号
  if (phone && rec.phone !== phone) { rec.phone = phone; changed = true; }
  if (phone && rec.email && /@phone\.local$/i.test(rec.email)) { rec.email = null; changed = true; }
  if (email && rec.email !== email) { rec.email = email; changed = true; }
  if (realm !== 'unknown' && rec.realm !== realm) { rec.realm = realm; changed = true; }
  if (d.countryCode && rec.countryCode !== d.countryCode) { rec.countryCode = d.countryCode; changed = true; }
  if (nick && !rec.name) { rec.name = nick; changed = true; }
  if (activationUserId && !rec.activationUserId) { rec.activationUserId = activationUserId; changed = true; }
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
    return { accessToken: at, uid: userIdFromJwt(jwt), activationUserId: localActivationUserId() };
  } catch {
    return null;
  }
}

/** 启动时把本地客户端的 access_token 补给对应账号（免重新登录） */
function seedLocalAccessToken() {
  try {
    const local = localAccessToken();
    if (!local) return 0;
    const arr = readAccountRecords();
    let n = 0;
    for (const a of arr) {
      if (userIdFromJwt(a.jwt) !== local.uid) continue;
      let changed = false;
      if (!a.zaiAccessToken) { a.zaiAccessToken = local.accessToken; changed = true; }
      if (!a.activationUserId && local.activationUserId) { a.activationUserId = local.activationUserId; changed = true; }
      if (changed) n += 1;
    }
    if (n) writeAccountRecords(arr);
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
    arr = readAccountRecords();
  } catch {
    return { updated: 0, total: 0, withToken: 0 };
  }
  let updated = 0;
  for (const rec of arr) {
    const provider = oauthProviderOf(rec), token = oauthTokenOf(rec, provider);
    if (!token) continue;
    const d = await fetchCustomerInfo(token, provider, rec.jwt);
    if (!d) continue;
    // A profile request may finish after reauthorization; never restore its old JWT.
    const latest = readAccountRecords();
    const current = latest.find((a) => a.jwt === rec.jwt && oauthTokenOf(a, provider) === token);
    if (current && mergeCustomerInfo(current, d)) {
      writeAccountRecords(latest);
      const live = accounts.find((a) => a.jwt === rec.jwt && oauthTokenOf(a, provider) === token);
      if (live) { mergeCustomerInfo(live, d); live.identity = displayIdentity(live); }
      updated += 1;
    }
  }
  if (updated) {
    log(`自动识别账号身份：更新 ${updated} 个`);
  }
  return { updated, total: arr.length, withToken: arr.filter((a) => a.zaiAccessToken || a.bigmodelAccessToken).length };
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

function localActivationUserId() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(zcodeDir(), 'credentials.json'), 'utf8'));
    const provider = decryptCredential(raw['oauth:active_provider'] ?? '').trim() || 'zai';
    const info = JSON.parse(decryptCredential(raw[`oauth:${provider}:user_info`] ?? '{}'));
    return profileUserId(info);
  } catch {
    return null;
  }
}

function loadAccounts() {
  // 优先用库里已纳管的账号；没有就回退到本地 ZCode 客户端凭证（单账号模式）
  if (accountsInitialized()) return readAccountFile();

  const jwt = localJwt();
  if (!jwt) {
    // 空池不能退出：面板必须先起来，用户才能用「登录新账号」按钮纳管账号，
    // 否则容器 crash loop，永远进不了面板（先有鸡还是先有蛋）
    console.error('库里还没有账号，也没有本地 ZCode 登录态 —— 以空账号池启动。');
    console.error('请打开面板点「登录新账号」纳管账号后重启。');
    return [];
  }
  log('库里还没有账号，使用本地 ZCode 客户端凭证（单账号模式）');
  const uid = userIdFromJwt(jwt);
  return [
    {
      label: `local-${uid.slice(0, 8)}`,
      jwt,
      uid,
      local: true, // 每次请求重读客户端凭证，客户端刷新 token 后自动跟上
      activationUserId: localActivationUserId(),
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
    arr = readAccountRecords();
  } catch (e) {
    console.error(`账号记录读取/解析失败（${e.message}）—— 以空账号池启动，请用备份修复 data/zcode.sqlite 后重启。`);
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
        hasAccessToken: !!(a.zaiAccessToken || a.bigmodelAccessToken),
        zaiAccessToken: a.zaiAccessToken || null,
        bigmodelAccessToken: a.bigmodelAccessToken || null,
        oauthProvider: oauthProviderOf(a),
        activationUserId: typeof a.activationUserId === 'string' ? a.activationUserId.trim() || null : null,
        codingPlanApiKey: a.codingPlanApiKey || null,
        codingPlanCredential: a.codingPlanCredential || null,
        codingPlanProvider: codingProviderOf({ ...a, realm }),
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

/** 把新账号写回库（保留已有账号） */
function persistAccount(jwt, label, extra = {}) {
  const arr = readAccountRecords();
  const uid = userIdFromJwt(jwt);
  const email = extra.email || null;
  const realm = extra.realm || detectRealm(jwt, null, email);
  const accessToken = extra.accessToken || null;
  const oauthProvider = extra.oauthProvider || 'zai';
  const tokenField = oauthProvider === 'bigmodel' ? 'bigmodelAccessToken' : 'zaiAccessToken';
  const activationUserId = typeof extra.activationUserId === 'string' ? extra.activationUserId.trim() : '';
  const existing = arr.find((a) => userIdFromJwt(a.jwt) === uid);
  if (existing) {
    existing.jwt = jwt;
    if (email) existing.email = email;
    if (extra.name) existing.name = extra.name;
    if (extra.phone) existing.phone = extra.phone;
    if (accessToken) existing[tokenField] = accessToken;
    if (extra.oauthProvider) {
      existing.oauthProvider = oauthProvider;
      // Automatic discovery follows the login provider; an explicit API key keeps its selected platform.
      if (!existing.codingPlanApiKey) existing.codingPlanProvider = oauthProvider;
    }
    if (activationUserId) existing.activationUserId = activationUserId;
    if (realm !== 'unknown') existing.realm = realm;
    writeAccountRecords(arr);
    return { added: false, label: existing.label };
  }
  arr.push({
    label,
    jwt,
    email,
    name: extra.name || null,
    realm,
    ...(accessToken ? { [tokenField]: accessToken } : {}),
    ...(extra.oauthProvider ? { oauthProvider, codingPlanProvider: oauthProvider } : {}),
    ...(activationUserId ? { activationUserId } : {}),
  });
  writeAccountRecords(arr);
  return { added: true, label };
}

let accounts = loadAccounts();

// ── 调度参数：环境变量为默认值，面板可在线改（持久化到 zcode.sqlite 的 settings 表）──

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
    const saved = store.readPoolSettings();
    for (const k of Object.keys(POOL_DEFAULTS)) {
      if (saved?.[k] !== undefined) out[k] = clamp(saved[k], POOL_LIMITS[k]);
    }
    if (saved) out.__fromFile = true;
  } catch {}
  return out;
}

const POOL = readSettings();

function applyPoolSettings(body) {
  const applied = {};
  for (const k of Object.keys(POOL_DEFAULTS)) {
    if (body[k] === undefined) continue;
    const v = clamp(body[k], POOL_LIMITS[k]);
    POOL[k] = v;
    applied[k] = v;
  }
  store.writePoolSettings({ ...(store.readPoolSettings() ?? {}), ...applied });
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
    store.writePoolState(accounts.map((a) => ({
      uid: a.uid,
      cooldownUntil: a.cooldownUntil || 0,
      degradeUntil: a.degradeUntil || 0,
      consecutiveFails: a.consecutiveFails || 0,
      failures: a.failures || 0,
      successCount: a.successCount || 0,
      errTotal: a.errTotal || 0,
      lastSuccess: a.lastSuccess || null,
      lastUsedAt: a.lastUsedAt || 0,
    })));
  } catch (e) {
    log('调度状态落库失败:', e.message);
  }
}

function loadPoolState() {
  try {
    const data = store.readPoolState();
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
    if (n) log(`已恢复账号池调度状态 ${n} 个（zcode.sqlite）`);
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
const activationCache = new Map();
const accountRefreshes = new Map();
const onboardRefreshes = new Map();
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
    const cd = Math.min(POOL.breakerCooldownMin * 60000 * 2 ** (blows - 1), 6 * 3600_000);
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
    'user-agent': `ZCode/${clientVersion.reported()} ai-sdk/provider-utils/4.0.27 runtime/node.js/24`,
    'http-referer': UPSTREAM_ORIGIN,
    'x-zcode-app-version': clientVersion.reported(),
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

/** zcode-switch's billing identity is separate from chat/inference headers. */
function accountBillingHeaders(acc, version = clientVersion.reported()) {
  if (acc?.local) acc.jwt = localJwt() || acc.jwt;
  return billingHeaders({ token: acc?.jwt || '', deviceId: acc?.deviceId, version, origin: UPSTREAM_ORIGIN });
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
const KEY_PREFIX = 'zck_';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function readKeys() {
  try {
    return store.readKeys();
  } catch (e) {
    log('读密钥失败:', e.message);
    return { version: 1, keys: [] };
  }
}

function writeKeys(db) {
  try {
    store.writeKeys(db);
  } catch (e) {
    log('写密钥失败:', e.message);
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
const security = {
  enabled: false,          // 总开关；关=不检查 IP 规则
  mode: 'blacklist',       // blacklist(默认放行，命中拒绝) | whitelist(默认拒绝，命中放行)
  rules: [],               // [{ type:'allow'|'deny', cidr:'1.2.3.4/32', note:'', createdAt }]
  blockedLog: [],          // 拦截审计（环形 500 条）
};

try {
  Object.assign(security, store.readSecurity() ?? {});
} catch (e) {
  console.error(`安全规则读取失败（${e.message}）—— 本次运行用默认值启动，请用备份修复 data/zcode.sqlite`);
}

function saveSecurity() {
  try {
    store.writeSecurity({
      enabled: security.enabled,
      mode: security.mode,
      rules: security.rules.slice(-200),
      blockedLog: security.blockedLog.slice(-500),
    });
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

/**
 * 校验对外密钥。
 *
 * 默认拒绝：既没有主密钥（GATEWAY_KEY）也没有任何启用中的密钥时，一律 401，
 * 不存在任何放行分支；本机回环也不例外，没有环境变量或配置能恢复无鉴权调用。
 */
function authenticate(req, model) {
  // 兼容两种风格：Anthropic 的 x-api-key 与 OpenAI 风格 Authorization: Bearer
  const got = (
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() ||
    String(req.headers['x-api-key'] || '').trim()
  );
  const active = keyDb.keys.filter((k) => !k.deleted);

  if (!GATEWAY_KEY && !active.some((k) => k.enabled)) {
    return { ok: false, status: 401, message: '尚未配置 API 密钥' };
  }

  if (!got) {
    return { ok: false, status: 401, message: '缺少 API Key' };
  }
  if (GATEWAY_KEY && got === GATEWAY_KEY) {
    return { ok: true, key: { id: 0, name: 'master', models: [], ipAllowlist: [], quotaTokens: 0, usedTokens: 0, requests: 0 } };
  }
  const h = sha256(got);
  const k = active.find((x) => x.hash === h);
  if (!k) {
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

// ── 用量采集（内存环形 + 库内追加）──
const USAGE_MAX = 6000;
let usageLog = [];

try {
  usageLog = store.readUsage(USAGE_MAX);
  if (usageLog.length) log(`已载入历史用量记录 ${usageLog.length} 条`);
} catch (e) {
  log('读取历史用量失败:', e.message);
}

function recordUsage(req, rec) {
  // 请求日志带来源 IP 与 UA（wb2api logs 风格，方便事后审计谁在用什么打进来）
  if (req && req.headers) {
    rec.ip = clientIp(req);
    rec.ua = String(req.headers['user-agent'] || '').slice(0, 80) || undefined;
  }
  usageLog.push(rec);
  if (usageLog.length > USAGE_MAX) usageLog = usageLog.slice(-USAGE_MAX);
  try {
    store.appendUsage(rec);
  } catch (e) {
    log('用量日志落库失败:', e.message);
  }

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
    return sendJson(res, 503, { error: { message: '尚未纳管任何账号：请打开面板点「登录新账号」纳管账号后重启', type: 'api_error' } });
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
    return sendJson(res, 503, { type: 'error', error: { type: 'api_error', message: '尚未纳管任何账号：请打开面板点「登录新账号」纳管账号后重启' } });
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

/** Refresh quota; disabled accounts keep their own quota visibility. */
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

async function quotaJson(url, headers, { billing = false } = {}) {
  const r = billing ? await zcodeRequest(url, { headers, timeoutMs: 15000 }) : await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const j = billing ? responseJson(r) : await safeJson(r);
  if (!r.ok || !j || typeof j !== 'object' || Array.isArray(j) || j.__error || j.success === false || ![0, 200, '0', '200'].includes(j.code)) {
    // Never echo upstream payloads, which may contain credentials or personal data.
    const code = j?.code ?? j?.provider_code;
    const codeText = code != null && String(code).trim() && Number.isFinite(Number(code)) ? Number(code) : '未知';
    throw new Error(`查询失败（HTTP ${r.status}，业务码 ${codeText}）`);
  }
  if (!j.data || typeof j.data !== 'object' || Array.isArray(j.data)) throw new Error('查询响应缺少有效 data');
  return j.data;
}

function sourceName(acc, id) {
  return id === 'billing' ? 'ZCode 套餐' : `${codingProviderOf(acc) === 'bigmodel' ? 'BigModel' : 'Z.ai'} Coding Plan`;
}

const codingSnapshotIdentities = new Map();
async function refreshQuotaSource(acc, id, version) {
  const key = `${acc.label}:${id}`;
  if (accountRefreshes.has(key)) return accountRefreshes.get(key);
  acc = { ...acc };
  const run = (async () => {
    const identity = id === 'coding' ? codingIdentity(acc) : null;
    const previous = id !== 'coding' || codingSnapshotIdentities.get(acc.label) === identity
      ? quotaSources.get(acc.label)?.[id] : null;
    const base = { id, name: sourceName(acc, id), plans: previous?.plans || [], syncedAt: previous?.syncedAt || null };
    let source;
    try {
      let plans;
      if (id === 'billing') {
        const q = await quotaOf(acc, version);
        plans = q.plans;
        setQuotaCache([{ label: acc.label, ...q }]);
      } else {
        const reported = typeof version === 'string' ? version : version?.reported || clientVersion.reported();
        source = { ...base, ...await codingClient.query(acc, {
          version: reported, headers: accountBillingHeaders(acc, reported), previous,
        }) };
      }
      source ||= { ...base, plans, syncedAt: new Date().toISOString(), status: 'ready', error: null };
    } catch (e) {
      source = { ...base, status: 'error', error: `${e.message}${id === 'coding' && !acc.codingPlanApiKey ? '；可在编辑账号中配置对应平台的 Coding Plan API Key' : ''}` };
    }
    // An earlier request must never repopulate the cache after a login/provider/key change or deletion.
    if (id === 'coding') {
      const current = accounts.find((a) => a.label === acc.label);
      if (!current || codingIdentity(current) !== identity) return source;
      codingSnapshotIdentities.set(acc.label, identity);
    }
    quotaSources.set(acc.label, { ...quotaSources.get(acc.label), [id]: source });
    return source;
  })();
  accountRefreshes.set(key, run);
  try { return await run; } finally { accountRefreshes.delete(key); }
}

async function refreshQuotaAccount(acc, version) {
  return Promise.all(['billing', 'coding'].map((id) => refreshQuotaSource(acc, id, version)));
}

/** Query in the same order as zcode-switch, retaining each channel's diagnostics. */
async function eligibilityChannel(acc, channel, version) {
  const headers = accountBillingHeaders(acc, version);
  const query = new URLSearchParams({ app_version: version, platform: headers['x-platform'] });
  const route = channel === 'marketing' ? 'marketing/touch?seq=0' : `zcode-plan/billing/${channel}?${query}`;
  const field = channel === 'marketing' ? 'deliveries' : 'plans';
  const meta = { status: null, code: null, count: 0, parsedCount: 0, transport: null, error: null };
  try {
    const response = await zcodeRequest(`${UPSTREAM_ORIGIN}/api/v1/${route}`, { headers, timeoutMs: CLAIM_TIMEOUT_MS });
    const body = responseJson(response);
    meta.status = response.status;
    meta.transport = response.transport;
    meta.code = body?.code != null && Number.isFinite(Number(body.code)) ? Number(body.code) : null;
    if (channel === 'preview' && response.status === 404) return { plans: [], meta };
    if (!response.ok || !body || body.success === false || ![0, '0'].includes(body.code)) {
      throw new Error(`查询失败（HTTP ${response.status}，业务码 ${meta.code ?? '未知'}）`);
    }
    if (body.data != null && (typeof body.data !== 'object' || Array.isArray(body.data))) throw new Error('查询响应的 data 格式不正确');
    const list = body.data?.[field] ?? [];
    if (!Array.isArray(list)) throw new Error(`查询响应的 ${field} 格式不正确`);
    meta.count = list.length;
    const plans = channel === 'marketing' ? parseMarketingPlans(list)
      : channel === 'current' ? parseCurrentPlans(list) : list.map(parseClaimPlan).filter(Boolean);
    meta.parsedCount = plans.length;
    return { plans, meta };
  } catch (error) {
    meta.error = error.message;
    return { plans: [], meta };
  }
}

/** Manual activation uses the OAuth identity and the same version/device as discovery. */
async function activateEligibility(acc, version) {
  const key = `${acc.label}:activation`;
  if (accountRefreshes.has(key)) return accountRefreshes.get(key);
  if (acc.local) acc.activationUserId = localActivationUserId();
  const identity = acc.activationUserId || null;
  const fingerprint = JSON.stringify([identity, acc.deviceId, version]);
  const previous = activationCache.get(acc.label);
  if (previous?.fingerprint === fingerprint && Date.parse(previous.state.retryAt) > Date.now()) return previous.state;
  const run = (async () => {
    const checkedAt = new Date().toISOString();
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    let state;
    if (!identity) {
      state = { status: 'unavailable', checkedAt, retryAt, error: '缺少授权用户信息，未执行资格激活；请重新登录该账号，现有套餐查询仍可使用' };
    } else {
      try {
        const headers = accountBillingHeaders(acc, version);
        for (const element of ['app_launch', 'app_daily_active']) {
          const response = await zcodeRequest(`${UPSTREAM_ORIGIN}/api/v1/event/report`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, timeoutMs: 10000,
            body: JSON.stringify({
              event_id: crypto.randomUUID(), element_name: element,
              event_region: 'app', event_type: 'view', event_text: '', event_extra_detail: {},
              user_id: identity, device_mid: acc.deviceId,
              app_version: version, client_timezone: headers['x-client-timezone'],
              client_language: headers['x-client-language'],
              device_os_category: headers['x-os-category'], device_os_version: headers['x-os-version'],
              screen_resolution: '2560x1440', mac_id: '', marketing_params: '{}',
            }),
          });
          const body = responseJson(response);
          if (!response.ok || !body || body.success === false || ![0, '0'].includes(body.code)) {
            const code = body?.code;
            throw new Error(`资格激活失败（HTTP ${response.status}，业务码 ${code != null && Number.isFinite(Number(code)) ? Number(code) : '未知'}）`);
          }
        }
        state = { status: 'ready', checkedAt, retryAt, error: null };
      } catch (error) {
        state = { status: 'error', checkedAt, retryAt, error: error.message.startsWith('资格激活失败') ? error.message : '资格激活请求失败或超时，已继续查询套餐' };
      }
    }
    activationCache.set(acc.label, { fingerprint, state });
    return state;
  })();
  accountRefreshes.set(key, run);
  try { return await run; } finally { accountRefreshes.delete(key); }
}

async function refreshAccountEligibility(acc) {
  const key = `${acc.label}:manual-refresh`;
  if (accountRefreshes.has(key)) return accountRefreshes.get(key);
  const run = (async () => {
    const version = await clientVersion.ensureFresh();
    const [sources, eligibility] = await Promise.all([
      refreshQuotaAccount(acc, version.reported),
      (async () => {
        await activateEligibility(acc, version.reported);
        // A read-only lookup started before activation must not supply this result.
        await accountRefreshes.get(`${acc.label}:eligibility`);
        return refreshEligibility(acc, version);
      })(),
    ]);
    return { quotaSources: sources, eligibility };
  })();
  accountRefreshes.set(key, run);
  try { return await run; } finally { accountRefreshes.delete(key); }
}

/** Reauthorization refreshes with the new credentials after older lookups finish. */
function refreshAfterAuthorization(acc) {
  const label = acc.label;
  const sources = quotaSources.get(label);
  if (sources) delete sources.coding;
  codingSnapshotIdentities.delete(label);
  const pending = [onboardRefreshes.get(label), ...['billing', 'coding', 'activation', 'eligibility', 'manual-refresh']
    .map((kind) => accountRefreshes.get(`${label}:${kind}`))].filter(Boolean);
  eligibilityCache.delete(label);
  const run = (async () => {
    await Promise.allSettled(pending);
    let current = accounts.find((a) => a.label === label);
    if (!current) return;
    const provider = oauthProviderOf(current);
    const token = oauthTokenOf(current, provider);
    if (token) {
      const jwt = current.jwt;
      const profile = await fetchCustomerInfo(token, provider, jwt);
      // Re-read after the network wait so concurrent edits/new authorizations survive.
      const records = readAccountRecords();
      const record = records.find((a) => a.label === label && a.jwt === jwt && oauthTokenOf(a, provider) === token);
      if (record && mergeCustomerInfo(record, profile)) {
        writeAccountRecords(records);
        const live = accounts.find((a) => a.label === label && a.jwt === record.jwt);
        if (live) { mergeCustomerInfo(live, profile); live.identity = displayIdentity(live); }
      }
      current = accounts.find((a) => a.label === label);
      if (!current) return;
    }
    activationCache.delete(label);
    eligibilityCache.delete(label);
    pendingClaims.delete(label);
    return refreshAccountEligibility(current);
  })().catch(() => {
    eligibilityCache.set(label, { status: 'error', plans: [], currentPlans: [], checkedAt: new Date().toISOString(),
      error: '授权已保存，但资格刷新未完成，请点击刷新资格与额度重试' });
    log(`[${label}] 授权后资格刷新失败`);
  }).finally(() => {
    if (onboardRefreshes.get(label) === run) onboardRefreshes.delete(label);
  });
  onboardRefreshes.set(label, run);
}

async function refreshEligibility(acc, version) {
  const key = `${acc.label}:eligibility`;
  if (accountRefreshes.has(key)) return accountRefreshes.get(key);
  const run = (async () => {
    version ||= await clientVersion.ensureFresh();
    const started = Date.now();
    const preview = await eligibilityChannel(acc, 'preview', version.reported);
    const marketing = await eligibilityChannel(acc, 'marketing', version.reported);
    const current = await eligibilityChannel(acc, 'current', version.reported);
    const errors = [preview.meta.error && `套餐资格：${preview.meta.error}`, marketing.meta.error && `活动资格：${marketing.meta.error}`].filter(Boolean);
    const state = {
      status: errors.length === 2 ? 'error' : errors.length ? 'partial' : 'ready',
      plans: mergeClaimPlans(preview.plans, marketing.plans),
      currentPlans: current.plans, currentError: current.meta.error,
      checkedAt: new Date().toISOString(), error: errors.join('；') || null,
      activation: activationCache.get(acc.label)?.state || null,
      version, diagnostics: { preview: preview.meta, marketing: marketing.meta, current: current.meta, elapsedMs: Date.now() - started },
    };
    eligibilityCache.set(acc.label, state);
    return state;
  })();
  accountRefreshes.set(key, run);
  try { return await run; } finally { accountRefreshes.delete(key); }
}

// The reference validates the chosen offer before opening captcha and consumes it once.
const pendingClaims = new Map();
const claimsInFlight = new Set();
const preparingClaims = new Set();
const automatedClaimAccounts = new Set();
const claimIdentity = (acc) => crypto.createHash('sha256').update(`${acc.jwt}:${acc.deviceId}`).digest('hex');
async function prepareClaim(acc, planId, automated = false) {
  if ((!automated && automatedClaimAccounts.has(acc.label)) || preparingClaims.has(acc.label)) throw new Error('该账号正在准备领取，请等待本次结果');
  preparingClaims.add(acc.label);
  try {
    const state = await refreshEligibility(acc);
    const plan = planId ? state.plans.find((p) => p.planId === planId) : state.plans[0];
    if (!plan) throw new Error(state.error || (planId ? '该套餐已不在可领取列表，请刷新资格后重试' : '暂无可领取套餐'));
    const prepared = { preparationId: crypto.randomUUID(), plan, version: state.version.reported,
      identity: claimIdentity(acc), expiresAt: Date.now() + 10 * 60_000 };
    pendingClaims.set(acc.label, prepared);
    return prepared;
  } finally { preparingClaims.delete(acc.label); }
}

let captchaConfigCache = { ts: 0, cfg: null };
const CAPTCHA_CFG_DEFAULT = { enabled: true, region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' };
async function captchaConfig() {
  if (captchaConfigCache.cfg && Date.now() - captchaConfigCache.ts < 600_000) return captchaConfigCache.cfg;
  try {
    const response = await zcodeRequest(`${UPSTREAM_ORIGIN}/api/v1/client/configs`, {
      headers: accountBillingHeaders(null), timeoutMs: CLAIM_TIMEOUT_MS,
    });
    const body = responseJson(response);
    if (!response.ok || ![0, '0'].includes(body?.code)) throw new Error();
    const c = body.data?.configs?.captcha;
    const cfg = { enabled: c?.enabled === true, region: typeof c?.region === 'string' ? c.region : '',
      prefix: typeof c?.prefix === 'string' ? c.prefix : '', sceneId: typeof c?.sceneId === 'string' ? c.sceneId : '' };
    captchaConfigCache = { ts: Date.now(), cfg };
    return cfg;
  } catch {
    captchaConfigCache = { ts: Date.now(), cfg: captchaConfigCache.cfg || CAPTCHA_CFG_DEFAULT };
    return captchaConfigCache.cfg;
  }
}

/** Exactly one selected plan per captcha; every business failure is terminal. */
async function claimFor(acc, planId, captchaParam, captchaRegion, preparationId, automated = false) {
  if (!captchaParam) return { ok: false, code: 'captcha_required', msg: '需要人机验证：请从面板发起领取' };
  if (!automated && automatedClaimAccounts.has(acc.label)) return { ok: false, code: 'claim_pending', msg: '该账号正在自动领取，请等待本次结果' };
  if (claimsInFlight.has(acc.label)) return { ok: false, code: 'claim_pending', msg: '该账号正在领取，请等待本次结果' };
  claimsInFlight.add(acc.label);
  try {
    if (acc.local) acc.jwt = localJwt() || acc.jwt;
    let pending;
    if (preparationId) {
      pending = pendingClaims.get(acc.label);
      if (!pending || pending.preparationId !== preparationId || pending.expiresAt <= Date.now()
        || pending.identity !== claimIdentity(acc) || (planId && pending.plan.planId !== planId)) {
        return { ok: false, code: 'preparation_expired', msg: '领取准备已失效，请重新发起领取' };
      }
    } else pending = await prepareClaim(acc, planId);
    pendingClaims.delete(acc.label);
    const pid = pending.plan.planId;
    let response;
    try { response = await zcodeRequest(`${UPSTREAM_ORIGIN}/api/v1/zcode-plan/billing/claim`, {
      method: 'POST', headers: { ...accountBillingHeaders(acc, pending.version),
        'x-aliyun-captcha-verify-param': captchaParam,
        ...(captchaRegion ? { 'x-aliyun-captcha-verify-region': captchaRegion } : {}),
      }, body: JSON.stringify({ plan_id: pid }), timeoutMs: CLAIM_TIMEOUT_MS, retryTransport: false,
    }); } catch {
      return { ok: false, unknown: true, code: 'claim_unknown', msg: '提交结果未知，请刷新套餐并人工确认；不会自动重发' };
    }
    const body = responseJson(response);
    const code = body?.code != null && Number.isFinite(Number(body.code)) ? Number(body.code) : -1;
    log(`[${acc.label}] claim ${pid} -> HTTP ${response.status} code ${code}`);
    if (response.status >= 500 || code === -1) return { ...claimFailure(code, response, body), unknown: true };
    if (!response.ok || ![0, '0'].includes(body?.code) || body?.success === false) return claimFailure(code, response, body);
    const millis = (v) => Number.isFinite(v) ? v * 1000 : null;
    return { ok: true, claimed: pid, claimedList: [pid], planName: pending.plan.name,
      startsAt: millis(body?.data?.plan?.starts_at), endsAt: millis(body?.data?.plan?.ends_at),
      effectiveAt: effectiveAt(body?.data?.plan), serverTime: millis(body?.data?.server_time) };
  } finally { claimsInFlight.delete(acc.label); }
}

const automaticCaptcha = createCaptchaBrowser();
const panelCaptcha = createPanelCaptcha();
const claimAutomation = createClaimAutomation({
  dataDir: DATA_DIR, getAccounts: () => accounts,
  reserve: (acc) => {
    if (claimsInFlight.has(acc.label) || preparingClaims.has(acc.label) || onboardRefreshes.has(acc.label)
      || (pendingClaims.get(acc.label)?.expiresAt || 0) > Date.now()) return false;
    automatedClaimAccounts.add(acc.label);
    return true;
  },
  release: (acc) => { automatedClaimAccounts.delete(acc.label); pendingClaims.delete(acc.label); },
  refreshAccount: refreshAccountEligibility,
  prepare: (acc, planId) => prepareClaim(acc, planId, true),
  verify: async (current) => {
    const config = await captchaConfig();
    if (!current()) throw new Error('自动验证已取消');
    return automaticCaptcha.mode === 'panel' ? panelCaptcha.verify(config) : automaticCaptcha.verify(config);
  },
  browserStatus: () => automaticCaptcha.mode === 'panel' ? panelCaptcha.status() : { mode: automaticCaptcha.mode },
  submit: (acc, prepared, proof) => claimFor(acc, prepared.plan.planId, proof.param, proof.region, prepared.preparationId, true),
  afterClaim: (acc) => Promise.all([refreshQuotaAccount(acc), refreshEligibility(acc)]),
  closeVerifier: async () => { await panelCaptcha.close(); await automaticCaptcha.close(); },
  reportError: () => log('定时领取任务异常，请检查数据目录权限和浏览器运行环境'),
});

/** Legacy endpoint shares the same eligibility result as the console. */
async function handleClaimable(req, res) {
  const out = [];
  for (const acc of accounts) {
    const state = await refreshEligibility(acc);
    out.push({ label: acc.label, claimable: state.plans, ...state });
  }
  sendJson(res, 200, { accounts: out });
}

/** Legacy and console endpoints use one account and one captcha per submission. */
async function handleClaim(req, res, labelOverride) {
  const raw = await readBody(req);
  let body;
  try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
  catch { return sendJson(res, 400, { error: '请求不是有效 JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: '请求必须是 JSON 对象' });
  const targetLabel = labelOverride || body.label;
  const targets = targetLabel ? accounts.filter((a) => a.label === targetLabel) : accounts.filter((a) => !a.disabled);
  if (!targets.length) return sendJson(res, 404, { error: '找不到账号' });
  if (targets.length !== 1) return sendJson(res, 400, { error: '一次验证只能领取一个账号的一个套餐，请指定账号' });
  const acc = targets[0];
  const field = (name) => typeof body[name] === 'string' ? body[name].trim() : '';
  let result;
  try {
    result = await claimFor(acc, field('planId'), field('captchaParam') || field('captchaVerifyParam'), field('captchaRegion'), field('preparationId'));
    if (result.ok || result.alreadyClaimed) await Promise.all([refreshQuotaAccount(acc), refreshEligibility(acc)]);
  } catch (error) { result = { ok: false, msg: error.message }; }
  sendJson(res, 200, { results: [{ label: acc.label, ...result }] });
}

// ── 无头登录（设备授权流）：登录后保存授权身份 ──
// flow 要落库：网关重启不该把你正在等的那次授权弄丢
// 每个上游资格/领取请求的超时。
const CLAIM_TIMEOUT_MS = Number(process.env.ZCGW_CLAIM_TIMEOUT_MS || 15000);

function readFlows() {
  try {
    // 只保留 20 分钟内的流程（与旧版按 createdAt 过滤一致）
    return store.readFlows(Date.now() - 20 * 60_000);
  } catch (e) {
    log('读取登录授权流程失败:', e.message);
    return new Map();
  }
}

function writeFlows(map) {
  try {
    store.writeFlows(map);
  } catch {}
}

const pendingFlows = readFlows(); // flowId -> { pollToken, createdAt }


/** 读某个账号的余额（统一格式，带中文标签） */
async function quotaOf(acc, version) {
  version ||= (await clientVersion.ensureFresh()).reported;
  const data = await quotaJson(`${UPSTREAM_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${version}`, accountBillingHeaders(acc, version), { billing: true });
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
  if (accessToken) customer = await fetchCustomerInfo(accessToken, 'zai', jwt);

  const email = String(customer?.email || body.email || '').trim() || null;
  const phone = String(customer?.phoneNumber || '').trim() || null;
  let realm = realmFromCustomer(customer);
  if (realm === 'unknown') realm = body.realm || realmFromIdentity(email);
  const nick = String(customer?.nickName || customer?.customerName || body.name || '').trim() || null;

  const label = body.label || (nick ? `${nick}-${uid.slice(0, 8)}` : `acc-${uid.slice(0, 8)}`);
  const { added } = persistAccount(jwt, label, { email, phone, name: nick, realm, accessToken, activationUserId: profileUserId(customer) });
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
  if (acc && !acc.email && !acc.phone && oauthTokenOf(acc, oauthProviderOf(acc))) {
    try {
      const c = await fetchCustomerInfo(oauthTokenOf(acc, oauthProviderOf(acc)), oauthProviderOf(acc), acc.jwt);
      if (c) {
        acc.email = c.email || acc.email;
        acc.phone = c.phoneNumber || acc.phone;
        acc.name = c.nickName || c.customerName || acc.name;
        acc.activationUserId ||= profileUserId(c);
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
  const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
  const target = accountId ? readAccountFile().find((a) => a.label === accountId) : null;
  if (accountId && !target) return sendJson(res, 404, { error: '账号已不存在，请刷新账号列表后重试', code: 'account_missing' });
  // 国内号走 bigmodel.cn 登录页，国际号走 chat.z.ai —— provider 选错整条授权链就是死的
  const provider = ONBOARD_PROVIDERS.includes(body.provider) ? body.provider
    : (target ? oauthProviderOf(target) || codingProviderOf(target)
      : ONBOARD_PROVIDERS.includes(process.env.ZCGW_ONBOARD_PROVIDER) ? process.env.ZCGW_ONBOARD_PROVIDER : 'zai');
  const pollToken = crypto.randomBytes(32).toString('hex');
  const deviceId = crypto.randomUUID();
  let j;
  try {
    const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/oauth/cli/init`, {
      method: 'POST',
      headers: { ...billingHeaders({ token: pollToken, deviceId, version: CLIENT_APP_VERSION, origin: UPSTREAM_ORIGIN }),
        'content-type': 'application/json' },
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
  pendingFlows.set(flow_id, { pollToken: typeof j.data.poll_token === 'string' && j.data.poll_token.trim() || pollToken,
    deviceId, createdAt: Date.now(), provider, state,
    ...(target ? { targetAccount: { label: target.label, uid: target.uid } } : {}) });
  writeFlows(pendingFlows);
  log(`onboard flow 已创建 ${flow_id} (provider=${provider})`);
  sendJson(res, 200, { flowId: flow_id, authorizeUrl: authorize_url, expiresAt: expires_at, pollIntervalSec: poll_interval_sec, provider });
}

/**
 * 授权成功后先保存凭证并返回，资格激活与额度查询在后台继续。
 */
async function pollOnboardFlow(flowId, flow) {
  let j;
  try {
    const r = await fetch(`${UPSTREAM_ORIGIN}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
      headers: billingHeaders({ token: flow.pollToken, deviceId: flow.deviceId,
        version: CLIENT_APP_VERSION, origin: UPSTREAM_ORIGIN }),
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

  // 授权完成：保存 JWT、OAuth access_token 和授权身份，再异步刷新资格与额度。
  const jwt = j.data.token;
  const uid = userIdFromJwt(jwt);
  if (!uid) return { http: 422, body: { error: '授权服务未返回有效账号凭证，请重新发起授权', code: 'invalid_credentials' } };
  const user = j.data.user ?? {};
  const accessToken = extractOAuthToken(j.data, flow.provider);
  if (!accessToken) return { http: 422, body: {
    error: `授权服务未返回${flow.provider === 'bigmodel' ? '国内' : '国际'}平台的完整授权凭证，请重新发起授权；现有账号未修改`,
    code: 'missing_oauth',
  } };
  if (flow.targetAccount) {
    const target = readAccountFile().find((a) => a.label === flow.targetAccount.label && a.uid === flow.targetAccount.uid);
    if (!target) return { http: 409, body: { error: '待重新授权的账号已变更或被删除，请刷新账号列表后重试', code: 'account_changed' } };
    if (uid !== target.uid) return { http: 409, body: {
      error: '本次登录的账号与待重新授权账号不一致，请使用原账号的手机号或邮箱重新发起授权；现有账号未修改',
      code: 'account_mismatch',
    } };
  }

  // Detailed customer lookup runs in the background so a ready poll stays short.
  const email = String(user.email || '').trim() || null;
  const phone = String(user.phoneNumber || '').trim() || null;
  const realm = realmFromIdentity(email) !== 'unknown' ? realmFromIdentity(email) : flow.provider === 'bigmodel' ? 'cn' : 'intl';
  const nick = String(user.name || '').trim() || null;
  const label = nick ? `${nick}-${uid.slice(0, 8)}` : uid.slice(0, 8);

  const { added } = persistAccount(jwt, label, { email, phone, name: nick, realm, accessToken, oauthProvider: flow.provider,
    activationUserId: profileUserId(user) });
  pendingFlows.delete(flowId);
  writeFlows(pendingFlows);
  log(
    `授权完成 uid=${uid} 身份=${displayIdentity({ email, phone }) ?? '-'} ` +
      `归属=${REALM_ZH[realm]} access_token=${accessToken ? '已捕获' : '缺失'} added=${added}`,
  );

  accounts = readAccountFile();
  const acc = accounts.find((a) => a.uid === uid);

  if (acc) refreshAfterAuthorization(acc);

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
      claim: { ok: false, code: 'captcha_required', msg: '资格与额度正在自动刷新；领取套餐需查看详情并完成验证' },
      quota: null,
      eligibilityRefreshing: !!acc,
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

  const arr = readAccountRecords();
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

  writeAccountRecords(arr);
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

const selfTests = new Map();
const SELFTEST_TIMEOUT_MS = Math.min(60000, Math.max(100, Number(process.env.ZCGW_SELFTEST_TIMEOUT_MS) || 45000));

/** One inference attempt; transport, HTTP and payload failures are distinct. */
async function probeAccount(acc) {
  const started = Date.now();
  const identity = acc.jwt;
  let upstreamStatus = null;
  let rayId = null;
  const failure = (code, message) => Object.assign(new Error(message), { probeCode: code });
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
      signal: AbortSignal.timeout(SELFTEST_TIMEOUT_MS),
    });
    upstreamStatus = r.status;
    const ray = r.headers.get('cf-ray') || '';
    if (/^[a-f\d]{12,32}(?:-[a-z]{3})?$/i.test(ray)) rayId = ray;
    const j = await safeJson(r);
    const rawCode = j?.error?.biz_code ?? j?.biz_code ?? j?.code;
    const code = rawCode != null && /^[\w.-]{1,60}$/.test(String(rawCode)) ? String(rawCode) : null;
    if (!r.ok) throw failure('upstream_http', `上游返回 HTTP ${r.status}${code ? `，业务码 ${code}` : ''}`);
    if (!j || j.__error || Array.isArray(j)) throw failure('invalid_response', '上游返回了空响应或非 JSON 数据');
    if (j.error || j.type === 'error' || (code && code !== '0')) {
      throw failure('upstream_rejected', `上游拒绝了探测请求${code ? `（业务码 ${code}）` : ''}`);
    }
    const txt = Array.isArray(j.content) ? j.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('').trim() : '';
    if (!txt) throw failure('empty_reply', '上游未返回有效文本，无法确认探测成功');
    const current = accounts.find((a) => a.label === acc.label && a.jwt === identity);
    if (current) { current.cooldownUntil = 0; current.degradeUntil = 0; markSuccess(current); }
    return { ok: true, account: acc.label, text: txt.slice(0, 500), ms: Date.now() - started, upstreamStatus };
  } catch (e) {
    const code = e.probeCode || (e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'connection_failed');
    const error = e.probeCode ? e.message : code === 'timeout'
      ? `上游探测超时（${SELFTEST_TIMEOUT_MS / 1000} 秒），请稍后重试`
      : '网关无法连接上游，或上游连接中断；请检查服务器到 ZCode 的网络';
    const current = accounts.find((a) => a.label === acc.label && a.jwt === identity);
    if (current) { current.lastErr = error; markFailure(current, 60_000); }
    log(`[${acc.label}] selftest ${code} HTTP=${upstreamStatus ?? '-'} ms=${Date.now() - started}${rayId ? ` ray=${rayId}` : ''}`);
    return { ok: false, account: acc.label, error, code, ms: Date.now() - started, upstreamStatus, rayId };
  }
}

function startSelfTest(acc) {
  const previous = selfTests.get(acc.label);
  if (previous?.status === 'running' && previous.identity === acc.jwt) return previous;
  const job = { jobId: crypto.randomUUID(), identity: acc.jwt, status: 'running', result: null, expiresAt: Date.now() + 5 * 60_000 };
  selfTests.set(acc.label, job);
  void probeAccount(acc).then((result) => { job.result = result; }).catch(() => {
    job.result = { ok: false, account: acc.label, code: 'internal_error', error: '探测未能完成，请检查网关日志' };
  }).finally(() => { job.status = 'completed'; job.expiresAt = Date.now() + 5 * 60_000; });
  return job;
}
const publicSelfTest = (job) => ({ jobId: job.jobId, status: job.status, result: job.result });

/** Legacy endpoint keeps its direct-result contract. */
async function handleSelfTest(req, res) {
  const acc = accounts.find((a) => !a.disabled);
  if (!acc) return sendJson(res, 409, { ok: false, error: '没有启用的账号' });
  return sendJson(res, 200, await probeAccount(acc));
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
    // 没有任何可用凭据时，网关拒绝所有推理调用（不再有放行模式）
    gatewayConfigured: !!GATEWAY_KEY || active.some((k) => k.enabled),
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

// 登录失败限流：同一来源 10 分钟内连续失败 5 次后暂停尝试，防止在线爆破
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map();

// 限流只认 socket 真实地址：x-forwarded-for 客户端可伪造，换一个值就能绕过。
const clientIpOf = (req) =>
  (req.socket && req.socket.remoteAddress) || 'unknown';

function loginAllowed(ip) {
  const record = loginFailures.get(ip);
  if (!record) return true;
  if (record.resetAt <= Date.now()) {
    loginFailures.delete(ip);
    return true;
  }
  return record.count < LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const record = loginFailures.get(ip);
  if (!record || record.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  record.count += 1;
}

function sessionCookie(req, expiresAt, provider = 'key', fingerprint = '') {
  const maxAge = Math.floor((expiresAt - Date.now()) / 1000);
  const { value } = sessionPayload(expiresAt, provider, fingerprint);
  return `${PANEL_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecureRequest(req) ? '; Secure' : ''}`;
}

const clearedSessionCookie = (req) =>
  `${PANEL_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecureRequest(req) ? '; Secure' : ''}`;

/** 面板登录：POST { key } —— 常量时间比较，通过后签发 7 天会话 cookie */
async function handlePanelLogin(req, res) {
  if (!ssoState().keyLoginEnabled)
    return sendJson(res, 403, { error: '管理密钥登录已停用，请使用单点登录', code: 'panel_auth' });
  if (!PANEL_ADMIN_KEY)
    return sendJson(res, 400, { error: '未设置 PANEL_ADMIN_KEY，面板处于免登录模式', code: 'panel_auth' });
  const ip = clientIpOf(req);
  if (!loginAllowed(ip)) {
    res.setHeader('retry-after', '600');
    return sendJson(res, 429, { error: '登录尝试过多，请 10 分钟后重试', code: 'panel_auth' });
  }
  const raw = await readBody(req);
  let body = {};
  try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {}
  const key = String(body.key || '');
  if (!safeEqualText(key, PANEL_ADMIN_KEY)) {
    recordLoginFailure(ip);
    return sendJson(res, 401, { error: '管理密钥不正确', code: 'panel_auth' });
  }
  loginFailures.delete(ip);
  const exp = Date.now() + PANEL_TTL_MS;
  res.setHeader('set-cookie', sessionCookie(req, exp));
  log('面板登录成功');
  return sendJson(res, 200, { authenticated: true, user: { name: '管理员', email: '', picture: '', provider: 'key' } });
}

const oidcCookie = (req, value, age) =>
  `${OIDC_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${isSecureRequest(req) ? '; Secure' : ''}`;

const safeReason = (error) =>
  error instanceof OidcError && /^[a-z_]+$/.test(error.reason) ? error.reason : 'internal_error';

function pruneTransactions() {
  const now = Date.now();
  for (const [id, tx] of oidcTransactions) if (tx.expiresAt <= now) oidcTransactions.delete(id);
  if (oidcTransactions.size >= 500) oidcTransactions.delete(oidcTransactions.keys().next().value);
}

const redirectTo = (res, location, headers = {}) => {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
  res.end();
};

/** SSO 登录入口：发现 issuer -> 建 state/nonce/PKCE -> 302 到 IdP */
async function handleSsoLogin(req, res) {
  const sso = ssoState();
  if (!sso.enabled) return redirectTo(res, '/?auth_error=sso_disabled');
  let discovery;
  try {
    discovery = await discoverProvider(sso, { allowLocal });
  } catch {
    return redirectTo(res, '/?auth_error=discovery_failed');
  }
  pruneTransactions();
  const tx = createTransaction();
  const redirectUri = ssoCallbackUrl(req);
  oidcTransactions.set(tx.txid, {
    state: tx.state,
    nonce: tx.nonce,
    verifier: tx.verifier,
    redirectUri,
    expiresAt: Date.now() + OIDC_TRANSACTION_MS,
  });
  const location = buildAuthorizationUrl(sso, {
    redirectUri,
    state: tx.state,
    nonce: tx.nonce,
    codeChallenge: tx.challenge,
    authorizationEndpoint: discovery.authorizationEndpoint,
  });
  return redirectTo(res, location, {
    'set-cookie': oidcCookie(req, tx.txid, OIDC_TRANSACTION_MS / 1000),
  });
}

/** SSO 回调：校 state -> 换 token -> 验 ID token -> 白名单 -> 发会话 */
async function handleSsoCallback(req, res, url) {
  const sso = ssoState();
  const clearCookie = oidcCookie(req, '', 0);
  const fail = (reason) => redirectTo(res, `/?auth_error=${reason}`, { 'set-cookie': clearCookie });
  if (!sso.enabled) return fail('sso_disabled');
  const txid = cookieValue(req, OIDC_COOKIE);
  const tx = txid ? oidcTransactions.get(txid) : null;
  if (txid) oidcTransactions.delete(txid);
  if (!tx || tx.expiresAt <= Date.now()) return fail('transaction_expired');
  if (url.searchParams.get('error')) return fail('provider_error');
  if (!safeEqual(url.searchParams.get('state') || '', tx.state)) return fail('state_mismatch');
  const code = url.searchParams.get('code') || '';
  if (!code || code.length > 4096) return fail('missing_code');
  let discovery;
  let tokens;
  try {
    discovery = await discoverProvider(sso, { allowLocal });
    tokens = await exchangeAuthorizationCode(sso, {
      code,
      codeVerifier: tx.verifier,
      redirectUri: tx.redirectUri,
      tokenEndpoint: discovery.tokenEndpoint,
    });
  } catch (error) {
    return fail(safeReason(error));
  }
  let idClaims;
  try {
    idClaims = await verifyIdTokenForConfig(sso, tokens.id_token, { nonce: tx.nonce, allowLocal });
  } catch (error) {
    return fail(safeReason(error));
  }
  let userInfo = null;
  try {
    userInfo = await fetchUserInfo(discovery, tokens.access_token);
  } catch {
    // UserInfo 可选：验证过的 ID token 声明就是兜底
  }
  if (userInfo && userInfo.sub !== idClaims.sub) return fail('userinfo_mismatch');
  let identity;
  try {
    identity = identityFromClaims(userInfo, idClaims);
  } catch (error) {
    return fail(safeReason(error));
  }
  if (!isAllowed(identity, sso)) return fail('not_allowed');
  const exp = Date.now() + PANEL_TTL_MS;
  log(`SSO 登录成功：${identity.email || identity.sub}`);
  return redirectTo(res, '/', {
    'set-cookie': [sessionCookie(req, exp, 'oidc', ssoFingerprint(sso)), clearCookie],
  });
}

/** SSO 设置读写：密钥永不返回；改完立即生效，无需重启 */
async function handleAuthSettings(req, res, url) {
  if (req.method === 'GET') return sendJson(res, 200, authSettingsView(ssoCallbackUrl(req)));
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const raw = await readBody(req);
  let input = {};
  try { input = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {}
  const previous = ssoState();
  const fields = {};
  if (input.ssoEnabled !== undefined) fields.enabled = input.ssoEnabled;
  for (const key of [
    'keyLoginEnabled',
    'issuer',
    'clientId',
    'clientSecret',
    'scope',
    'providerName',
    'allowedSubjects',
    'allowedEmails',
    'callbackUrl',
  ]) {
    if (input[key] !== undefined) fields[key] = input[key];
  }
  let candidate;
  try {
    candidate = validateSso(fields, previous, { allowLocal });
  } catch (error) {
    if (error instanceof InputError) return sendJson(res, error.status || 400, { error: error.message });
    throw error;
  }
  // 关闭密钥登录必须证明 SSO 真的能用：当前会话需是同一套配置下的 SSO 会话
  if (previous.keyLoginEnabled && candidate.keyLoginEnabled === false) {
    const session = sessionOf(req);
    if (!session || session.provider !== 'oidc' || session.fingerprint !== ssoFingerprint(candidate)) {
      return sendJson(res, 403, { error: '请先通过 SSO 登录验证，再关闭管理密钥登录' });
    }
  }
  const needsDiscovery =
    candidate.enabled &&
    (!previous.enabled ||
      previous.issuer !== candidate.issuer ||
      previous.clientId !== candidate.clientId);
  if (needsDiscovery) {
    try {
      await discoverProvider(candidate, { allowLocal });
    } catch {
      return sendJson(res, 400, { error: 'SSO 颁发者不可用或 discovery 校验失败，请检查地址后重试' });
    }
  }
  authState.sso = candidate;
  try {
    saveAuthState();
  } catch (error) {
    return sendJson(res, 500, { error: `保存 SSO 配置失败：${error.message}` });
  }
  log(`[auth] SSO 设置已更新：enabled=${candidate.enabled} keyLogin=${candidate.keyLoginEnabled}`);
  return sendJson(res, 200, authSettingsView(ssoCallbackUrl(req)));
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
      eligibilityRefreshing: onboardRefreshes.has(a.label),
      hasCodingPlanKey: !!a.codingPlanApiKey,
      codingPlanProvider: codingProviderOf(a),
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
    weekendGrab: false,
    limits: POOL_LIMITS,
  };
  return { accounts: mapped, settings, hourly, stats, claimAutomation: claimAutomation.snapshot() };
}

async function handleConsoleApi(req, res, url) {
  const p = url.pathname;
  // The Vue API helper prefixes every path with /api; root aliases remain
  // available for the legacy dashboard and scripts.
  if (req.method === 'POST' && p === '/api/onboard/start') {
    return handleOnboardStart(req, res);
  }
  if (req.method === 'POST' && p === '/api/onboard/redeem') {
    return handleOnboardRedeem(req, res);
  }
  if (req.method === 'GET' && p.startsWith('/api/onboard/poll/')) {
    return handleOnboardPoll(req, res, decodeURIComponent(p.slice('/api/onboard/poll/'.length)));
  }
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
  if (p === '/api/claim-automation' && req.method === 'GET') return sendJson(res, 200, claimAutomation.snapshot());
  if (p === '/api/claim-automation' && req.method === 'PATCH') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      return sendJson(res, 200, claimAutomation.configure(body));
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (p === '/api/claim-automation/run' && req.method === 'POST') {
    try { return sendJson(res, 202, claimAutomation.start()); }
    catch (error) { return sendJson(res, 409, { error: error.message }); }
  }
  if (p === '/api/claim-automation/cancel' && req.method === 'POST') return sendJson(res, 200, claimAutomation.cancel());
  if (p === '/api/claim-automation/browser/poll' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      return sendJson(res, 200, panelCaptcha.poll(body));
    } catch { return sendJson(res, 400, { error: '浏览器会话参数无效' }); }
  }
  if (p === '/api/claim-automation/browser/result' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (!panelCaptcha.complete(body)) return sendJson(res, 409, { error: '该验证已结束或不属于当前浏览器，请重新检测' });
      return sendJson(res, 200, { ok: true });
    } catch { return sendJson(res, 400, { error: '验证参数无效' }); }
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
    const masked = GATEWAY_KEY ? `${GATEWAY_KEY.slice(0, 6)}${'•'.repeat(18)}${GATEWAY_KEY.slice(-4)}` : '未配置主密钥';
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
    if (!GATEWAY_KEY) return sendJson(res, 404, { error: '未配置主密钥，请在「密钥」页创建密钥' });
    return sendJson(res, 200, { key: GATEWAY_KEY });
  }
  const probeResult = p.match(/^\/api\/accounts\/(.+?)\/selftest\/([\w-]+)$/);
  if (probeResult && req.method === 'GET') {
    const id = decodeURIComponent(probeResult[1]);
    const job = selfTests.get(id);
    if (!accounts.some((a) => a.label === id)) return sendJson(res, 404, { error: '找不到账号' });
    if (!job || job.jobId !== probeResult[2] || job.expiresAt <= Date.now()) return sendJson(res, 410, { error: '探测结果已过期或网关已重启，请重新探测' });
    return sendJson(res, 200, publicSelfTest(job));
  }
  // PATCH /api/accounts/:id —— 启用停用 + 身份字段
  const mAcc = p.match(/^\/api\/accounts\/(.+?)(?:\/(selftest|claim\/start|claim|refresh))?$/);
  if (mAcc) {
    const id = decodeURIComponent(mAcc[1]);
    const sub = mAcc[2];
    if (sub === 'refresh' && req.method === 'POST') {
      const acc = accounts.find((a) => a.label === id);
      if (!acc) return sendJson(res, 404, { error: '找不到账号' });
      const result = await (onboardRefreshes.get(id) || refreshAccountEligibility(acc));
      return sendJson(res, 200, result || { quotaSources: Object.values(quotaSources.get(id) || {}), eligibility: eligibilityCache.get(id) });
    }
    if (sub === 'selftest' && req.method === 'POST') {
      const acc = accounts.find((a) => a.label === id);
      if (!acc) return sendJson(res, 404, { ok: false, error: `找不到账号 ${id}` });
      if (acc.disabled) return sendJson(res, 409, { ok: false, error: '账号已停用，请先启用再探测', account: id });
      return sendJson(res, 202, publicSelfTest(startSelfTest(acc)));
    }
    if (sub === 'claim/start' && req.method === 'POST') {
      const acc = accounts.find((a) => a.label === id);
      if (!acc) return sendJson(res, 404, { error: '找不到账号' });
      try {
        const raw = await readBody(req);
        const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        const prepared = await prepareClaim(acc, typeof body.planId === 'string' ? body.planId.trim() : '');
        return sendJson(res, 200, { preparationId: prepared.preparationId, plan: prepared.plan, expiresAt: prepared.expiresAt });
      } catch (error) { return sendJson(res, 409, { error: error.message }); }
    }
    if (sub === 'claim' && req.method === 'POST') {
      return handleClaim(req, res, id);
    }
    if (req.method === 'PATCH') {
      const raw = await readBody(req);
      let body = {};
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {}
      const arr = readAccountRecords();
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
      writeAccountRecords(arr);
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
    return sendJson(res, 200, authConfigView());
  }
  if (url.pathname === '/api/auth/oidc/login' && req.method === 'GET') return handleSsoLogin(req, res);
  if (url.pathname === '/api/auth/oidc/callback' && req.method === 'GET') return handleSsoCallback(req, res, url);
  if (url.pathname === '/api/session' || url.pathname === '/panel/session') {
    if (req.method === 'POST') return handlePanelLogin(req, res);
    if (req.method === 'DELETE') {
      res.setHeader('set-cookie', clearedSessionCookie(req));
      return sendJson(res, 200, { ok: true });
    }
    const session = sessionOf(req);
    const machine = serviceAuthed(req);
    // 免登录模式（既没配置管理密钥也没启用 SSO）：控制台靠这个接口判断是否
    // 显示登录页，必须返回已认证，否则会停在永远进不去的登录页（main 同行为）。
    if (!authEnabled()) {
      return sendJson(res, 200, {
        authenticated: true,
        user: { name: '管理员', email: '', picture: '', provider: session?.provider || 'key' },
      });
    }
    // 未登录返回 401：前端 establishSession() 靠抛异常进入登录页（cnb2api 同款契约）
    if (!session && !machine) return sendJson(res, 401, { authenticated: false, error: '面板未登录', code: 'panel_auth' });
    return sendJson(res, 200, {
      authenticated: true,
      user: { name: '管理员', email: '', picture: '', provider: machine ? 'token' : session.provider },
    });
  }
  if (url.pathname === '/api/auth/settings') {
    // 已启用鉴权时读写都必须已登录；两种登录方式都没配置时放行，
    // 让运维能直接在控制台里启用 SSO，而不必先往环境变量里塞值。
    if (authEnabled() && !panelAuthed(req) && !serviceAuthed(req)) {
      return sendJson(res, 401, { error: '面板未登录或会话已过期', code: 'panel_auth' });
    }
    return handleAuthSettings(req, res, url);
  }
  if (url.pathname === '/panel/state') {
    const required = authEnabled();
    return sendJson(res, 200, {
      authRequired: required,
      authed: required ? panelAuthed(req) || serviceAuthed(req) : true,
    });
  }
  // ── 鉴权门：数据面不经面板会话（推理接口由 API 密钥单独把关），
  //    控制台其余端点在配置管理密钥或启用 SSO 后要求登录 ──
  const dataPlane =
    url.pathname === '/health' ||
    url.pathname === '/' ||
    url.pathname === '/dashboard' ||
    url.pathname.startsWith('/v1/') ||
    url.pathname === '/models' ||
    url.pathname === '/messages' ||
    url.pathname === '/chat/completions' ||
    url.pathname === '/api/auth/config' ||
    url.pathname.startsWith('/api/auth/oidc/') ||
    url.pathname.startsWith('/api/session') ||
    url.pathname.startsWith('/panel/session');
  if (authEnabled() && !dataPlane && !panelAuthed(req) && !serviceAuthed(req)) {
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
      zcodeVersion: clientVersion.snapshot(),
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
  log(`gateway key: ${GATEWAY_KEY ? '(set)' : '(未设置)'}`);
  log(`scheduler: weighted-random topN=${POOL.topN} sticky=${POOL.stickyTtlMin}min`);

  // 服务器生产环境自检提示（一次性）
  if (HOST === '0.0.0.0') {
    const usable = keyDb.keys.filter((k) => !k.deleted && k.enabled).length;
    if (!GATEWAY_KEY && usable === 0) {
      log('WARNING: 还没有任何可用密钥 —— 网关会拒绝所有推理调用（401）');
      log('         请在面板「密钥」页创建一把 key，或设置 GATEWAY_KEY 环境变量');
    }
    if (!GATEWAY_KEY && usable > 0) {
      log(`已启用密钥鉴权（${usable} 把），未带 key 的请求将被 401`);
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

  const claimTick = () => {
    try { claimAutomation.tick(); } catch { log('定时领取任务启动失败，请检查 data/auto-claim.json'); }
  };
  setTimeout(claimTick, 1000).unref();
  setInterval(claimTick, 30000).unref();

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
