// src/store.js
// 核心状态与领域逻辑（单进程内串行，Node 事件循环保证无竞态）。
//
// 三个关键机制：
// 1. revision：全局单调版本号。任何生效的状态变化 +1，投影页据此丢弃迟到旧消息。
// 2. epoch：控台“任期”围栏令牌。每次不同控台接班 +1，旧任期发出的指令一律作废，
//    即使旧控台以后再次接班，epoch 也不会回落，旧指令仍然被围栏拦截。
// 3. outcomes：commandId -> 首次处理结果（含被作废的失败结果）。
//    同一 commandId 重发时原样返回，保证“切句”至多生效一次。

import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const MAX_OUTCOMES = 500;
export const MAX_AUDIT = 60;
export const MAX_LINES = 200;
export const MAX_LINE_CHARS = 2000;

export const SEED_LINES = [
  { zh: '各位观众晚上好，欢迎光临今晚的双语演出。', en: 'Good evening, everyone, and welcome to tonight’s bilingual performance.' },
  { zh: '今晚的故事，发生在一座靠海的小城。', en: 'Tonight’s story takes place in a small town by the sea.' },
  { zh: '幕布即将拉开，请将手机调至静音模式。', en: 'The curtain is about to rise; please switch your phones to silent mode.' },
  { zh: '第一幕 · 归航。', en: 'Act One · The Homecoming.' },
  { zh: '“无论走多远，总有一盏灯为你亮着。”', en: '“No matter how far you travel, a light is always left on for you.”' },
  { zh: '海风把往事吹得很远，又把它们轻轻送回。', en: 'The sea breeze carries memories far away, then gently brings them back.' },
  { zh: '（全剧终）', en: '(The End)' },
];

function freshState() {
  return {
    revision: 1,
    cueNonce: 1,
    epoch: 1,
    activeConsole: 'A', // 开场前默认 A 台当班，可随时由 B 台接班
    currentIndex: 0,
    lineSeq: SEED_LINES.length,
    script: SEED_LINES.map((line, i) => ({ id: `seed-${i + 1}`, ...line })),
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function normalizeConsoleId(value) {
  if (value === null || value === undefined) return null;
  let id = String(value).trim();
  if (!id) return null;
  if (/^[abAB]$/.test(id)) id = id.toUpperCase();
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(id)) return null;
  return id;
}

export function normalizeCommandId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = String(value).trim();
  if (!id || id.length > 128) return null;
  return id;
}

