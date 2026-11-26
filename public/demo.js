// public/demo.js — /demo 页：单条 SSE 中继给三个 iframe + 可重复执行的浏览器验收剧本
import { connectEvents, sleep } from './common.js';

const logBody = document.getElementById('logBody');
const btnRun = document.getElementById('btnRun');
const btnReset = document.getElementById('btnReset');
const stepItems = [...document.querySelectorAll('#steps li')];

// ---------- 日志 / 步骤 ----------

function log(level, text) {
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.textContent = text;
  logBody.appendChild(line);
  logBody.scrollTop = logBody.scrollHeight;
}

function clearLog() {
  logBody.innerHTML = '';
}

function setStep(index, state) {
  const li = stepItems[index];
  if (!li) return;
  li.classList.remove('active', 'pass', 'fail');
  if (state) li.classList.add(state);
}

function resetSteps() {
  for (const li of stepItems) li.classList.remove('active', 'pass', 'fail');
}

// ---------- 事件中继：父页一条 SSE，转发给 relay=1 的 iframe ----------

const frames = () => [...document.querySelectorAll('.demo-grid iframe')];

function relay(kind, data) {
  for (const frame of frames()) {
    try {
      frame.contentWindow?.postMessage({ source: 'subtitle-demo-relay', kind, data }, location.origin);
    } catch {
      /* iframe 尚未就绪 */
    }
  }
}

connectEvents({
  onSnapshot: (d) => relay('snapshot', d),
  onState: (d) => relay('state', d),
  onAudit: (d) => relay('audit', d),
  onStatus: (d) => relay('status', d),
});

// ---------- 原始 fetch（409 也要拿到响应体） ----------

async function call(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, body: data, replay: res.headers.get('Idempotent-Replay') === 'true' };
}

async function getState() {
  return (await call('GET', '/api/state')).body;
}

function projectionWindow() {
  return document.querySelector('iframe[name="projection"]').contentWindow;
}

async function waitForProjectionHook(timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (projectionWindow().__injectLate && projectionWindow().__getDebug) return;
    } catch {
      /* 跨域? 同源，继续等 */
    }
    await sleep(120);
  }
  throw new Error('投影 iframe 钩子未就绪');
}

// ---------- 自动剧本 ----------

