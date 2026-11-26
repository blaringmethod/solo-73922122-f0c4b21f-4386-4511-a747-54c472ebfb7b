// public/console.js — 控台交互：当班操作、接班、幂等重发、在途旧指令演示、审计流
import { api, connectEvents, uuid, sleep, escapeHtml, shortId, formatTime, getConsoleIdFromLocation } from './common.js';

if (new URLSearchParams(location.search).get('embed') === '1') {
  document.body.classList.add('embed');
}

const me = getConsoleIdFromLocation();
const other = me === 'A' ? 'B' : 'A';

const el = {
  badge: document.getElementById('consoleIdBadge'),
  title: document.getElementById('consoleTitle'),
  topSub: document.getElementById('topSub'),
  dutyBadge: document.getElementById('dutyBadge'),
  dutyText: document.getElementById('dutyText'),
  epoch: document.getElementById('epochText'),
  rev: document.getElementById('revText'),
  conn: document.getElementById('connState'),
  connText: document.getElementById('connText'),
  airZh: document.getElementById('airZh'),
  airEn: document.getElementById('airEn'),
  airIndex: document.getElementById('airIndex'),
  btnNext: document.getElementById('btnNext'),
  btnPrev: document.getElementById('btnPrev'),
  btnTakeover: document.getElementById('btnTakeover'),
  lineList: document.getElementById('lineList'),
  loseAck: document.getElementById('optLoseAck'),
  btnDelay: document.getElementById('btnDelayNext'),
  btnResend: document.getElementById('btnResend'),
  result: document.getElementById('resultBox'),
  audit: document.getElementById('auditList'),
};

el.badge.textContent = me;
el.badge.classList.add(me);
el.title.textContent = `控台 ${me}`;
el.topSub.textContent = `我是 ${me} 号字幕员 · 另一台为 ${other} 台`;
document.title = `字幕控台 ${me}`;

/** @type {any} */
let state = null;
/** 最近一条“逻辑指令”的完整报文（含同一 commandId 与发出时的 epoch），重发必须原样使用 */
let lastInstruction = null;

// ---------- 渲染 ----------

function onDuty() {
  return state?.activeConsole === me;
}

function render() {
  if (!state || !Array.isArray(state.script)) return;
  const duty = onDuty();

  el.epoch.textContent = state.epoch;
  el.rev.textContent = state.revision;

  el.dutyBadge.className = `badge ${duty ? 'live' : state.activeConsole ? 'off' : ''}`;
  el.dutyText.textContent = duty
    ? `● ${me} 台当班中`
    : state.activeConsole
      ? `${state.activeConsole} 台当班 · 本台已交班`
      : '无人当班';

  el.btnTakeover.disabled = duty;
  el.btnTakeover.textContent = duty ? '✓ 本台正在当班' : `🙋 ${me} 台申请接班（${state.activeConsole} 台交班）`;

  for (const btn of [el.btnNext, el.btnPrev, el.btnDelay]) btn.disabled = !duty;
  el.btnNext.title = duty ? '' : `只有当班控台可操作，请先点「申请接班」`;

  // 投影预览
  const line = state.current;
  el.airZh.textContent = line?.zh || '（待机 · 暂无台词）';
  el.airEn.textContent = line?.en || '';
  el.airIndex.textContent = line
    ? `正在上屏：第 ${state.currentIndex + 1} / ${state.total} 句`
    : `共 ${state.total} 句，尚未开场`;

  // 台词列表
  el.lineList.innerHTML = state.script
    .map(
      (l) => `
      <div class="line-row ${l.index === state.currentIndex ? 'current' : ''}" data-index="${l.index}" role="button" tabindex="0"
           aria-label="重播第 ${l.index + 1} 句">
        <div class="num">${l.index === state.currentIndex ? '▶' : l.index + 1}</div>
        <div class="txt">
          <div class="zh">${escapeHtml(l.zh)}</div>
          <div class="en">${escapeHtml(l.en)}</div>
        </div>
        <div>${l.index === state.currentIndex ? '<span class="here">上屏中</span>' : ''}<button class="btn small" data-replay="${l.index}" type="button">重播</button></div>
      </div>`,
    )
    .join('');

  el.btnResend.disabled = !lastInstruction;
}

function setConn(mode) {
  el.conn.className = `conn ${mode === 'open' ? 'open' : mode === 'reconnecting' ? 'reconnecting' : ''}`;
  el.connText.textContent =
    mode === 'open' ? '实时连接' : mode === 'relay' ? '演示中继' : mode === 'reconnecting' ? '断线重连中…' : mode === 'closed' ? '连接关闭' : '连接中…';
}

// ---------- 结果框 ----------

function showResult(kind, html) {
  el.result.className = `result-box show ${kind === 'good' ? 'good' : kind === 'bad' ? 'bad' : ''}`;
  el.result.innerHTML = html;
}

