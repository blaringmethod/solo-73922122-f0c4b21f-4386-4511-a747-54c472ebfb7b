// public/common.js — 浏览器端公共工具：JSON API、SSE / iframe 中继、DOM 辅助

export async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { ...(options.headers || {}) } };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (cause) {
    const err = new Error('无法连接服务器（网络错误）');
    err.network = true;
    err.cause = cause;
    throw err;
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  const result = {
    status: res.status,
    ok: res.ok,
    body: data,
    headers: res.headers,
    replay: res.headers.get('Idempotent-Replay') === 'true',
  };

  if (!res.ok) {
    const err = new Error(data?.message || `请求失败 HTTP ${res.status}`);
    err.result = result;
    throw err;
  }
  return result;
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// /demo 页面里 iframe 通过 postMessage 中继事件，避免同域 6 连接限制。
function inRelayMode() {
  return new URLSearchParams(location.search).get('relay') === '1';
}

/**
 * 订阅状态。独立页面走 EventSource；?relay=1 的嵌入页接收父窗口中继。
 * @returns {EventSource|null}
 */
export function connectEvents(handlers = {}) {
  if (inRelayMode()) {
    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin) return;
      const msg = event.data;
      if (!msg || msg.source !== 'subtitle-demo-relay') return;
      if (msg.kind === 'snapshot') handlers.onSnapshot?.(msg.data);
      else if (msg.kind === 'state') handlers.onState?.(msg.data);
      else if (msg.kind === 'audit') handlers.onAudit?.(msg.data);
      else if (msg.kind === 'status') handlers.onStatus?.(msg.data);
    });
    handlers.onStatus?.('relay');
    return null;
  }

  const es = new EventSource('/api/events');
  es.addEventListener('open', () => handlers.onStatus?.('open'));
  es.addEventListener('snapshot', (e) => {
    try {
      handlers.onSnapshot?.(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });
  es.addEventListener('state', (e) => {
    try {
      handlers.onState?.(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });
  es.addEventListener('audit', (e) => {
    try {
      handlers.onAudit?.(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });
  es.addEventListener('error', () => {
    handlers.onStatus?.(es.readyState === EventSource.CONNECTING ? 'reconnecting' : 'closed');
  });
  return es;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function shortId(id) {
  if (!id) return '无指令号';
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id;
}

export function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

export function getConsoleIdFromLocation() {
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get('c') || params.get('console');
  const match = location.pathname.match(/\/console\/([A-Za-z0-9_-]+)/);
  const raw = fromQuery || match?.[1] || 'A';
  return /^[ab]$/.test(raw) ? raw.toUpperCase() : raw;
}