async function runDemo() {
  btnRun.disabled = true;
  btnReset.disabled = true;
  clearLog();
  resetSteps();
  let pass = 0;
  let fail = 0;
  let baseRev = 1; // /api/reset 之后的 revision（reset 也保持版本号全局单调）

  function check(name, condition, detail = '') {
    if (condition) {
      pass += 1;
      log('ok', `  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
    } else {
      fail += 1;
      log('err', `  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    }
    return !!condition;
  }

  async function step(index, title, fn) {
    setStep(index, 'active');
    const failsBefore = fail;
    log('info', `\n【步骤 ${index + 1}】${title}`);
    try {
      await fn();
    } catch (err) {
      check('步骤执行未抛出异常', false, err?.message || String(err));
    }
    setStep(index, fail > failsBefore ? 'fail' : 'pass');
  }

  try {
    await waitForProjectionHook();

    await step(0, '重置为已知状态：A 当班、epoch=1、第 1 句', async () => {
      const r = await call('POST', '/api/reset');
      check('POST /api/reset → 200', r.status === 200, `status=${r.status}`);
      baseRev = r.body.revision;
      await sleep(700); // 让中继事件到达三个 iframe
      const s = await getState();
      check('重置后 activeConsole=A / epoch=1 / currentIndex=0',
        s.activeConsole === 'A' && s.epoch === 1 && s.currentIndex === 0,
        `active=${s.activeConsole}, epoch=${s.epoch}, index=${s.currentIndex}`);
    });

    await step(1, 'A 台正常「切下一句」', async () => {
      const r = await call('POST', '/api/takeover', { console: 'A' });
      check('A 处于当班', r.status === 200 && r.body.activeConsole === 'A');
      const c = await call('POST', '/api/command', {
        commandId: 'demo-next-1', console: 'A', epoch: 1, action: 'next',
      });
      check('next demo-next-1 → 200 且到第 2 句',
        c.status === 200 && c.body.currentIndex === 1,
        `status=${c.status}, index=${c.body?.currentIndex}`);
      await sleep(350);
    });

    await step(2, '模拟切句回执丢失：同一指令号重发，必须是原结果且不多切', async () => {
      const payload = { commandId: 'demo-lost-1', console: 'A', epoch: 1, action: 'next' };
      const first = await call('POST', '/api/command', payload);
      check(`首次发送生效 → 第 3 句 / rev=${baseRev + 2}`,
        first.status === 200 && first.body.currentIndex === 2 && first.body.revision === baseRev + 2,
        `index=${first.body?.currentIndex}, rev=${first.body?.revision}`);

      // 回执丢失：客户端用完全相同的报文重发
      const second = await call('POST', '/api/command', payload);
      check('同号重发带 Idempotent-Replay: true', second.replay === true, `replay=${second.replay}`);
      check('重发返回完全相同的 index/revision',
        second.status === 200 &&
        second.body.currentIndex === first.body.currentIndex &&
        second.body.revision === first.body.revision,
        `重发 index=${second.body?.currentIndex}, rev=${second.body?.revision}`);

      const s = await getState();
      check('服务端实际位置仍停在第 3 句，没有多切一句',
        s.currentIndex === 2 && s.revision === first.body.revision,
        `state index=${s.currentIndex}, rev=${s.revision}`);
      await sleep(350);
    });

    let indexAtHandover;
    await step(3, 'B 台接班：epoch+1，当前字幕（第 3 句）原样保留', async () => {
      const before = await getState();
      indexAtHandover = before.currentIndex;
      const r = await call('POST', '/api/takeover', { console: 'B' });
      check('B 接班 → 200 且 epoch=2', r.status === 200 && r.body.epoch === 2, `epoch=${r.body?.epoch}`);
      check('接班响应中 currentIndex 不变', r.body.currentIndex === indexAtHandover,
        `before=${indexAtHandover}, after=${r.body.currentIndex}`);
      const after = await getState();
      check('接班后服务端 currentIndex 仍相同（投影不跳句）',
        after.currentIndex === indexAtHandover && after.activeConsole === 'B',
        `index=${after.currentIndex}, active=${after.activeConsole}`);
      await sleep(500);
      const dbg = projectionWindow().__getDebug();
      check('投影已同步到接班后的 revision，且仍显示第 3 句内容',
        dbg.appliedRevision === after.revision && dbg.shownZh === after.current.zh,
        `appliedRev=${dbg.appliedRevision}, serverRev=${after.revision}`);
    });

    await step(4, 'A 台一条“未生效的在途指令”落地 → 永久作废（409）', async () => {
      // 该指令在 A 当班时备好（epoch=1），落地时 B 已当班
      const payload = { commandId: 'demo-void-1', console: 'A', epoch: 1, action: 'next' };
      const r = await call('POST', '/api/command', payload);
      check('旧控台指令 → 409 且 voided=true',
        r.status === 409 && r.body.voided === true,
        `status=${r.status}, code=${r.body?.code}`);
      check('错误码为 NOT_ON_DUTY 或 STALE_EPOCH',
        r.body.code === 'NOT_ON_DUTY' || r.body.code === 'STALE_EPOCH', r.body.code);
      const s = await getState();
      check('作废后字幕位置不变', s.currentIndex === indexAtHandover, `index=${s.currentIndex}`);
    });

    await step(5, 'A 台再次接班后，重发同一旧指令 / 新的旧任期指令，仍被围栏拦截', async () => {
      const t = await call('POST', '/api/takeover', { console: 'A' });
      check('A 再次接班 → epoch=3', t.body.epoch === 3, `epoch=${t.body?.epoch}`);

      const retry = await call('POST', '/api/command', {
        commandId: 'demo-void-1', console: 'A', epoch: 1, action: 'next',
      });
      check('重发已作废指令 → 回放同一 409 结果',
        retry.status === 409 && retry.replay === true && retry.body.code === 'NOT_ON_DUTY',
        `status=${retry.status}, replay=${retry.replay}, code=${retry.body?.code}`);

      const freshStale = await call('POST', '/api/command', {
        commandId: 'demo-void-2', console: 'A', epoch: 1, action: 'next',
      });
      check('从未到过服务端的旧任期指令 → STALE_EPOCH 409',
        freshStale.status === 409 && freshStale.body.code === 'STALE_EPOCH',
        `status=${freshStale.status}, code=${freshStale.body?.code}`);

      const s = await getState();
      check('两次拦截后位置依旧不变', s.currentIndex === indexAtHandover, `index=${s.currentIndex}`);
    });

    await step(6, '投影页收到 revision=-999 的迟到刺眼旧消息 → 守卫丢弃，画面不变', async () => {
      const before = projectionWindow().__getDebug();
      const injection = projectionWindow().__injectLate();
      check('注入函数返回 accepted=false', injection.accepted === false);
      check('守卫版本号没有倒退', injection.appliedRevision === before.appliedRevision,
        `applied=${injection.appliedRevision}`);
      check('累计拦截数 +1', injection.ignoredCount >= 1, `ignored=${injection.ignoredCount}`);
      const s = await getState();
      check('画面文字仍是服务端当前句，没有变成“迟到旧消息”',
        injection.shownZh === s.current.zh && !injection.shownZh.includes('迟到'),
        `shown="${injection.shownZh?.slice(0, 18)}…"`);
    });

    await step(7, '投影重连直接恢复当前字幕；A 用新任期继续切句，演出接得上', async () => {
      const sBefore = await getState();
      const dbgReconnect = await projectionWindow().__reconnect();
      check('重连 / 再同步后 appliedRevision = 服务端 rev',
        dbgReconnect.appliedRevision === sBefore.revision,
        `applied=${dbgReconnect.appliedRevision}, server=${sBefore.revision}`);

      const next = await call('POST', '/api/command', {
        commandId: 'demo-after-takeover', console: 'A', epoch: 3, action: 'next',
      });
      check('新任期内合法切句 → 200 且推进到第 4 句',
        next.status === 200 && next.body.currentIndex === 3,
        `index=${next.body?.currentIndex}`);

      // 等待中继 SSE 到达投影 iframe
      const deadline = Date.now() + 3000;
      let dbg;
      while (Date.now() < deadline) {
        dbg = projectionWindow().__getDebug();
        const s = await getState();
        if (dbg.appliedRevision === s.revision && dbg.shownZh === s.current.zh) break;
        await sleep(150);
      }
      const s = await getState();
      check('投影实时跟随到新句（无回跳）',
        dbg.appliedRevision === s.revision && dbg.shownZh === s.current.zh,
        `applied=${dbg.appliedRevision}, server=${s.revision}`);
    });

    log('muted', '\n────────────────────────────────────────');
    if (fail === 0) {
      log('ok', `🎉 全部通过：${pass} 项断言成功，0 项失败。接班语义、幂等与防回退均符合预期。`);
    } else {
      log('err', `⚠ 完成：${pass} 项通过，${fail} 项失败，请检查上面的红色记录。`);
    }
  } finally {
    btnRun.disabled = false;
    btnReset.disabled = false;
  }
}

btnRun.addEventListener('click', runDemo);

btnReset.addEventListener('click', async () => {
  await call('POST', '/api/reset');
  clearLog();
  resetSteps();
  log('muted', '已调用 /api/reset，三个页面将通过实时事件回到示例初始状态。');
});

// 初始提示
log('muted', '准备就绪：点击右上角「▶ 自动播放接班剧本」，或直接在左侧两个控台手动操作。');