function describeResult(result, opts = {}) {
  const b = result.body || {};
  const replay = result.replay || opts.resendReplay;
  const tags = [
    opts.lostAck ? '<span class="tag-lost">模拟回执丢失</span>' : '',
    replay ? '<span class="tag-replay">幂等重放 · 原结果</span>' : '',
    b.voided ? '<span class="tag-void">已作废</span>' : '',
  ].join('');

  if (result.ok) {
    const pos = Number.isInteger(b.currentIndex) ? `第 ${b.currentIndex + 1} 句` : '-';
    return `
      <div class="title">✅ ${escapeHtml(b.verb || '指令已处理')} ${tags}</div>
      ${opts.lostAck ? '<div>第一次请求已到达服务端，但响应（回执）被模拟丢弃；随后用<b>同一指令号</b>重发，服务端没有再次执行。</div>' : ''}
      ${replay ? '<div>响应头 <code>Idempotent-Replay: true</code>，以下为首次处理结果的原样返回。</div>' : ''}
      <div>指令号 <code>${escapeHtml(shortId(b.commandId))}</code> · HTTP ${result.status} · 位置 <b>${pos}</b> · rev=<b>${b.revision ?? '-'}</b> · epoch=${b.epoch ?? '-'}</div>
      ${b.atEnd ? '<div>已在台词边界，位置未改变。</div>' : ''}
    `;
  }
  return `
    <div class="title">⛔ 指令未生效 ${tags}</div>
    <div>${escapeHtml(b.message || `HTTP ${result.status}`)}</div>
    <div style="margin-top:5px">HTTP ${result.status} · <code>${escapeHtml(b.code || 'ERROR')}</code> · 指令号 <code>${escapeHtml(shortId(b.commandId || lastInstruction?.commandId))}</code></div>
    <div>该结果已按指令号保存。即使本台再次接班，点「🔁 重发上一条指令」拿到的仍是同一份结果，不会切句。</div>
  `;
}

function showOutcome({ result, error, lostAck = false, resend = false }) {
  if (result) {
    showResult(result.ok ? 'good' : 'bad', describeResult(result, { lostAck, resendReplay: resend && result.replay }));
  } else if (error?.result) {
    showResult('bad', describeResult(error.result, { lostAck }));
  } else {
    showResult(
      'bad',
      `<div class="title">📡 网络错误 / 回执可能已丢失</div>
       <div>${escapeHtml(error?.message || '请求未得到响应')}</div>
       <div>服务端可能已经执行。请直接点「🔁 重发上一条指令（同指令号）」，若已生效会返回原结果而不会多切一句。</div>`,
    );
  }
}

// ---------- 指令发送 ----------

function buildCommand(action, extra = {}) {
  if (!state) {
    showResult('bad', '<div class="title">状态尚未加载</div>');
    return null;
  }
  return {
    console: me,
    action,
    epoch: state.epoch, // 发出时观察到的任期 = 围栏令牌
    commandId: uuid(), // 一条逻辑指令一个号，重发绝不变号
    ...extra,
  };
}

async function sendWithNetworkRetry(body) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await api('/api/command', { method: 'POST', body });
    } catch (err) {
      lastErr = err;
      if (!err.network) throw err; // 收到了 4xx/5xx，不是回执丢失
      await sleep(450 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** 所有指令的唯一出口；body 必须携带固定 commandId，重发时传入同一对象 */
async function postCommand(body, { simulateLostAck = false, resend = false } = {}) {
  lastInstruction = body;
  el.btnResend.disabled = false;

  if (simulateLostAck) {
    showResult(
      '',
      `<div class="title">📤 首条请求已发出，回执模拟丢失…</div>
       <div>指令号 <code>${escapeHtml(shortId(body.commandId))}</code>；700ms 后将用<b>完全相同的报文与指令号</b>重发。</div>`,
    );
    // 请求照常到达服务端并被处理，只是客户端假装没收到响应。
    const firstAttempt = api('/api/command', { method: 'POST', body }).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    await sleep(700);
    let outcome;
    try {
      outcome = { result: await api('/api/command', { method: 'POST', body }) };
    } catch (error) {
      outcome = { error };
    }
    const first = await firstAttempt; // 避免 unhandled rejection
    if (first.error?.network) {
      showOutcome({ ...outcome, lostAck: true });
    } else {
      showOutcome({ ...outcome, lostAck: true });
    }
    return;
  }

  try {
    const result = await sendWithNetworkRetry(body);
    showOutcome({ result, resend });
  } catch (error) {
    showOutcome({ error, resend });
  }
}

function requireDuty() {
  if (onDuty()) return true;
  showResult(
    'bad',
    `<div class="title">🔒 本台当前不是当班控台</div>
     <div>当前由 <b>${state?.activeConsole ?? '?'}</b> 台当班。请点「申请接班」，或到 ${state?.activeConsole || '另一'} 台操作。</div>`,
  );
  return false;
}

el.btnNext.addEventListener('click', () => {
  if (!requireDuty()) return;
  const body = buildCommand('next');
  if (!body) return;
  const lose = el.loseAck.checked;
  el.loseAck.checked = false;
  postCommand(body, { simulateLostAck: lose });
});

el.btnPrev.addEventListener('click', () => {
  if (!requireDuty()) return;
  const body = buildCommand('prev');
  if (!body) return;
  postCommand(body);
});

el.lineList.addEventListener('click', (event) => {
  const row = event.target.closest('.line-row');
  if (!row) return;
  if (!requireDuty()) return;
  const index = Number(row.dataset.index);
  const body = buildCommand('goto', { index });
  if (!body) return;
  const lose = el.loseAck.checked;
  el.loseAck.checked = false;
  postCommand(body, { simulateLostAck: lose });
});

el.lineList.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('.line-row');
  if (!row) return;
  event.preventDefault();
  row.click();
});

