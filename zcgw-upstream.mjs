// Ported from zcode-switch quota.rs: curl first, native runtime fallback.
// Copyright (c) 2026 zcode-switch contributors. MIT; see THIRD_PARTY_NOTICES.md.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const escapeConfig = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
export async function curlRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 25000 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcgw-http-'));
  try {
    const headerFile = path.join(dir, 'headers');
    const config = [
      `url = "${escapeConfig(url)}"`, `request = "${escapeConfig(method)}"`, 'silent', 'show-error',
      'connect-timeout = "10"', `max-time = "${timeoutMs / 1000}"`,
      'write-out = "\\n%{http_code}"', `dump-header = "${escapeConfig(headerFile)}"`,
      ...Object.entries(headers).map(([name, value]) => `header = "${escapeConfig(`${name}: ${value}`)}"`),
      ...(body === undefined ? [] : [`data-raw = "${escapeConfig(body)}"`]),
    ].join('\n') + '\n';
    const raw = await new Promise((resolve, reject) => {
      const child = spawn(process.platform === 'win32' ? 'C:/Windows/System32/curl.exe' : 'curl', ['-K', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      const chunks = []; let bytes = 0;
      const timer = setTimeout(() => child.kill(), timeoutMs + 1000);
      child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
      child.stderr.on('data', () => {}); // Never surface a transport command or credential.
      child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error('curl unavailable'), { notStarted: true })); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error('curl transport failed'));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin.end(config);
    });
    const split = raw.trimEnd().lastIndexOf('\n');
    const status = Number(raw.trimEnd().slice(split + 1));
    if (split < 0 || status < 100 || status > 599) throw new Error('curl invalid status');
    const responseHeaders = new Headers();
    for (const line of (await readFile(headerFile, 'utf8')).split(/\r?\n/)) {
      if (line.startsWith('HTTP/')) { for (const name of [...responseHeaders.keys()]) responseHeaders.delete(name); }
      else if (line.includes(':')) {
        const at = line.indexOf(':');
        responseHeaders.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
      }
    }
    return { status, ok: status >= 200 && status < 300, headers: responseHeaders, body: raw.slice(0, split), transport: 'curl' };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function zcodeRequest(url, options = {}) {
  if (process.env.ZCODE_HTTP_TRANSPORT !== 'fetch') {
    try {
      const response = await curlRequest(url, options);
      if (response.status >= 400 || response.body.trim() || options.retryTransport === false) return response;
    } catch (error) {
      // A one-time captcha must not be replayed after an ambiguous submission.
      if (options.retryTransport === false && !error.notStarted) throw new Error('领取请求未能确认结果，请刷新套餐后再操作');
    }
  }
  try {
    const response = await fetch(url, { method: options.method || 'GET', headers: options.headers,
      body: options.body, signal: AbortSignal.timeout(options.timeoutMs || 25000) });
    const body = await response.text();
    if (!body.trim() && response.status < 400 && options.retryTransport !== false) throw new Error();
    return { status: response.status, ok: response.ok, headers: response.headers, body, transport: 'fetch' };
  } catch { throw new Error('上游请求失败或超时'); }
}

export function responseJson(response) {
  try { return JSON.parse(response.body.replace(/^\uFEFF/, '').trim()); } catch { return null; }
}
