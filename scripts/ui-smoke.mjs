// scripts/ui-smoke.mjs — 可选的 jsdom 浏览器层冒烟（需要 npm install 安装 devDependencies）。
// 真实 server + esbuild 打包前端模块 + jsdom 点击，并真实执行 /demo 的自动剧本。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(WORKSPACE, 'public');

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗ ${name} ${extra}\x1b[0m`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('unhandledRejection', (err) => {
  console.error('\x1b[33m[harness] unhandledRejection:\x1b[0m', err?.stack || err);
});

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

async function bundle(entry) {
  const out = await build({
    entryPoints: [join(PUB, entry)],
    bundle: true,
    write: false,
    format: 'iife',
    logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

class MockEventSource {
  constructor() {
    this.listeners = {};
    MockEventSource.last = this;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  close() {}
}

function makeWindow(htmlFile, urlPath, base) {
  const html = readFileSync(join(PUB, htmlFile), 'utf8');
  const dom = new JSDOM(html, {
    url: `http://localhost${urlPath}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.fetch = (input, init) => {
    const path = typeof input === 'string' ? input : input.url;
    return fetch(`${base}${path}`, init);
  };
  window.crypto = webcrypto;
  window.EventSource = MockEventSource;
  window.requestFullscreen = () => Promise.resolve();
  return dom;
}

function relay(dom, kind, data) {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      origin: 'http://localhost',
      data: { source: 'subtitle-demo-relay', kind, data },
    }),
  );
}

