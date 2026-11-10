// SSO settings validation ported from platform2api src/sso.mjs so all four
// consoles validate the same fields the same way. Kept dependency-free; the
// error type is local because this repo has no shared http module.

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'InputError';
    this.status = status;
  }
}

export const DEFAULT_SSO = Object.freeze({
  enabled: false,
  keyLoginEnabled: true,
  issuer: "",
  clientId: "",
  clientSecret: "",
  scope: "openid profile email",
  providerName: "",
  allowedSubjects: [],
  allowedEmails: [],
  callbackUrl: "",
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const loopbackHost = (hostname) =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
const printable = (value) => !/[\x00-\x1f\x7f]/.test(value);

const text = (value, limit, label) => {
  if (typeof value !== "string" || value.length > limit)
    throw new InputError(`${label}格式不正确`);
  return value.trim();
};

// Issuers need HTTPS; loopback HTTP stays available for local mocks and tests.
export function normalizeIssuer(input, allowLocal = false) {
  const value = text(input, 500, "SSO 颁发者");
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InputError("SSO 颁发者须为完整的 HTTP(S) 地址");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new InputError("SSO 颁发者须为完整的 HTTP(S) 地址");
  if (url.protocol === "http:" && !(allowLocal && loopbackHost(url.hostname)))
    throw new InputError("SSO 颁发者须使用 HTTPS 地址");
  if (url.username || url.password || url.search || url.hash)
    throw new InputError("SSO 颁发者不得包含凭据、查询或片段");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function normalizeScope(input) {
  const raw = text(input, 500, "SSO scope");
  if (!raw) throw new InputError("SSO scope 不得为空");
  const scopes = [...new Set(raw.split(/\s+/).filter(Boolean))];
  if (scopes.length > 20) throw new InputError("SSO scope 数量过多");
  if (scopes.some((scope) => !/^[\w.:-]+$/.test(scope)))
    throw new InputError("SSO scope 格式不正确");
  if (!scopes.includes("openid")) throw new InputError("SSO scope 必须包含 openid");
  return scopes.join(" ");
}

function normalizeCallback(input, allowLocal) {
  const value = text(input, 500, "SSO 回调地址");
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InputError("SSO 回调地址须为完整的 HTTP(S) 地址");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new InputError("SSO 回调地址须为完整的 HTTP(S) 地址");
  if (url.protocol === "http:" && !(allowLocal && loopbackHost(url.hostname)))
    throw new InputError("SSO 回调地址须使用 HTTPS 地址");
  if (url.username || url.password || url.hash)
    throw new InputError("SSO 回调地址不得包含凭据或片段");
  return url.toString();
}

function normalizeStringList(input, { label, limit, itemLimit, lower }) {
  if (!Array.isArray(input)) throw new InputError(`${label}须为字符串数组`);
  const result = [];
  for (const entry of input) {
    if (typeof entry !== "string") throw new InputError(`${label}须为字符串数组`);
    const item = entry.trim();
    if (!item) continue;
    if (item.length > itemLimit || !printable(item))
      throw new InputError(`${label}中存在无效条目`);
    const value = lower ? item.toLowerCase() : item;
    if (!result.includes(value)) result.push(value);
  }
  if (result.length > limit) throw new InputError(`${label}最多 ${limit} 条`);
  return result;
}

export function withSsoDefaults(input) {
  const source = input && typeof input === "object" ? input : {};
  const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
  return {
    enabled: source.enabled === true,
    keyLoginEnabled: source.keyLoginEnabled !== false,
    issuer: typeof source.issuer === "string" ? source.issuer : "",
    clientId: typeof source.clientId === "string" ? source.clientId : "",
    clientSecret: typeof source.clientSecret === "string" ? source.clientSecret : "",
    scope:
      typeof source.scope === "string" && source.scope.trim()
        ? source.scope.trim()
        : DEFAULT_SSO.scope,
    providerName: typeof source.providerName === "string" ? source.providerName : "",
    allowedSubjects: list(source.allowedSubjects),
    allowedEmails: list(source.allowedEmails),
    callbackUrl: typeof source.callbackUrl === "string" ? source.callbackUrl : "",
  };
}

// Enabling SSO needs a real issuer, client credentials and an explicit admin
// allowlist. Disabling key login needs working SSO, so a saved configuration
// can never lock the operator out.
function assertSsoPolicy(sso) {
  if (sso.enabled) {
    if (!sso.issuer) throw new InputError("启用 SSO 需要填写颁发者地址");
    if (!sso.clientId) throw new InputError("启用 SSO 需要填写客户端 ID");
    if (!sso.clientSecret) throw new InputError("启用 SSO 需要填写客户端密钥");
    if (!sso.allowedSubjects.length && !sso.allowedEmails.length)
      throw new InputError("启用 SSO 需要至少一个管理员 subject 或已验证邮箱白名单");
  }
  if (!sso.keyLoginEnabled && !sso.enabled)
    throw new InputError("关闭密钥登录前请先启用有效的 SSO");
}

export function validateSso(input, previous = DEFAULT_SSO, { allowLocal = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("请填写 SSO 配置");
  const next = withSsoDefaults(previous);
  for (const key of ["enabled", "keyLoginEnabled"])
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean")
        throw new InputError("SSO 启用状态须为布尔值");
      next[key] = input[key];
    }
  if (input.issuer !== undefined) next.issuer = normalizeIssuer(input.issuer, allowLocal);
  if (input.clientId !== undefined) {
    const value = text(input.clientId, 200, "SSO 客户端 ID");
    if (!printable(value)) throw new InputError("SSO 客户端 ID 含有无效字符");
    next.clientId = value;
  }
  // A blank secret keeps the stored value; only a non-blank value replaces it.
  if (input.clientSecret !== undefined) {
    if (typeof input.clientSecret !== "string" || input.clientSecret.length > 1024)
      throw new InputError("SSO 客户端密钥格式不正确");
    const value = input.clientSecret.trim();
    if (value && !printable(value)) throw new InputError("SSO 客户端密钥含有无效字符");
    if (value) next.clientSecret = value;
  }
  if (input.scope !== undefined) next.scope = normalizeScope(input.scope);
  if (input.providerName !== undefined) next.providerName = text(input.providerName, 60, "SSO 名称");
  if (input.allowedSubjects !== undefined)
    next.allowedSubjects = normalizeStringList(input.allowedSubjects, {
      label: "管理员 subject 白名单",
      limit: 200,
      itemLimit: 200,
      lower: false,
    });
  if (input.allowedEmails !== undefined)
    next.allowedEmails = normalizeStringList(input.allowedEmails, {
      label: "管理员邮箱白名单",
      limit: 200,
      itemLimit: 320,
      lower: true,
    });
  if (next.allowedEmails.some((email) => !/^[^@\s]+@[^@\s]+$/.test(email)))
    throw new InputError("管理员邮箱白名单中存在无效邮箱");
  if (input.callbackUrl !== undefined) next.callbackUrl = normalizeCallback(input.callbackUrl, allowLocal);
  assertSsoPolicy(next);
  return next;
}

// Any saved non-default field means the operator configured the panel, so
// environment bootstrap must never overwrite it.
export function ssoIsConfigured(input) {
  const current = withSsoDefaults(input);
  return Object.keys(DEFAULT_SSO).some(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(DEFAULT_SSO[key]),
  );
}

export function sanitizeSso(sso, callbackUrl = sso.callbackUrl) {
  return {
    ssoEnabled: sso.enabled,
    keyLoginEnabled: sso.keyLoginEnabled,
    issuer: sso.issuer,
    clientId: sso.clientId,
    hasClientSecret: Boolean(sso.clientSecret),
    scope: sso.scope,
    providerName: sso.providerName,
    allowedSubjects: [...sso.allowedSubjects],
    allowedEmails: [...sso.allowedEmails],
    callbackUrl,
  };
}
