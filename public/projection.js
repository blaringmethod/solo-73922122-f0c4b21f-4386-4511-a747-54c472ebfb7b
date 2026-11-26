// public/projection.js — 投影页：权威快照 + 单调 revision 围栏，迟到旧消息绝不渲染
import { api, connectEvents, sleep } from './common.js';
import { createRevisionGuard } from './rev-guard.js';

if (new URLSearchParams(location.search).get('embed') === '1') {
  document.body.classList.add('embed');
}

const $ = (id) => document.getElementById(id);
const cue = $('cue');
const cueZh = $('cueZh');
const cueEn = $('cueEn');
const cueDivider = $('cueDivider');
const posLabel = $('posLabel');
const revLabel = $('revLabel');
const connState = $('connState');
const connText = $('connText');
const staleLabel = $('staleLabel');
const staleCount = $('staleCount');

// 版本围栏：只接受 revision 单调不减的状态（reset 也保持 revision 继续递增）。
const guard = createRevisionGuard(0);
let lastCueNonce = null;
let stream = null;
let hasOpenedBefore = false;

function setConn(mode) {
  connState.className = `conn ${mode === 'open' ? 'open' : mode === 'reconnecting' ? 'reconnecting' : ''}`;
  connText.textContent =
    mode === 'open' ? '实时' : mode === 'relay' ? '中继' : mode === 'reconnecting' ? '重连中…' : mode === 'closed' ? '已断开' : '连接中…';
}

/**
 * 所有状态（首屏 REST、SSE snapshot/state、重连刷新、人工注入）的唯一入口。
 * @returns {boolean} 是否被接受并渲染
 */
function renderState(state) {
  if (!state || !Number.isInteger(state.revision)) return false;

  // 关键防线：迟到 / 乱序的旧 revision 直接丢弃，不触碰任何 DOM。
  if (!guard.accept(state.revision)) {
    staleCount.textContent = String(guard.ignoredCount);
    staleLabel.classList.add('show');
    return false;
  }

  revLabel.textContent = String(state.revision);

  const line = state.current;
  if (!line) {
    cue.classList.add('standby');
    cueZh.textContent = '待 命';
    cueEn.textContent = 'STANDBY';
    cueDivider.style.display = 'none';
    posLabel.textContent = '';
  } else {
    cue.classList.remove('standby');
    cueZh.textContent = line.zh || '';
    cueEn.textContent = line.en || '';
    cueDivider.style.display = line.en ? '' : 'none';
    posLabel.textContent = `${state.currentIndex + 1} / ${state.total}`;
  }

  // 只有 cueNonce 变化（切句 / 重播）才重放入场动画；接班等 revision 变化不闪烁。
  if (lastCueNonce !== state.cueNonce) {
    lastCueNonce = state.cueNonce;
    cue.classList.remove('animate');
    void cue.offsetWidth; // 强制 reflow 以重启动画
    cue.classList.add('animate');
  }
  return true;
}

async function refreshState() {
  try {
    const state = await api('/api/state').then((r) => r.body);
    renderState(state);
  } catch {
    setConn('closed');
  }
}

function startStream() {
  stream = connectEvents({
    onStatus: (mode) => {
      setConn(mode);
      // 真正的 EventSource 重连成功后，除 snapshot 外再显式拉一次权威当前状态。
      if (mode === 'open') {
        if (hasOpenedBefore) refreshState();
        hasOpenedBefore = true;
      }
    },
    onSnapshot: renderState,
    onState: renderState,
  });
}

// 启动：先直接拉当前字幕（不等 SSE），再订阅。
refreshState();
startStream();

// 双击舞台全屏
document.getElementById('stage').addEventListener('dblclick', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.();
});

// 纯净模式：隐藏 HUD / 演示工具
document.getElementById('btnClean').addEventListener('click', (e) => {
  document.body.classList.toggle('clean');
  e.currentTarget.textContent = document.body.classList.contains('clean') ? '退出纯净模式' : '🧹 纯净模式';
});

// ---- 演示 / 自动测试钩子 ----

// 注入一条 revision 极旧、内容刺眼的“迟到消息”，必须被围栏拦截，画面不变。
window.__injectLate = function injectLate() {
  // 构造一条同一版本流中“严重迟到”的消息：revision 远小于当前已应用版本。
  const staleRevision = guard.appliedRevision - 1000;
  const fake = {
    revision: staleRevision,
    cueNonce: -9999,
    currentIndex: 0,
    total: 99,
    current: { zh: '【迟到旧消息】这句绝对不应该出现', en: 'LATE STALE MESSAGE — MUST NOT RENDER' },
  };
  const beforeRevision = guard.appliedRevision;
  const accepted = renderState(fake);
  return {
    accepted,
    beforeRevision,
    appliedRevision: guard.appliedRevision,
    ignoredCount: guard.ignoredCount,
    shownZh: cueZh.textContent,
  };
};

window.__getDebug = () => ({
  appliedRevision: guard.appliedRevision,
  ignoredCount: guard.ignoredCount,
  cueNonce: lastCueNonce,
  shownZh: cueZh.textContent,
  shownEn: cueEn.textContent,
});

// 手动模拟断连 → 重连 → 重新同步当前字幕
window.__reconnect = async function reconnect() {
  setConn('reconnecting');
  if (stream && typeof stream.close === 'function') {
    stream.close();
    stream = null;
    await sleep(900);
    startStream();
    await sleep(350);
    await refreshState();
  } else {
    // relay 嵌入模式：重新拉取权威快照完成再同步
    await sleep(700);
    await refreshState();
    setConn('relay');
  }
  return window.__getDebug();
};

document.getElementById('btnInjectLate').addEventListener('click', () => {
  const r = window.__injectLate();
  const btn = document.getElementById('btnInjectLate');
  const old = btn.textContent;
  btn.textContent = r.accepted ? '⚠ 旧消息竟被接受！' : `✅ 已拦截（累计 ${r.ignoredCount}）`;
  setTimeout(() => {
    btn.textContent = old;
  }, 1800);
});

document.getElementById('btnReconnect').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '重连中…';
  await window.__reconnect();
  btn.textContent = '✅ 已同步当前字幕';
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '🔌 模拟断连重连';
  }, 1600);
});
