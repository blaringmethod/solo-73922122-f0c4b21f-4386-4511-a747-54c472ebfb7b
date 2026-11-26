// scripts/verify.mjs — 关键操作端到端自检：
// 启动真实 server 子进程（临时数据文件 + 随机端口），验证幂等、围栏接班、
// 字幕保留、SSE 快照/增量、revision 守卫单测，以及重启后幂等记录仍在。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import net from 'node:net';
import { createRevisionGuard } from '../public/rev-guard.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗ ${name} ${extra}\x1b[0m`);
  }
}

function getFreePort() {
  return new Promise((resolvePromise, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolvePromise(port));
    });
    srv.on('error', reject);
  });
}

async function waitHealth(base, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server health timeout');
}

function startServer(port, dataFile) {
  const logs = [];
  const child = spawn(process.execPath, [join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_FILE: dataFile,
      ALLOW_SHUTDOWN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', (err) => logs.push(`[spawn-error] ${err.message}`));
  child.stdout.on('data', (d) => logs.push(`[out] ${d}`));
  child.stderr.on('data', (d) => logs.push(`[err] ${d}`));
  child.logs = logs;
  return child;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise();
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolvePromise();
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolvePromise();
    }
    child.once('exit', onExit);
  });
}

async function stopServer(child, base) {
  if (!child || child.exitCode !== null || child.killed) return;
  // 首选进程自行 HTTP 退出：部分沙箱禁止向子进程发送信号（kill EACCES）
  if (base) {
    try {
      await fetch(`${base}/api/shutdown`, { method: 'POST' });
    } catch {
      /* 进程可能已退出 */
    }
  }
  await waitForExit(child, 2000);
  if (child.exitCode === null) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 信号被沙箱拒绝时忽略 */
    }
    await waitForExit(child, 1200);
  }
  if (child.exitCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

async function req(base, method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { __notJson: text.slice(0, 120) };
  }
  return { status: res.status, body: json, headers: res.headers };
}

function parseSseFrame(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  let data = null;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    /* ignore */
  }
  return { event, data };
}

async function openSSE(base) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const received = [];
  const waiters = [];

  (async function pump() {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const frame = parseSseFrame(raw);
          received.push(frame);
          for (let i = waiters.length - 1; i >= 0; i -= 1) {
            if (waiters[i].pred(frame)) {
              const [w] = waiters.splice(i, 1);
              w.resolve(frame);
            }
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  return {
    close: () => ac.abort(),
    received,
    waitFor(pred, timeoutMs = 3000) {
      const found = received.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolvePromise, reject) => {
        const to = setTimeout(() => {
          const i = waiters.findIndex((w) => w.pred === pred);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('SSE wait timeout'));
        }, timeoutMs);
        waiters.push({
          pred,
          resolve: (frame) => {
            clearTimeout(to);
            resolvePromise(frame);
          },
        });
      });
    },
  };
}

