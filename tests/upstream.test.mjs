import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { curlRequest, zcodeRequest, responseJson } from '../zcgw-upstream.mjs';

test('curl transports request bodies and challenge headers; fallback never retries semantic failures or a submitted claim', async (t) => {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    hits.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url === '/challenge') {
      res.writeHead(403, { 'x-aliyun-captcha-verify-param': 'challenge-test' });
      return res.end('captcha');
    }
    if (req.url === '/empty') return res.end();
    if (req.url === '/drop') return req.socket.destroy();
    if (req.url === '/missing') { res.writeHead(404); return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end('\uFEFF{"code":0}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await curlRequest(`${base}/claim`, { method: 'POST', headers: { authorization: 'Bearer test-only', 'x-aliyun-captcha-verify-region': 'sgp' }, body: JSON.stringify({ plan_id: '任意 "quoted" \\ plan' }) });
  assert.equal(response.transport, 'curl');
  assert.deepEqual(responseJson(response), { code: 0 });
  assert.deepEqual(JSON.parse(hits[0].body), { plan_id: '任意 "quoted" \\ plan' });
  assert.equal(hits[0].headers['x-aliyun-captcha-verify-region'], 'sgp');
  const challenged = await zcodeRequest(`${base}/challenge`);
  assert.equal(challenged.status, 403);
  assert.equal(challenged.headers.get('x-aliyun-captcha-verify-param'), 'challenge-test');
  assert.equal(hits.filter((h) => h.path === '/challenge').length, 1);
  assert.equal((await zcodeRequest(`${base}/missing`)).status, 404);
  assert.equal(hits.filter((h) => h.path === '/missing').length, 1);
  await assert.rejects(zcodeRequest(`${base}/empty`), /上游请求失败/);
  assert.equal(hits.filter((h) => h.path === '/empty').length, 2, 'empty successful GET can fall back to native HTTP');
  await assert.rejects(zcodeRequest(`${base}/drop`, { method: 'POST', body: '{}', retryTransport: false }), /未能确认结果/);
  assert.equal(hits.filter((h) => h.path === '/drop').length, 1, 'ambiguous one-time claim must not be replayed');
});
