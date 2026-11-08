import crypto from 'node:crypto';

const failure = (message, code = 'browser_unavailable') => Object.assign(new Error(message), { code });
const validId = (value) => typeof value === 'string' && /^[\w-]{16,80}$/.test(value);

/** Memory-only, single-use proof handoff. The scheduler remains the sole claim submitter. */
export function createPanelCaptcha({ now = Date.now, timeoutMs = 45000, clientTtlMs = 90000 } = {}) {
  const clients = new Map();
  let pending = null;
  function prune() {
    for (const [id, client] of clients) if (client.at + clientTtlMs <= now()) clients.delete(id);
  }
  function status() {
    prune();
    return { mode: 'panel', connectedPanels: [...clients.values()].filter((c) => c.available).length };
  }
  function finish(error, proof) {
    const task = pending;
    if (!task) return;
    pending = null;
    clearTimeout(task.timer);
    if (error) task.reject(error); else task.resolve(proof);
  }
  function poll({ clientId, available }) {
    if (!validId(clientId) || typeof available !== 'boolean') throw failure('浏览器会话参数无效');
    prune();
    // Bound stale clients even when tabs are repeatedly opened or sessions change.
    if (!clients.has(clientId) && clients.size >= 64) clients.delete(clients.keys().next().value);
    clients.set(clientId, { at: now(), available });
    if (!pending || pending.assignee || !available || pending.expiresAt <= now()) return { task: null };
    pending.assignee = clientId;
    return { task: { id: pending.id, expiresAt: pending.expiresAt, config: pending.config } };
  }
  function verify(config) {
    if (pending) return Promise.reject(failure('已有自动验证正在进行'));
    if (!config.enabled || !config.sceneId) return Promise.reject(failure('上游验证码配置不可用', 'captcha_unavailable'));
    if (!status().connectedPanels) return Promise.reject(failure('没有在线且空闲的面板浏览器；请保持已登录面板打开，或配置外部浏览器后重试'));
    return new Promise((resolve, reject) => {
      pending = { id: crypto.randomUUID(), assignee: null, expiresAt: now() + timeoutMs, resolve, reject,
        config: { enabled: true, sceneId: config.sceneId, region: config.region, prefix: config.prefix },
        timer: setTimeout(() => finish(failure('面板浏览器验证超时或已离线，本次未提交领取；请重新检测')), timeoutMs) };
    });
  }
  function complete({ clientId, taskId, param, error }) {
    if (!pending || pending.id !== taskId || pending.assignee !== clientId || !validId(clientId)
      || pending.expiresAt <= now()) return false;
    if (error !== undefined) {
      finish(error === 'captcha_interactive'
        ? failure('需要人工验证，请到账号管理中点击领取完成验证', 'captcha_interactive')
        : failure('面板浏览器未完成验证，本次未提交领取；请重新检测'));
    } else {
      if (typeof param !== 'string' || !param.trim() || param.length > 32768) throw failure('验证参数无效', 'captcha_unavailable');
      finish(null, { param: param.trim(), region: pending.config.region });
    }
    return true;
  }
  async function close() { finish(failure('自动验证已取消', 'captcha_cancelled')); }
  return { poll, verify, complete, close, status };
}
