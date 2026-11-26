// public/script.js — 台词本录入与保存
import { api, connectEvents } from './common.js';

const input = document.getElementById('scriptInput');
const msg = document.getElementById('saveMsg');
const serverCount = document.getElementById('serverCount');
const serverRev = document.getElementById('serverRev');
const serverDuty = document.getElementById('serverDuty');

const SAMPLE = [
  '各位观众晚上好，欢迎光临今晚的双语演出。 | Good evening, everyone, and welcome to tonight’s bilingual performance.',
  '今晚的故事，发生在一座靠海的小城。 | Tonight’s story takes place in a small town by the sea.',
  '幕布即将拉开，请将手机调至静音模式。 | The curtain is about to rise; please switch your phones to silent mode.',
  '第一幕 · 归航。 | Act One · The Homecoming.',
  '“无论走多远，总有一盏灯为你亮着。” | “No matter how far you travel, a light is always left on for you.”',
  '（全剧终） | (The End)',
].join('\n');

function linesToText(script) {
  return script.map((l) => (l.en ? `${l.zh} | ${l.en}` : l.zh)).join('\n');
}

function parseText(text) {
  return text
    .split(/\r?\n/)
    .map((rawLine) => {
      const line = rawLine.trim();
      if (!line) return null;
      const match = line.match(/^([^|｜\t]*)[|｜\t]([\s\S]*)$/);
      if (!match) return { zh: line, en: '' };
      return { zh: match[1].trim(), en: match[2].trim() };
    })
    .filter(Boolean);
}

function showMessage(kind, text) {
  msg.className = `save-msg ${kind}`;
  msg.textContent = text;
}

async function loadFromServer({ fillText = true } = {}) {
  const state = await api('/api/state').then((r) => r.body);
  if (fillText || !input.value.trim()) input.value = linesToText(state.script);
  serverCount.textContent = state.total;
  serverRev.textContent = state.revision;
  serverDuty.textContent = state.activeConsole || '无';
  return state;
}

document.getElementById('btnReload').addEventListener('click', async () => {
  try {
    await loadFromServer();
    showMessage('good', '已重新读取服务端台词本。');
  } catch (err) {
    showMessage('bad', err.message);
  }
});

document.getElementById('btnSample').addEventListener('click', () => {
  input.value = SAMPLE;
  showMessage('', '已填入示例，确认后请点保存。');
});

document.getElementById('btnSave').addEventListener('click', async (e) => {
  const btn = e.currentTarget; // 先捕获：await 后事件分发结束，e.currentTarget 会变成 null
  const lines = parseText(input.value);
  if (!lines.length) {
    showMessage('bad', '请至少输入一句台词。');
    return;
  }
  btn.disabled = true;
  try {
    const r = await api('/api/script', { method: 'PUT', body: { lines } });
    showMessage('good', `已保存：${r.body.total} 句台词现已由两控台共用，上屏位置回到第 1 句。`);
    await loadFromServer({ fillText: false });
  } catch (err) {
    showMessage('bad', `保存失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

loadFromServer().catch((err) => showMessage('bad', `读取失败：${err.message}`));
connectEvents({
  onState: (s) => {
    serverCount.textContent = s.total;
    serverRev.textContent = s.revision;
    serverDuty.textContent = s.activeConsole || '无';
  },
});
