// server.js — 零依赖 Node HTTP 服务：静态页面 + JSON API + SSE 实时推送
import http from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './src/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE =
  process.env.DATA_FILE !== undefined
    ? process.env.DATA_FILE
    : join(__dirname, 'data', 'state.json');

const store = new Store({ dataFile: DATA_FILE || null });

/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

store.on('change', (state) => broadcast('state', state));
store.on('audit', (entry) => broadcast('audit', entry));

// ---------- HTTP 工具 ----------

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(payload);
}

function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('请求体过大');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        const err = new Error('请求体不是合法 JSON');
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  // 友好的语义化路由
  const pageRoutes = {
    '/': 'index.html',
    '/index': 'index.html',
    '/console': 'console.html',
    '/projection': 'projection.html',
    '/screen': 'projection.html',
    '/script': 'script.html',
    '/scripts': 'script.html',
    '/admin': 'script.html',
    '/demo': 'demo.html',
  };

  let relative;
  if (pageRoutes[pathname]) {
    relative = pageRoutes[pathname];
  } else if (/^\/console\/[A-Za-z0-9_-]{1,24}\/?$/.test(pathname)) {
    relative = 'console.html';
  } else {
    relative = pathname.replace(/^\/+/, '');
  }

  const filePath = normalize(join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': pathname.startsWith('/console/') ? 'no-store' : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end('Internal Server Error');
  }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n');
  res.write('retry: 2000\n\n');
  // 新连接（包括重连）立即获得权威全量当前状态 —— 投影直接显示当前字幕。
  res.write(`event: snapshot\ndata: ${JSON.stringify(store.publicState())}\n\n`);

  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* noop */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Idempotency-Key,X-Command-Id',
    });
    return res.end();
  }

  try {
    // ---- API ----
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'bilingual-subtitles', time: Date.now() });
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, store.publicState());
    }

    if (pathname === '/api/audit' && req.method === 'GET') {
      return sendJson(res, 200, { entries: store.listAudit() });
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      return handleEvents(req, res);
    }

    if (pathname === '/api/reset' && req.method === 'POST') {
      const result = store.reset();
      console.log('[reset] 演示数据已重置');
      return sendJson(res, result.status, result.body);
    }

    // 仅供自动化测试：ALLOW_SHUTDOWN=1 时允许 HTTP 自检退出（某些沙箱禁止 kill 信号）
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      if (process.env.ALLOW_SHUTDOWN !== '1') {
        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      }
      sendJson(res, 200, { ok: true, shuttingDown: true });
      setTimeout(() => gracefulShutdown('HTTP /api/shutdown'), 120);
      return;
    }

    if (pathname === '/api/takeover' && req.method === 'POST') {
      const body = await readJsonBody(req).catch((err) => ({ __error: err }));
      if (body?.__error) return sendJson(res, body.__error.status || 400, { ok: false, message: body.__error.message });
      const consoleId =
        body.console ?? body.consoleId ?? body.who ?? url.searchParams.get('console');
      const result = store.takeover(consoleId);
      console.log(`[takeover] ${JSON.stringify(consoleId)} -> ${result.status} changed=${result.body.changed}`);
      return sendJson(res, result.status, result.body);
    }

    if ((pathname === '/api/script' || pathname === '/api/lines') &&
        (req.method === 'PUT' || req.method === 'POST')) {
      const body = await readJsonBody(req).catch((err) => ({ __error: err }));
      if (body?.__error) return sendJson(res, body.__error.status || 400, { ok: false, message: body.__error.message });
      const result = store.replaceScript(body);
      console.log(`[script] 更新台词本 -> ${result.status}`);
      return sendJson(res, result.status, result.body);
    }

    if (pathname === '/api/command' && req.method === 'POST') {
      const body = await readJsonBody(req).catch((err) => ({ __error: err }));
      if (body?.__error) return sendJson(res, body.__error.status || 400, { ok: false, message: body.__error.message });

      const headerId =
        req.headers['idempotency-key'] || req.headers['x-command-id'] || undefined;
      const command = { ...body };
      if (headerId && !command.commandId && !command.requestId) command.commandId = headerId;
      if (url.searchParams.get('console')) command.console = url.searchParams.get('console');

      const result = store.dispatchCommand(command);
      const cid = result.body?.commandId || command.commandId || headerId;
      if (result.replay) {
        console.log(`[command] 幂等重放 ${cid} -> ${result.status}`);
      } else if (result.status >= 400) {
        console.log(`[command] 作废/拒绝 ${cid || '(无号)'} ${result.body.code} -> ${result.status}`);
      } else {
        console.log(`[command] 生效 ${cid || '(无号)'} ${command.action} -> index=${result.body.currentIndex} rev=${result.body.revision}`);
      }
      const headers = { 'X-Command-Id': String(cid || '') };
      if (result.replay) headers['Idempotent-Replay'] = 'true';
      return sendJson(res, result.status, result.body, headers);
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `未知接口 ${req.method} ${pathname}` });
    }

    // ---- 静态页面 ----
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }

    sendJson(res, 405, { ok: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('[server] 未处理错误:', err);
    if (!res.headersSent) sendJson(res, err.status || 500, { ok: false, message: err.message || '服务器内部错误' });
  }
});

server.requestTimeout = 0; // SSE 长连接不被 5 分钟默认超时切断
server.headersTimeout = 0;
server.keepAliveTimeout = 70000;

server.listen(PORT, HOST, () => {
  console.log('========================================================');
  console.log('  双语字幕控台已启动');
  console.log(`  本机访问:   http://localhost:${PORT}/`);
  console.log(`  接班演示页: http://localhost:${PORT}/demo`);
  console.log(`  控台 A:     http://localhost:${PORT}/console/A`);
  console.log(`  控台 B:     http://localhost:${PORT}/console/B`);
  console.log(`  投影页:     http://localhost:${PORT}/projection`);
  console.log(`  台词本:     http://localhost:${PORT}/script`);
  console.log(`  数据文件:   ${DATA_FILE || '(仅内存)'}`);
  console.log('========================================================');
});

function gracefulShutdown(signal) {
  console.log(`\n[server] 收到 ${signal}，落盘并退出…`);
  try {
    store.persistNow();
  } catch {
    /* noop */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