async function main() {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), 'subtitle-verify-'));
  const dataFile = join(dir, 'state.json');

  let child = startServer(port, dataFile);
  try {
    await waitHealth(base);
    console.log('\n— 静态页面 —');
    for (const [path, needle] of [
      ['/', '双语字幕'],
      ['/console/A', 'console.js'],
      ['/console/b', 'console.js'],
      ['/projection', 'projection.js'],
      ['/script', 'script.js'],
      ['/demo', 'demo.js'],
      ['/styles.css', '--gold'],
      ['/console.js', 'postCommand'],
      ['/rev-guard.js', 'createRevisionGuard'],
      ['/demo.js', 'runDemo'],
    ]) {
      const r = await fetch(`${base}${path}`);
      const text = await r.text();
      check(`GET ${path} → 200 且含预期内容`, r.status === 200 && text.includes(needle), `status=${r.status}`);
    }

    console.log('\n— 台词本 —');
    let r = await req(base, 'POST', '/api/reset');
    check('重置演示数据 200', r.status === 200 && r.body.activeConsole === 'A' && r.body.epoch === 1);

    r = await req(base, 'PUT', '/api/script', {
      lines: [
        { zh: '第一句', en: 'Line one' },
        { zh: '第二句', en: 'Line two' },
        { zh: '第三句', en: 'Line three' },
      ],
    });
    check('录入 3 句有序双语台词', r.status === 200 && r.body.total === 3 && r.body.currentIndex === 0);
    r = await req(base, 'PUT', '/api/script', { lines: [] });
    check('空台词本被拒绝 400', r.status === 400 && r.body.code === 'INVALID_SCRIPT');

    await req(base, 'POST', '/api/reset');

    console.log('\n— 幂等切句（回执丢失模型） —');
    let s = (await req(base, 'GET', '/api/state')).body;
    check('初始：A 当班 / epoch=1 / 第 1 句', s.activeConsole === 'A' && s.epoch === 1 && s.currentIndex === 0);
    const revAfterReset = s.revision; // reset 也保持 revision 全局单调，不保证为 1

    const c1a = await req(base, 'POST', '/api/command', {
      commandId: 'verify-c1', console: 'A', epoch: 1, action: 'next',
    });
    check('C1 首次切下一句 → index=1 且 revision+1',
      c1a.status === 200 && c1a.body.currentIndex === 1 && c1a.body.revision === revAfterReset + 1);

    const c1b = await req(base, 'POST', '/api/command', {
      commandId: 'verify-c1', console: 'A', epoch: 1, action: 'next',
    });
    check('C1 同号重发 → Idempotent-Replay 头', c1b.headers.get('idempotent-replay') === 'true');
    check('C1 重发返回原 index/revision',
      c1b.status === 200 && c1b.body.currentIndex === 1 && c1b.body.revision === c1a.body.revision);

    s = (await req(base, 'GET', '/api/state')).body;
    check('服务端没有多切一句（仍 index=1）', s.currentIndex === 1);

    // 也验证 Idempotency-Key 请求头等价
    const cH = await req(base, 'POST', '/api/command', { console: 'A', epoch: 1, action: 'next' }, { 'Idempotency-Key': 'header-key-1' });
    const cH2 = await req(base, 'POST', '/api/command', { console: 'A', epoch: 1, action: 'next' }, { 'Idempotency-Key': 'header-key-1' });
    check('Idempotency-Key 请求头同样去重',
      cH.status === 200 && cH.body.currentIndex === 2 && cH2.headers.get('idempotent-replay') === 'true' &&
      cH2.body.currentIndex === 2);

    console.log('\n— 接班保留字幕 + 旧指令作废（含 ABA 再接班） —');
    const before = (await req(base, 'GET', '/api/state')).body;
    const tB = await req(base, 'POST', '/api/takeover', { console: 'B' });
    check('B 接班 → epoch=2', tB.status === 200 && tB.body.epoch === 2);
    check('接班响应保留当前 index=2', tB.body.currentIndex === before.currentIndex);
    s = (await req(base, 'GET', '/api/state')).body;
    check('接班后状态中的字幕位置不变', s.currentIndex === before.currentIndex && s.activeConsole === 'B');

    const v1 = await req(base, 'POST', '/api/command', {
      commandId: 'verify-void-1', console: 'A', epoch: 1, action: 'next',
    });
    check('B 当班时 A 的旧指令 → 409 voided',
      v1.status === 409 && v1.body.voided === true &&
      (v1.body.code === 'NOT_ON_DUTY' || v1.body.code === 'STALE_EPOCH'), `code=${v1.body?.code}`);

    const v1retry = await req(base, 'POST', '/api/command', {
      commandId: 'verify-void-1', console: 'A', epoch: 1, action: 'next',
    });
    check('立即重发作废指令 → 同一 409 + replay 头',
      v1retry.status === 409 && v1retry.headers.get('idempotent-replay') === 'true' &&
      v1retry.body.code === v1.body.code);

    const tA = await req(base, 'POST', '/api/takeover', { console: 'A' });
    check('A 再次接班 → epoch=3（单调，不回落）', tA.body.epoch === 3);

    const v1afterA = await req(base, 'POST', '/api/command', {
      commandId: 'verify-void-1', console: 'A', epoch: 1, action: 'next',
    });
    check('A 再接班后重发旧指令 → 仍是首次的作废结果',
      v1afterA.status === 409 && v1afterA.headers.get('idempotent-replay') === 'true' &&
      v1afterA.body.code === v1.body.code);

    const v2 = await req(base, 'POST', '/api/command', {
      commandId: 'verify-void-2', console: 'A', epoch: 1, action: 'next',
    });
    check('从未见过的旧任期指令 → STALE_EPOCH 409（ABA 围栏）',
      v2.status === 409 && v2.body.code === 'STALE_EPOCH' && v2.body.voided === true);

    const bCmd = await req(base, 'POST', '/api/command', {
      commandId: 'verify-b-when-a', console: 'B', epoch: 3, action: 'next',
    });
    check('A 当班时 B 的指令 → NOT_ON_DUTY 409', bCmd.status === 409 && bCmd.body.code === 'NOT_ON_DUTY');

    s = (await req(base, 'GET', '/api/state')).body;
    check('所有作废尝试后位置仍为 index=2', s.currentIndex === 2);

    console.log('\n— 选句 / 重播 / 参数校验 —');
    const g = await req(base, 'POST', '/api/command', {
      commandId: 'verify-goto', console: 'A', epoch: 3, action: 'goto', index: 0,
    });
    check('goto 第 1 句 → index=0', g.status === 200 && g.body.currentIndex === 0);
    const revAfterGoto = g.body.revision;
    const rep = await req(base, 'POST', '/api/command', {
      commandId: 'verify-replay-same', console: 'A', epoch: 3, action: 'replay', index: 0,
    });
    check('重播同一句 → 200 replayed=true 且 revision 递增（触发动效）',
      rep.status === 200 && rep.body.replayed === true && rep.body.revision === revAfterGoto + 1);
    const bad = await req(base, 'POST', '/api/command', {
      commandId: 'verify-bad-index', console: 'A', epoch: 3, action: 'goto', index: 999,
    });
    check('越界 index → 400 INVALID_INDEX', bad.status === 400 && bad.body.code === 'INVALID_INDEX');

    console.log('\n— SSE：新连接快照即当前状态，增量 revision 单调 —');
    const sse = await openSSE(base);
    const snapFrame = await sse.waitFor((f) => f.event === 'snapshot');
    const liveState = (await req(base, 'GET', '/api/state')).body;
    check('SSE snapshot 与 /api/state 一致（重连直接显示当前字幕）',
      snapFrame.data && snapFrame.data.revision === liveState.revision &&
      snapFrame.data.currentIndex === liveState.currentIndex);

    const beforeCount = sse.received.filter((f) => f.event === 'state').length;
    await req(base, 'POST', '/api/command', {
      commandId: 'verify-sse-next', console: 'A', epoch: 3, action: 'next',
    });
    const stateFrame = await sse.waitFor(
      (f) => f.event === 'state' && f.data?.currentIndex === 1,
    );
    check('切句后收到 state 增量且指向新句', !!stateFrame);
    const stateRevs = sse.received
      .filter((f) => f.event === 'state')
      .slice(beforeCount)
      .map((f) => f.data.revision);
    check('state 事件 revision 严格递增', stateRevs.every((v, i) => i === 0 || v > stateRevs[i - 1]), JSON.stringify(stateRevs));
    sse.close();

    console.log('\n— 投影 revision 守卫（纯逻辑单测） —');
    const guard = createRevisionGuard(0);
    check('接受 rev=1', guard.accept(1) === true);
    check('接受 rev=2', guard.accept(2) === true);
    check('重复 rev=2 允许（幂等重放不报错）', guard.accept(2) === true);
    check('迟到 rev=1 被拒绝', guard.accept(1) === false);
    check('更旧的 rev=-999 被拒绝', guard.accept(-999) === false);
    check('累计拦截 2 条且 appliedRevision 不倒退', guard.ignoredCount === 2 && guard.appliedRevision === 2);

    console.log('\n— 重启服务：幂等结果与状态持久化 —');
    await stopServer(child, base);
    child = startServer(port, dataFile);
    await waitHealth(base);
    const afterRestart = (await req(base, 'GET', '/api/state')).body;
    check('重启后当前位置/任期已恢复（index=1, epoch=3）',
      afterRestart.currentIndex === 1 && afterRestart.epoch === 3,
      `index=${afterRestart.currentIndex}, epoch=${afterRestart.epoch}`);
    const c1After = await req(base, 'POST', '/api/command', {
      commandId: 'verify-c1', console: 'A', epoch: 3, action: 'next',
    });
    check('重启后重发旧指令号 C1 仍返回首次原结果 index=1（不多切）',
      c1After.status === 200 && c1After.headers.get('idempotent-replay') === 'true' &&
      c1After.body.currentIndex === 1 && c1After.body.revision === c1a.body.revision);
    const voidAfter = await req(base, 'POST', '/api/command', {
      commandId: 'verify-void-2', console: 'A', epoch: 1, action: 'next',
    });
    check('重启后作废记录仍在（void-2 原样 409 回放）',
      voidAfter.status === 409 && voidAfter.headers.get('idempotent-replay') === 'true' &&
      voidAfter.body.code === 'STALE_EPOCH');
  } catch (err) {
    failed += 1;
    console.error('\x1b[31m验证脚本异常:\x1b[0m', err);
    if (child?.logs?.length) console.error(child.logs.slice(-30).join(''));
  } finally {
    await stopServer(child, base);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
