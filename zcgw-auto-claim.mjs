import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AUTO_CLAIM_DEFAULTS = { enabled: false, time: '09:00', timezone: 'Asia/Shanghai' };
const formatters = new Map();
function localClock(at, timezone) {
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
  const p = Object.fromEntries(formatters.get(timezone).formatToParts(at).map((v) => [v.type, v.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function validateAutoClaimSettings(input, current = AUTO_CLAIM_DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('定时领取配置必须是对象');
  const result = { ...current };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('定时领取开关必须是布尔值');
    result.enabled = input.enabled;
  }
  if (input.time !== undefined) {
    if (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('每天执行时间必须为 HH:mm');
    result.time = input.time;
  }
  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string' || input.timezone.length > 80) throw new Error('时区无效');
    try { localClock(Date.now(), input.timezone); } catch { throw new Error('时区无效，请使用 Asia/Shanghai 等 IANA 时区'); }
    result.timezone = input.timezone;
  }
  return result;
}

// Run once on the local calendar date, including the first minute after a DST gap.
export function scheduleDue(at, settings, lastDate) {
  const local = localClock(at, settings.timezone);
  return settings.enabled && local.date !== lastDate && local.time >= settings.time ? local.date : null;
}
export function nextScheduledAt(at, settings, lastDate) {
  if (!settings.enabled) return null;
  if (scheduleDue(at, settings, lastDate)) return new Date(at).toISOString();
  for (let t = Math.floor(at / 60000) * 60000 + 60000; t <= at + 50 * 3600000; t += 60000) {
    if (scheduleDue(t, settings, lastDate)) return new Date(t).toISOString();
  }
  return null;
}

function offerKey(account, plan) {
  // Names are display-only. Campaign/window changes identify a new grant with a reused plan ID.
  return crypto.createHash('sha256').update(JSON.stringify([
    account.label, plan.planId, plan.campaign?.campaignId, plan.campaign?.startsAt,
    plan.startsAt, plan.effectiveAt, plan.endsAt,
  ])).digest('hex');
}

/** Durable daily scheduler. All external effects are injected for deterministic tests. */
export function createClaimAutomation({ dataDir, getAccounts, reserve, release, refreshAccount, prepare, verify,
  submit, afterClaim, closeVerifier = async () => {}, browserStatus = () => null, now = Date.now, reportError = () => {} }) {
  const file = path.join(dataDir, 'auto-claim.json');
  let state = { settings: { ...AUTO_CLAIM_DEFAULTS }, lastScheduledDate: null, run: null, marks: {} };
  let storageError = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = { ...state, ...saved, settings: validateAutoClaimSettings(saved.settings) };
    if (!state.marks || typeof state.marks !== 'object' || Array.isArray(state.marks)) throw new Error('invalid marks');
  } catch (error) {
    if (error.code !== 'ENOENT') storageError = '定时领取记录无法读取，已停止自动领取；请检查 data/auto-claim.json';
  }
  let active = null;
  let cancelled = false;
  let nextCache = null;
  const stamp = () => new Date(now()).toISOString();
  function persist() {
    if (storageError) throw new Error(storageError);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    nextCache = null;
  }
  if (state.run?.status === 'running' || state.run?.status === 'stopping') {
    state.run.status = 'interrupted';
    state.run.finishedAt = stamp();
    state.run.error = '网关重启中断了任务；已发送但未确认的领取不会自动重发';
    try { persist(); } catch (error) { storageError = error.message; }
  }
  function snapshot() {
    const at = now();
    const key = `${Math.floor(at / 60000)}:${state.lastScheduledDate}:${JSON.stringify(state.settings)}`;
    if (nextCache?.key !== key) nextCache = { key, value: storageError ? null : nextScheduledAt(at, state.settings, state.lastScheduledDate) };
    return structuredClone({ settings: state.settings, nextRunAt: nextCache.value, running: !!active,
      lastRun: state.run, error: storageError, browser: browserStatus() });
  }
  function configure(input) {
    const settings = validateAutoClaimSettings(input, state.settings);
    const previous = state.settings;
    state.settings = settings;
    try { persist(); } catch (error) { state.settings = previous; throw error; }
    if (!settings.enabled && state.run?.source === 'scheduled') cancel();
    return snapshot();
  }
  function cancel() {
    if (active) {
      cancelled = true;
      state.run.status = 'stopping';
      persist();
      void closeVerifier().catch(reportError);
    }
    return snapshot();
  }
  function record(account, plan, status, message) {
    state.run.results.push({ accountId: account.label, accountName: account.name || account.label,
      planId: plan?.planId || null, planName: plan?.name || null, status, message, at: stamp() });
    persist();
  }
  async function execute(targets) {
    try {
      for (const original of targets) {
        if (cancelled) break;
        const acc = getAccounts().find((a) => a.label === original.label && !a.disabled);
        if (!acc) continue;
        state.run.accountName = acc.name || acc.label;
        if (!reserve(acc)) {
          record(acc, null, 'skipped', '账号正在手动领取，已跳过');
          state.run.done++;
          continue;
        }
        const identity = `${acc.jwt}:${acc.deviceId}`;
        const current = () => !cancelled && getAccounts().some((a) => a.label === acc.label && !a.disabled && `${a.jwt}:${a.deviceId}` === identity);
        try {
          const { eligibility } = await refreshAccount(acc);
          if (!current()) continue;
          const queryError = [eligibility.error, eligibility.activation?.error, eligibility.currentError].filter(Boolean).join('；');
          if (!eligibility.plans.length) {
            record(acc, null, queryError ? 'failed' : 'empty', queryError || '暂无可领取套餐');
            continue;
          }
          if (queryError) record(acc, null, 'failed', queryError);
          for (const plan of eligibility.plans) {
            if (!current()) break;
            const start = plan.campaign?.startsAt ?? plan.startsAt;
            const end = plan.campaign?.endsAt ?? plan.endsAt;
            if ((start && start > now()) || (end && end <= now())) {
              record(acc, plan, 'skipped', start > now() ? '活动尚未开始' : '活动已结束');
              continue;
            }
            const key = offerKey(acc, plan);
            const mark = state.marks[key];
            if (mark && (!mark.retryAt || mark.retryAt > now())) {
              record(acc, plan, mark.status === 'pending' ? 'unknown' : 'skipped',
                mark.status === 'pending' ? '上次提交结果未知，请刷新套餐并人工确认；不会自动重发' : '本活动已处理，已跳过重复领取');
              continue;
            }
            let submitted = false;
            try {
              const prepared = await prepare(acc, plan.planId);
              if (!current()) break;
              const proof = await verify(current);
              if (!current()) break;
              // A crash or timeout after this point must never lead to a replay.
              state.marks[key] = { status: 'pending', at: stamp() };
              persist();
              submitted = true;
              const result = await submit(acc, prepared, proof);
              if (result.unknown) {
                record(acc, plan, 'unknown', '提交结果未知，请刷新套餐并人工确认；不会自动重发');
                break;
              }
              const status = result.ok ? 'claimed' : result.alreadyClaimed ? 'already_claimed' : 'failed';
              state.marks[key] = { status, at: stamp(), retryAt: result.ok || result.alreadyClaimed ? null
                : Math.max(now() + 86400000, result.nextAt || 0) };
              record(acc, plan, status, result.ok ? '领取成功' : result.msg || '领取失败');
              if (result.ok || result.alreadyClaimed) {
                try { await afterClaim(acc); } catch { record(acc, plan, 'failed', '领取已确认，额度刷新失败，请稍后刷新'); }
              }
              // A rejected proof or business failure is terminal for this account in this round.
              if (!result.ok && !result.alreadyClaimed) break;
            } catch (error) {
              if (!current() && !submitted) break;
              record(acc, plan, submitted ? 'unknown' : ['captcha_interactive', 'browser_unavailable'].includes(error.code) ? 'needs_verification' : 'failed',
                submitted ? '提交结果未知，请刷新套餐并人工确认；不会自动重发' : error.message || '领取准备失败');
              break;
            }
          }
        } catch (error) {
          record(acc, null, 'failed', error.message || '资格查询失败');
        } finally {
          release(acc);
          state.run.done++;
          persist();
        }
      }
      state.run.status = cancelled ? 'cancelled' : 'completed';
    } catch (error) {
      state.run.status = 'failed';
      state.run.error = '任务未完成，请检查数据目录权限及服务日志';
      reportError(error);
    } finally {
      await closeVerifier().catch(reportError);
      state.run.finishedAt = stamp();
      state.run.accountName = null;
      active = null;
      try { persist(); } catch (error) { storageError = '任务记录保存失败，已停止自动领取'; reportError(error); }
    }
  }
  function start(source = 'manual', scheduledDate = null) {
    if (active) return snapshot();
    if (storageError) throw new Error(storageError);
    const targets = getAccounts().filter((a) => !a.disabled);
    state.run = { id: crypto.randomUUID(), source, status: 'running', startedAt: stamp(), finishedAt: null,
      total: targets.length, done: 0, results: [], error: null, accountName: null };
    if (scheduledDate) state.lastScheduledDate = scheduledDate;
    cancelled = false;
    persist();
    // Defer execution until the durable reservation and active promise are visible.
    active = Promise.resolve().then(() => execute(targets));
    return snapshot();
  }
  function tick() {
    if (active || storageError) return;
    const date = scheduleDue(now(), state.settings, state.lastScheduledDate);
    if (date) start('scheduled', date);
  }
  return { snapshot, configure, start, cancel, tick, settled: () => active || Promise.resolve() };
}