function normalizeEpoch(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

export function normalizeLines(input) {
  let rawLines;
  if (typeof input === 'string') {
    rawLines = input.split(/\r?\n/).map((text) => ({ zh: text }));
  } else if (Array.isArray(input)) {
    rawLines = input;
  } else if (input && typeof input.text === 'string') {
    rawLines = input.text.split(/\r?\n/).map((text) => ({ zh: text }));
  } else if (input && Array.isArray(input.lines)) {
    rawLines = input.lines;
  } else {
    return { error: '台词格式不正确：需要 lines 数组或 text 文本。' };
  }

  const lines = [];
  for (const raw of rawLines) {
    let zh = '';
    let en = '';
    if (typeof raw === 'string') {
      zh = raw;
    } else if (raw && typeof raw === 'object') {
      zh = String(raw.zh ?? raw.cn ?? raw.chinese ?? '');
      en = String(raw.en ?? raw.english ?? '');
    }
    zh = zh.trim();
    en = en.trim();
    if (!zh && !en) continue;
    if (zh.length > MAX_LINE_CHARS || en.length > MAX_LINE_CHARS) {
      return { error: `单句台词不能超过 ${MAX_LINE_CHARS} 字。` };
    }
    lines.push({ zh, en });
  }

  if (lines.length === 0) return { error: '至少需要一句非空台词。' };
  if (lines.length > MAX_LINES) return { error: `台词最多 ${MAX_LINES} 句。` };
  return { lines };
}

export class Store extends EventEmitter {
  constructor({ dataFile = null, logger = console } = {}) {
    super();
    this.dataFile = dataFile;
    this.logger = logger;
    this.outcomes = new Map(); // commandId -> { status, body }
    this.audit = [];
    this.saveChain = Promise.resolve();
    this.state = this.#load();
  }

  #load() {
    const fallback = freshState();
    if (!this.dataFile || !existsSync(this.dataFile)) return fallback;
    try {
      const raw = JSON.parse(readFileSync(this.dataFile, 'utf8'));
      const state = { ...fallback, ...(raw.state || raw) };
      if (!Array.isArray(state.script) || state.script.length === 0) return fallback;
      state.currentIndex = Math.min(
        Math.max(-1, Number(state.currentIndex) || 0),
        state.script.length - 1,
      );
      state.revision = Math.max(1, Number(state.revision) || 1);
      state.cueNonce = Math.max(1, Number(state.cueNonce) || 1);
      state.epoch = Math.max(1, Number(state.epoch) || 1);
      state.lineSeq = Number(state.lineSeq) || state.script.length;
      this.outcomes = new Map();
      const outcomes = raw.outcomes || {};
      for (const [id, rec] of Object.entries(outcomes)) {
        if (rec && typeof rec.status === 'number' && rec.body) {
          this.outcomes.set(id, rec);
        }
      }
      return state;
    } catch (err) {
      this.logger?.warn?.(`[store] 无法读取持久化文件，使用初始示例: ${err.message}`);
      return fallback;
    }
  }

  // ---------- 持久化（best-effort，原子替换） ----------

  persist() {
    if (!this.dataFile) return;
    this.saveChain = this.saveChain.then(() => this.persistNow()).catch((err) => {
      this.logger?.warn?.(`[store] 持久化失败: ${err.message}`);
    });
  }

  persistNow() {
    if (!this.dataFile) return;
    try {
      mkdirSync(dirname(this.dataFile), { recursive: true });
      const payload = {
        state: this.state,
        outcomes: Object.fromEntries(this.outcomes),
        savedAt: new Date().toISOString(),
      };
      const tmp = `${this.dataFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, this.dataFile);
    } catch (err) {
      this.logger?.warn?.(`[store] 同步持久化失败: ${err.message}`);
    }
  }

  // ---------- 对外状态 ----------

  currentLine() {
    const i = this.state.currentIndex;
    return i >= 0 && i < this.state.script.length ? this.state.script[i] : null;
  }

  publicState() {
    return {
      revision: this.state.revision,
      cueNonce: this.state.cueNonce,
      epoch: this.state.epoch,
      activeConsole: this.state.activeConsole,
      currentIndex: this.state.currentIndex,
      current: this.currentLine(),
      total: this.state.script.length,
      script: this.state.script.map((line, index) => ({ ...line, index })),
      serverTime: Date.now(),
    };
  }

  listAudit() {
    return [...this.audit];
  }

  addAudit(entry) {
    const item = {
      id: this.audit.length ? this.audit[this.audit.length - 1].id + 1 : 1,
      at: new Date().toISOString(),
      ...entry,
    };
    this.audit.push(item);
    if (this.audit.length > MAX_AUDIT) this.audit.splice(0, this.audit.length - MAX_AUDIT);
    this.emit('audit', item);
    return item;
  }

  #changed() {
    this.persist();
    this.emit('change', this.publicState());
  }

  // ---------- 台词本 ----------

  replaceScript(input) {
    const result = normalizeLines(input);
    if (result.error) {
      return { status: 400, body: { ok: false, code: 'INVALID_SCRIPT', message: result.error } };
    }
    this.state.script = result.lines.map((line) => ({
      id: `L${++this.state.lineSeq}`,
      ...line,
    }));
    this.state.currentIndex = 0;
    this.state.revision += 1;
    this.state.cueNonce += 1;
    this.addAudit({
      kind: 'script',
      message: `台词本已录入/更新，共 ${this.state.script.length} 句，两控台与投影共用`,
    });
    this.#changed();
    return { status: 200, body: { ok: true, ...this.publicState() } };
  }

  // ---------- 接班 ----------

  takeover(rawConsole) {
    const consoleId = normalizeConsoleId(rawConsole);
    if (!consoleId) {
      return {
        status: 400,
        body: { ok: false, code: 'INVALID_CONSOLE', message: '控台编号无效（应为 A 或 B）。' },
      };
    }

    const beforeIndex = this.state.currentIndex;
    let changed = false;
    if (this.state.activeConsole !== consoleId) {
      const previous = this.state.activeConsole;
      this.state.activeConsole = consoleId;
      this.state.epoch += 1; // 单调递增的围栏任期
      changed = true;
      this.addAudit({
        kind: 'takeover',
        consoleId,
        epoch: this.state.epoch,
        currentIndex: beforeIndex,
        message:
          `控台 ${consoleId} 接班（任期 epoch=${this.state.epoch}），` +
          `当前字幕保留在第 ${beforeIndex + 1} 句；${previous ? `原控台 ${previous} ` : ''}未生效指令作废`,
      });
    }

    if (changed) {
      this.state.revision += 1;
      this.#changed();
    }

    return {
      status: 200,
      body: {
        ok: true,
        changed,
        consoleId,
        activeConsole: this.state.activeConsole,
        epoch: this.state.epoch,
        revision: this.state.revision,
        currentIndex: this.state.currentIndex,
        current: this.currentLine(),
        message: changed ? '接班成功，当前字幕保持不变。' : '该控台已是当班控台。',
      },
    };
  }

  // ---------- 指令（幂等 + 围栏） ----------

  dispatchCommand(raw = {}) {
    const commandId = normalizeCommandId(
      raw.commandId ?? raw.requestId ?? raw.command_id ?? raw.id ?? raw.idempotencyKey,
    );

    // 1) 同一指令号：无条件返回首次处理结果（成功或作废失败都一样）。
    if (commandId && this.outcomes.has(commandId)) {
      const original = this.outcomes.get(commandId);
      this.addAudit({
        kind: 'replay',
        commandId,
        consoleId: normalizeConsoleId(raw.console ?? raw.consoleId ?? raw.who),
        httpStatus: original.status,
        message: `指令 ${shortId(commandId)} 同号重发，返回首次处理结果（HTTP ${original.status}），不重复执行`,
      });
      return { status: original.status, body: clone(original.body), replay: true };
    }

    const settle = (status, body) => {
      if (commandId) {
        this.outcomes.set(commandId, { status, body: clone(body) });
        if (this.outcomes.size > MAX_OUTCOMES) {
          const oldest = this.outcomes.keys().next().value;
          this.outcomes.delete(oldest);
        }
        this.persist();
      }
      return { status, body, replay: false };
    };

    const consoleId = normalizeConsoleId(raw.console ?? raw.consoleId ?? raw.who);
    if (!consoleId) {
      const body = { ok: false, code: 'INVALID_CONSOLE', message: '缺少有效的控台编号（console=A|B）。' };
      return settle(400, body);
    }

    const action = String(raw.action ?? raw.type ?? raw.cmd ?? '').toLowerCase();
    const allowed = ['next', 'prev', 'previous', 'goto', 'replay'];
    if (!allowed.includes(action)) {
      const body = {
        ok: false,
        code: 'INVALID_ACTION',
        message: '未知指令，action 应为 next / prev / goto(replay)。',
      };
      return settle(400, body);
    }

    let targetIndex = null;
    if (action === 'goto' || action === 'replay') {
      targetIndex = Number(raw.index ?? raw.line ?? raw.at);
      if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= this.state.script.length) {
        const body = {
          ok: false,
          code: 'INVALID_INDEX',
          message: `选句序号无效，应为 0..${this.state.script.length - 1} 的整数。`,
        };
        return settle(400, body);
      }
    }

    // 2) 当班校验：非当班控台的新指令一律作废并记录原结果。
    if (this.state.activeConsole !== consoleId) {
      const body = {
        ok: false,
        voided: true,
        code: 'NOT_ON_DUTY',
        message: `控台 ${consoleId} 已不在当班（当前当班：${this.state.activeConsole}），该指令未生效并已作废；重发也不会执行。`,
        commandId,
        activeConsole: this.state.activeConsole,
        currentEpoch: this.state.epoch,
        currentIndex: this.state.currentIndex,
      };
      this.addAudit({
        kind: 'void',
        commandId,
        consoleId,
        code: body.code,
        message: `作废 ${consoleId} 台指令 ${shortId(commandId)}：非当班控台`,
      });
      return settle(409, body);
    }

    // 3) 任期围栏：携带的 epoch 落后于当前任期 => 旧指令永久作废
    //    （哪怕该控台后来再次接班，当前 epoch 只会更大）。
    const epoch = normalizeEpoch(raw.epoch ?? raw.term ?? raw.fencingToken);
    if (Number.isNaN(epoch)) {
      const body = { ok: false, code: 'INVALID_EPOCH', message: 'epoch 必须是非负整数。' };
      return settle(400, body);
    }
    if (epoch !== null && epoch < this.state.epoch) {
      const body = {
        ok: false,
        voided: true,
        code: 'STALE_EPOCH',
        message:
          `指令来自旧任期 epoch=${epoch}，当前任期 epoch=${this.state.epoch}；` +
          '这是交班时未生效的旧指令，已永久作废，即使原控台再次接班也不能执行。',
        commandId,
        issuedEpoch: epoch,
        currentEpoch: this.state.epoch,
        currentIndex: this.state.currentIndex,
      };
      this.addAudit({
        kind: 'void',
        commandId,
        consoleId,
        code: body.code,
        epoch,
        message: `作废 ${consoleId} 台旧任期指令 ${shortId(commandId)}：epoch ${epoch} < ${this.state.epoch}`,
      });
      return settle(409, body);
    }

    // 4) 真正执行，且只执行这一次。
    const s = this.state;
    const previousIndex = s.currentIndex;
    let advanced = false;
    let atEnd = false;
    let replayed = false;

    if (action === 'next') {
      if (s.currentIndex < s.script.length - 1) {
        s.currentIndex += 1;
        advanced = true;
      } else {
        atEnd = true;
      }
    } else if (action === 'prev' || action === 'previous') {
      if (s.currentIndex > 0) {
        s.currentIndex -= 1;
        advanced = true;
      } else {
        atEnd = true; // 已在第一句
      }
    } else {
      // goto / replay：允许点同一句“重播”，通过 cueNonce 让投影重新播放动效。
      replayed = targetIndex === s.currentIndex;
      s.currentIndex = targetIndex;
      advanced = true;
    }

    if (advanced) {
      s.revision += 1;
      s.cueNonce += 1;
    }

    const verb =
      action === 'next'
        ? '切下一句'
        : action === 'prev' || action === 'previous'
          ? '上一句'
          : replayed
            ? '重播本句'
            : '选句跳转';

    const body = {
      ok: true,
      commandId,
      action,
      consoleId,
      verb,
      advanced,
      atEnd,
      replayed,
      fromIndex: previousIndex,
      currentIndex: s.currentIndex,
      current: this.currentLine(),
      revision: s.revision,
      cueNonce: s.cueNonce,
      epoch: s.epoch,
      activeConsole: s.activeConsole,
    };

    this.addAudit({
      kind: 'command',
      commandId,
      consoleId,
      action,
      currentIndex: s.currentIndex,
      revision: s.revision,
      message: atEnd && !advanced ? `${verb}：已在边界，位置不变（第 ${s.currentIndex + 1} 句）` : `${verb} → 第 ${s.currentIndex + 1} 句`,
    });

    if (advanced) this.#changed();
    else this.persist();

    return settle(200, body);
  }

  // ---------- 重置（演示 / 测试） ----------

  reset() {
    // revision / cueNonce 必须继续单调递增：长连接的投影页靠 revision 丢弃迟到消息，
    // 若重置把版本号拨回 1，老投影会把重置快照误判为旧消息而拒绝。
    const nextRevision = this.state.revision + 1;
    const nextCueNonce = this.state.cueNonce + 1;
    this.state = freshState();
    this.state.revision = nextRevision;
    this.state.cueNonce = nextCueNonce;
    this.outcomes.clear();
    this.audit = [];
    this.addAudit({ kind: 'reset', message: '系统已重置为内置示例台词，幂等记录已清空' });
    this.persist();
    this.emit('change', this.publicState());
    return { status: 200, body: { ok: true, ...this.publicState() } };
  }
}

function shortId(id) {
  if (!id) return '(无指令号)';
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}
