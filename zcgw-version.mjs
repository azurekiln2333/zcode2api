// Ported from zcode-switch src-tauri/src/changelog.rs and quota.rs.
// Copyright (c) 2026 zcode-switch contributors. MIT; see THIRD_PARTY_NOTICES.md.
import fs from 'node:fs';
import path from 'node:path';

export const CLIENT_APP_VERSION = '3.17.2';
const CACHE_TTL_MS = 6 * 3600_000;

export function normalizeVersion(value) {
  const match = typeof value === 'string' && value.trim().match(/^(\d{1,2})\.(\d{1,4})\.(\d{1,4})(?:\.\d+)?$/);
  return match ? match.slice(1, 4).map(Number).join('.') : null;
}

export function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function latestFromChangelog(html) {
  const versions = [...html.matchAll(/(?:release v|releases\/)(\d+\.\d+\.\d+(?:\.\d+)?)/gi)]
    .map((m) => normalizeVersion(m[1])).filter(Boolean);
  return versions.sort(compareVersions).at(-1) || null;
}

export function createVersionManager({ dataDir, url, configuredVersion, fetchImpl = fetch, now = Date.now }) {
  const file = path.join(dataDir, 'zcode-version-cache.json');
  const configured = normalizeVersion(configuredVersion);
  let cache = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (normalizeVersion(saved.version) && Number.isFinite(saved.fetchedAt) && saved.fetchedAt >= 0 && saved.fetchedAt <= now()) {
      cache = { version: normalizeVersion(saved.version), fetchedAt: saved.fetchedAt };
    }
  } catch {}
  let inFlight = null, lastAttempt = -Infinity, lastError = null;
  const stale = () => !cache || now() - cache.fetchedAt > CACHE_TTL_MS;
  const reported = () => [CLIENT_APP_VERSION, configured, cache?.version].filter(Boolean).sort(compareVersions).at(-1);
  const snapshot = () => ({
    reported: reported(), latest: cache?.version || null, bundled: CLIENT_APP_VERSION,
    configured, stale: stale(), checkedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
    error: lastError,
  });
  async function ensureFresh() {
    if (!stale()) return snapshot();
    if (inFlight) { if (!cache) await inFlight; return snapshot(); }
    if (now() - lastAttempt < 60_000) return snapshot();
    lastAttempt = now();
    const firstFetch = !cache;
    inFlight = (async () => {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(firstFetch ? 2000 : 10000) });
        if (!response.ok) throw new Error();
        const version = latestFromChangelog(await response.text());
        if (!version) throw new Error();
        cache = { version: [cache?.version, version].filter(Boolean).sort(compareVersions).at(-1), fetchedAt: now() };
        lastError = null;
        try {
          fs.mkdirSync(dataDir, { recursive: true });
          fs.writeFileSync(file, JSON.stringify(cache, null, 2));
        } catch { lastError = '版本缓存写入失败，本次使用已获取版本'; }
      } catch { lastError = '官方版本查询失败，使用本地已知版本'; }
    })().finally(() => { inFlight = null; });
    // zcode-switch bounds the initial lookup, then refreshes stale caches in background.
    if (firstFetch) await inFlight;
    return snapshot();
  }
  return { reported, snapshot, ensureFresh };
}