async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'ui-check-'));
  const child = spawn(process.execPath, [join(WORKSPACE, 'server.js')], {
    cwd: WORKSPACE,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_FILE: join(dataDir, 'state.json'), ALLOW_SHUTDOWN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.on('error', (e) => {
    // 某些沙箱完全禁止 kill 子进程（EACCES）；测试服务器已用 /api/shutdown 自退，忽略之。
    if (e?.code !== 'EACCES') console.error('spawn error', e);
  });

  try {
    // 等健康
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {}
      await sleep(150);
    }

    const consoleBundle = await bundle('console.js');
    const projectionBundle = await bundle('projection.js');
    const scriptBundle = await bundle('script.js');
    const demoBundle = await bundle('demo.js');

    console.log('\n— 控台 A：渲染 / 切句 / 丢回执幂等 / 延迟旧指令作废 / 再接班重发 —');
    await api(base, 'POST', '/api/reset');
    await sleep(150);

    const domA = makeWindow('console.html', '/console/A?embed=1&relay=1', base);
    domA.window.eval(consoleBundle);
    await sleep(500);
    const d = domA.window.document;

    check('当班徽章显示 A 台当班', d.getElementById('dutyText').textContent.includes('A 台当班'));
    check('台词列表渲染 7 行', d.querySelectorAll('.line-row').length === 7, `rows=${d.querySelectorAll('.line-row').length}`);
    check('上屏预览显示示例首句', d.getElementById('airZh').textContent.includes('各位观众'));
    check('当班时切句按钮可用', d.getElementById('btnNext').disabled === false);

    d.getElementById('btnNext').click();
    await sleep(300);
    let st = (await api(base, 'GET', '/api/state')).body;
    check('点击「切下一句」→ 服务端 index=1', st.currentIndex === 1);
    relay(domA, 'state', st); // 模拟 /demo 父页把 SSE state 中继给 iframe
    await sleep(80);
    check('控台预览更新为第 2 句', d.getElementById('airIndex').textContent.includes('第 2 / 7 句'));

    d.getElementById('optLoseAck').checked = true;
    d.getElementById('btnNext').click();
    await sleep(1400);
    st = (await api(base, 'GET', '/api/state')).body;
    const box = d.getElementById('resultBox');
    check('丢回执重发后服务端只推进一次 → index=2', st.currentIndex === 2, `index=${st.currentIndex}`);
    check('结果框为成功样式', box.classList.contains('good'));
    check('结果框说明幂等重放', box.textContent.includes('幂等重放'), box.textContent.slice(0, 80));

    // 延迟在途指令 + B 接班
    d.getElementById('btnDelayNext').click();
    await sleep(120);
    await api(base, 'POST', '/api/takeover', { console: 'B' });
    relay(domA, 'state', (await api(base, 'GET', '/api/state')).body);
    check('收到 B 接班中继后切句按钮锁定', d.getElementById('btnNext').disabled === true);
    await sleep(3300);
    st = (await api(base, 'GET', '/api/state')).body;
    check('延迟旧指令落地后位置仍为 index=2', st.currentIndex === 2);
    check('结果框提示指令已作废', d.getElementById('resultBox').textContent.includes('作废'));

    // A 再次接班，重发同一旧指令
    await api(base, 'POST', '/api/takeover', { console: 'A' });
    const stateA = (await api(base, 'GET', '/api/state')).body;
    check('A 再次接班 epoch=3', stateA.epoch === 3);
    relay(domA, 'state', stateA);
    await sleep(120);
    check('A 恢复当班后按钮解锁', d.getElementById('btnNext').disabled === false);
    d.getElementById('btnResend').click();
    await sleep(500);
    const txt = d.getElementById('resultBox').textContent;
    check('再接班后重发 → 仍作废', txt.includes('作废'));
    check('作废结果以幂等原结果回放', txt.includes('幂等重放'));
    st = (await api(base, 'GET', '/api/state')).body;
    check('重发作废指令没有改变位置', st.currentIndex === 2);
    domA.window.close();

    console.log('\n— 投影：首屏当前句 / 中继更新 / 迟到消息拦截 / 重连再同步 —');
    const domP = makeWindow('projection.html', '/projection?embed=1&relay=1', base);
    domP.window.eval(projectionBundle);
    await sleep(500);
    const pd = domP.window.document;
    st = (await api(base, 'GET', '/api/state')).body;
    check('投影首屏直接显示服务端当前句', pd.getElementById('cueZh').textContent === st.current.zh);
    check('投影 rev 标签为当前版本', pd.getElementById('revLabel').textContent === String(st.revision));

    const late = domP.window.__injectLate();
    check('注入迟到旧消息 → accepted=false', late.accepted === false);
    check('守卫计数 ignoredCount=1', late.ignoredCount === 1);
    check('画面文字未被旧消息替换', !pd.getElementById('cueZh').textContent.includes('迟到旧消息'));
    check('调试版本号未倒退', domP.window.__getDebug().appliedRevision === st.revision);

    const nx = await api(base, 'POST', '/api/command', { commandId: 'ui-proj-next', console: 'A', epoch: 3, action: 'next' });
    st = (await api(base, 'GET', '/api/state')).body;
    relay(domP, 'state', st);
    await sleep(150);
    check('中继新 state 后投影跟随到新句', pd.getElementById('cueZh').textContent === st.current.zh);
    check('投影应用了新 revision', domP.window.__getDebug().appliedRevision === st.revision);

    const dbg = await domP.window.__reconnect();
    check('重连再同步后 revision 等于服务端', dbg.appliedRevision === st.revision);
    check('重连后文字仍是当前句', dbg.shownZh === st.current.zh);

    // 重置保持 revision 单调递增：长生命周期投影必须接受重置快照
    const revBeforeReset = domP.window.__getDebug().appliedRevision;
    const resetBody = (await api(base, 'POST', '/api/reset')).body;
    check('重置 revision 继续向前递增（不回拨）', resetBody.revision > revBeforeReset,
      `before=${revBeforeReset}, reset=${resetBody.revision}`);
    relay(domP, 'state', resetBody);
    await sleep(120);
    const dbgReset = domP.window.__getDebug();
    check('投影接受重置快照并应用其 revision', dbgReset.appliedRevision === resetBody.revision,
      `applied=${dbgReset.appliedRevision}, reset=${resetBody.revision}`);
    check('重置后画面回到示例首句（不是拒绝快照）',
      pd.getElementById('cueZh').textContent.includes('各位观众'));
    domP.window.close();

    console.log('\n— 台词本页：加载 / 解析保存 —');
    const domS = makeWindow('script.html', '/script?relay=1', base);
    domS.window.eval(scriptBundle);
    await sleep(500);
    const sd = domS.window.document;
    check('文本框载入了服务端台词（含 | 分隔）', sd.getElementById('scriptInput').value.includes('|'));
    sd.getElementById('scriptInput').value = '界面测试中文一 | UI Test One\n界面测试中文二\n';
    sd.getElementById('btnSave').click();
    await sleep(700);
    st = (await api(base, 'GET', '/api/state')).body;
    check('保存后服务端台词为 2 句', st.total === 2, `total=${st.total}`);
    check('保存提示为成功样式', sd.getElementById('saveMsg').className.includes('good'));
    domS.window.close();

    console.log('\n— /demo 外壳：bundle 顶层无引用错误，控件就绪 —');
    const domD = makeWindow('demo.html', '/demo', base);
    let demoEvalError = null;
    try {
      domD.window.eval(demoBundle);
    } catch (e) {
      demoEvalError = e;
    }
    check('demo.js 在 jsdom 中执行无顶层异常', demoEvalError === null, demoEvalError?.stack || String(demoEvalError));
    await sleep(200);
    if (!demoEvalError) {
      const dd = domD.window.document;
      check('自动演示按钮存在且可用', dd.getElementById('btnRun') && !dd.getElementById('btnRun').disabled);
      check('初始日志已写入', dd.getElementById('logBody').children.length >= 1);
      check('页面含 3 个 iframe', dd.querySelectorAll('iframe').length === 3);

      console.log('\n— 真实执行 /demo 自动剧本 runDemo()（约 10 秒） —');
      // 用真实服务器 SSE 驱动 demo 页里的 MockEventSource
      const mes = MockEventSource.last;
      mes.listeners.open?.forEach((fn) => fn({}));
      (async () => {
        try {
          const res = await fetch(`${base}/api/events`);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let sep;
            while ((sep = buf.indexOf('\n\n')) >= 0) {
              const raw = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              let event = 'message';
              const dataLines = [];
              for (const line of raw.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
              }
              const payload = dataLines.join('\n');
              (mes.listeners[event] || []).forEach((fn) => fn({ data: payload }));
            }
          }
        } catch {
          /* shutdown */
        }
      })();

      // 在投影 iframe 上安装与 projection.js 行为一致的守卫桩，并接收父页中继
      const pwin = dd.querySelector('iframe[name="projection"]').contentWindow;
      const fakeGuard = { applied: 0, ignored: 0, zh: '', revRun: 0 };
      pwin.addEventListener('message', (e) => {
        const m = e.data;
        if (!m || m.source !== 'subtitle-demo-relay') return;
        if (m.kind === 'state' || m.kind === 'snapshot') {
          const s = m.data;
          if (s && Number.isInteger(s.revision) && s.revision >= fakeGuard.applied) {
            fakeGuard.applied = s.revision;
            fakeGuard.zh = s.current?.zh || '';
          }
        }
      });
      pwin.__getDebug = () => ({
        appliedRevision: fakeGuard.applied,
        ignoredCount: fakeGuard.ignored,
        shownZh: fakeGuard.zh,
      });
      pwin.__injectLate = () => {
        fakeGuard.ignored += 1;
        return { accepted: false, appliedRevision: fakeGuard.applied, ignoredCount: fakeGuard.ignored, shownZh: fakeGuard.zh };
      };
      pwin.__reconnect = async () => {
        const s = (await fetch(`${base}/api/state`).then((r) => r.json()));
        fakeGuard.applied = s.revision;
        fakeGuard.zh = s.current?.zh || '';
        return pwin.__getDebug();
      };

      dd.getElementById('btnRun').click();
      const runDeadline = Date.now() + 25000;
      let logText = '';
      while (Date.now() < runDeadline) {
        await sleep(300);
        logText = dd.getElementById('logBody').textContent;
        if (logText.includes('全部通过') || logText.includes('项失败')) break;
      }
      logText = dd.getElementById('logBody').textContent;
      const failLines = [...dd.querySelectorAll('.log-line.err')].map((n) => n.textContent);
      check('自动剧本报告全部通过', logText.includes('全部通过'), failLines.join(' | ').slice(0, 300));
      check('自动剧本没有红色失败行', failLines.length === 0, `${failLines.length} 行: ${failLines[0] || ''}`);
      check('运行结束后按钮恢复可用', dd.getElementById('btnRun').disabled === false);
    }
    domD.window.close();
  } catch (err) {
    failed++;
    console.error('\x1b[31mUI 测试异常:\x1b[0m', err);
  } finally {
    try {
      await fetch(`${base}/api/shutdown`, { method: 'POST' });
    } catch {}
    await new Promise((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise();
      const t = setTimeout(resolvePromise, 2000);
      child.once('exit', () => {
        clearTimeout(t);
        resolvePromise();
      });
    });
    if (child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 沙箱禁止信号时忽略 */
      }
    }
  }

  console.log(`\nUI 结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main();