el.btnResend.addEventListener('click', () => {
  if (!lastInstruction) {
    showResult('', '<div class="title">还没有可重发的指令</div><div>先执行一次切句 / 重播，再来重发。</div>');
    return;
  }
  // 关键：原样重发，commandId 与 epoch 都不变。
  postCommand(lastInstruction, { resend: true });
});

el.btnTakeover.addEventListener('click', async () => {
  el.btnTakeover.disabled = true;
  try {
    const r = await api('/api/takeover', { method: 'POST', body: { console: me } });
    showResult(
      'good',
      `<div class="title">🙋 ${me} 台已接班 ${r.body.changed ? '（新任期 epoch=' + r.body.epoch + '）' : ''}</div>
       <div>${escapeHtml(r.body.message)} 当前仍是第 ${r.body.currentIndex + 1} 句，投影字幕未改变。</div>`,
    );
  } catch (err) {
    showOutcome({ error: err });
  } finally {
    render();
  }
});

// 延迟在途指令：在点击瞬间固定 commandId 与 epoch，3 秒后才真正发出
el.btnDelay.addEventListener('click', () => {
  if (!requireDuty()) return;
  const body = buildCommand('next');
  if (!body) return;

  let remain = 3;
  const original = el.btnDelay.textContent;
  el.btnDelay.disabled = true;
  el.btnDelay.textContent = `⏳ ${remain}s 后发出…请立刻去 ${other} 台接班`;
  showResult(
    '',
    `<div class="title">⏱ 已预备一条“在途指令”（尚未生效）</div>
     <div>指令号 <code>${escapeHtml(shortId(body.commandId))}</code>，携带任期 epoch=<b>${body.epoch}</b>。</div>
     <div>${remain} 秒后发出。<b>现在请立即到控台 ${other} 点「申请接班」</b>；指令落地时将因任期过期 / 非当班被作废。</div>`,
  );

  const timer = setInterval(() => {
    remain -= 1;
    if (remain > 0) {
      el.btnDelay.textContent = `⏳ ${remain}s 后发出…请立刻去 ${other} 台接班`;
      return;
    }
    clearInterval(timer);
    el.btnDelay.disabled = false;
    el.btnDelay.textContent = original;
    postCommand(body);
  }, 1000);
});

// ---------- 审计 ----------

const KIND_LABEL = {
  command: '切句',
  replay: '幂等重发',
  void: '作废',
  takeover: '接班',
  script: '台词本',
  reset: '重置',
};

function auditHtml(entry) {
  return `<li><time>${formatTime(entry.at)}</time><div><span class="kind kind-${entry.kind}">${KIND_LABEL[entry.kind] || entry.kind}</span>${escapeHtml(entry.message || '')}</div></li>`;
}

function prependAudit(entry) {
  const placeholder = el.audit.querySelector('li.muted');
  if (placeholder) placeholder.remove();
  el.audit.insertAdjacentHTML('afterbegin', auditHtml(entry));
  while (el.audit.children.length > 30) el.audit.lastElementChild?.remove();
}

// ---------- 启动：先拉全量，再订阅增量 ----------

async function boot() {
  try {
    state = await api('/api/state').then((r) => r.body);
    render();
  } catch (err) {
    setConn('closed');
    showResult('bad', `<div class="title">无法加载状态</div><div>${escapeHtml(err.message)}</div>`);
  }

  try {
    const audit = await api('/api/audit').then((r) => r.body);
    if (Array.isArray(audit.entries) && audit.entries.length) {
      el.audit.innerHTML = audit.entries.slice(-12).reverse().map(auditHtml).join('');
    }
  } catch {
    /* audit 可选 */
  }

  connectEvents({
    onStatus: setConn,
    onSnapshot: (s) => {
      state = s;
      render();
    },
    onState: (s) => {
      state = s;
      render();
    },
    onAudit: prependAudit,
  });
}

boot();
