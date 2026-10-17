'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const audio = $('#audio');

const state = {
  rows: [],
  audioBuffer: null,
  audioName: 'lyrics',
  tap: { on: false, k: 0, history: [] },
};

/* ---------------- 時間格式 ---------------- */

function fmtLrc(t) {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = (cs % 6000) / 100;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function parseTimeStr(str) {
  str = String(str).trim().replace(/^\[|\]$/g, '');
  if (!str) return null;
  const m = str.match(/^(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.'));
  const n = parseFloat(str);
  return isFinite(n) && n >= 0 ? n : null;
}

function fmtShort(t) {
  if (!isFinite(t)) t = 0;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

function escapeAttr(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- ID3 歌詞讀取 ---------------- */

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u24 = (b, o) => (b[o] << 16) + (b[o + 1] << 8) + b[o + 2];

function removeUnsync(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]);
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return Uint8Array.from(out);
}

function decodeLegacy(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {}
  if (!bytes.some((x) => x > 0x7f)) return new TextDecoder('latin1').decode(bytes);
  const bad = (s) => (s.match(/\uFFFD/g) || []).length;
  const big5 = new TextDecoder('big5').decode(bytes);
  const gbk = new TextDecoder('gbk').decode(bytes);
  return bad(big5) <= bad(gbk) ? big5 : gbk;
}

function decodeText(enc, bytes) {
  if (!bytes.length) return '';
  if (enc === 1) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
  if (enc === 3) return new TextDecoder('utf-8').decode(bytes);
  return decodeLegacy(bytes);
}

// 回傳 [字串結尾位置, 下一段開始位置]
function findTerm(enc, b, start) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return [i, i + 2];
    return [b.length, b.length];
  }
  for (let i = start; i < b.length; i++) if (b[i] === 0) return [i, i + 1];
  return [b.length, b.length];
}

function readTextFrame(f) {
  const enc = f[0];
  const [end] = findTerm(enc, f, 1);
  return decodeText(enc, f.subarray(1, end)).trim();
}

function readUSLT(f) {
  const enc = f[0];
  const [, next] = findTerm(enc, f, 4);
  return decodeText(enc, f.subarray(next)).replace(/\0+$/, '');
}

function readSYLT(f) {
  const enc = f[0];
  let [, pos] = findTerm(enc, f, 6);
  const items = [];
  while (pos < f.length) {
    const [end, next] = findTerm(enc, f, pos);
    if (next + 4 > f.length) break;
    const text = decodeText(enc, f.subarray(pos, end));
    const time = u32(f, next);
    items.push({ text, t: time / 1000 });
    pos = next + 4;
  }
  return items;
}

function parseID3(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
  const ver = b[3];
  const flags = b[5];
  const size = syncsafe(b, 6);
  let data = b.subarray(10, 10 + size);
  if (flags & 0x80 && ver < 4) data = removeUnsync(data);
  let pos = 0;
  if (flags & 0x40 && ver >= 3) pos = ver === 4 ? syncsafe(data, 0) : u32(data, 0) + 4;

  const res = { title: '', artist: '', uslt: [], sylt: [] };
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  while (pos + hdrLen <= data.length) {
    const id = String.fromCharCode(...data.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const fsize = ver === 2 ? u24(data, pos + 3) : ver === 4 ? syncsafe(data, pos + 4) : u32(data, pos + 4);
    const fmtFlags = ver === 2 ? 0 : data[pos + 9];
    let f = data.subarray(pos + hdrLen, pos + hdrLen + fsize);
    pos += hdrLen + fsize;
    if (!fsize) continue;
    if (ver === 4) {
      if (fmtFlags & 0x0c) continue;
      if (fmtFlags & 0x02) f = removeUnsync(f);
      if (fmtFlags & 0x01) f = f.subarray(4);
    } else if (ver === 3 && fmtFlags & 0xc0) {
      continue;
    }
    try {
      if (id === 'TIT2' || id === 'TT2') res.title = readTextFrame(f);
      else if (id === 'TPE1' || id === 'TP1') res.artist = readTextFrame(f);
      else if (id === 'USLT' || id === 'ULT') res.uslt.push(readUSLT(f));
      else if (id === 'SYLT' || id === 'SLT') res.sylt.push(readSYLT(f));
    } catch (err) {
      console.warn('ID3 frame error', id, err);
    }
  }
  return res;
}

// SYLT 可能是逐句，也可能是逐字（新的一行以換行字元開頭）
function syltToRows(items) {
  const isWordLevel = items.some((it, i) => i > 0 && /^[\r\n]/.test(it.text));
  if (!isWordLevel) {
    return items.map((it) => ({ t: it.t, text: it.text.trim() })).filter((r) => r.text);
  }
  const lines = [];
  for (const it of items) {
    if (/^[\r\n]/.test(it.text) || !lines.length) lines.push([]);
    const text = it.text.replace(/^[\r\n]+/, '');
    if (text) lines[lines.length - 1].push({ t: it.t, text });
  }
  return lines
    .filter((segs) => segs.length)
    .map((segs) => ({
      t: segs[0].t,
      text: segs.length > 1 ? segs.map((s) => `<${fmtLrc(s.t)}>${s.text}`).join('') : segs[0].text.trim(),
    }));
}

function lrcTextToRows(text) {
  const rows = [];
  const meta = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const mm = line.match(/^\[(ti|ar|al|by|offset):(.*)\]$/i);
    if (mm) { meta[mm[1].toLowerCase()] = mm[2].trim(); continue; }
    const times = [];
    let rest = line;
    let m;
    while ((m = rest.match(/^\[(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]/))) {
      times.push(parseTimeStr(m[1]));
      rest = rest.slice(m[0].length);
    }
    if (times.length) times.forEach((t) => rows.push({ t, text: rest.trim() }));
    else rows.push({ t: null, text: line });
  }
  rows.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
  return { rows, meta };
}

/* ---------------- 載入 MP3 ---------------- */

async function loadAudio(files) {
  const file = files.find((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(f.name));
  if (!file) return;
  stopTap();
  if (audio.src) URL.revokeObjectURL(audio.src);
  audio.src = URL.createObjectURL(file);
  state.audioName = file.name.replace(/\.[^.]+$/, '');
  state.audioBuffer = await file.arrayBuffer();
  $('#audioLabel').textContent = '🎵 ' + file.name;
  $('#audioDrop').classList.add('filled');

  const id3 = parseID3(state.audioBuffer);
  const status = $('#id3Status');
  $('#songTitle').value = (id3 && id3.title) || '';
  $('#songArtist').value = (id3 && id3.artist) || '';
  if (!$('#songTitle').value) {
    const parts = state.audioName.split(/\s+-\s+/);
    if (parts.length === 2) {
      $('#songArtist').value = parts[0];
      $('#songTitle').value = parts[1];
    } else {
      $('#songTitle').value = state.audioName;
    }
  }

  const sylt = id3 && id3.sylt.find((x) => x.length);
  const uslt = id3 && id3.uslt.find((x) => x.trim());
  if (sylt) {
    setRowsConfirm(syltToRows(sylt), '✅ 已從 MP3 內嵌的「同步歌詞」讀到時間軸，放進右邊編輯區了。');
  } else if (uslt && /\[\d{1,3}:\d{1,2}/.test(uslt)) {
    setRowsConfirm(lrcTextToRows(uslt).rows, '✅ 已從 MP3 內嵌歌詞讀到 LRC 時間軸，放進右邊編輯區了。');
  } else if (uslt) {
    $('#pasteText').value = uslt.trim();
    switchSrc('paste');
    status.textContent = '📄 MP3 內有歌詞文字（但沒有時間），已放到「貼上歌詞再對時」，按「放進編輯區」再打點即可。';
  } else {
    status.textContent = 'ℹ️ 這個 MP3 沒有內嵌歌詞，可以用 AI 辨識或貼上歌詞。';
  }
  renderLrc();
}

function setRowsConfirm(rows, msg) {
  if (state.rows.length && !confirm('編輯區已經有歌詞，要用新的內容取代嗎？')) return false;
  state.rows = rows;
  renderRows();
  if (msg) $('#id3Status').textContent = msg;
  return true;
}

/* ---------------- 取得歌詞：切換 ---------------- */

function switchSrc(mode) {
  $$('#srcMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $$('.src-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== mode));
}
$('#srcMode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) switchSrc(b.dataset.mode);
});

/* ---------------- 貼上歌詞 ---------------- */

function pastedRows() {
  const text = $('#pasteText').value;
  if (/\[\d{1,3}:\d{1,2}/.test(text)) {
    const { rows, meta } = lrcTextToRows(text);
    if (meta.ti) $('#songTitle').value = meta.ti;
    if (meta.ar) $('#songArtist').value = meta.ar;
    return rows;
  }
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((text) => ({ t: null, text }));
}

$('#pasteApply').addEventListener('click', () => {
  const rows = pastedRows();
  if (!rows.length) { alert('請先貼上歌詞'); return; }
  if (setRowsConfirm(rows)) renderLrc();
});

$('#pasteEven').addEventListener('click', () => {
  const d = audio.duration;
  if (!isFinite(d)) { alert('請先放入 MP3'); return; }
  const rows = pastedRows().filter((r) => r.text);
  if (!rows.length) { alert('請先貼上歌詞'); return; }
  const start = Math.min(10, d * 0.08);
  const step = (d - start - 3) / rows.length;
  rows.forEach((r, i) => { r.t = start + i * step; });
  if (setRowsConfirm(rows)) renderLrc();
});

/* ---------------- AI 辨識 ---------------- */

let worker = null;
let opencc = null;

function loadOpenCC() {
  if (opencc) return Promise.resolve(opencc);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/full.js';
    s.onload = () => {
      try { opencc = window.OpenCC.Converter({ from: 'cn', to: 'tw' }); } catch { opencc = null; }
      resolve(opencc);
    };
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}

async function decodeTo16k(arrayBuffer) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
  ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

async function pickDevice() {
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) return 'webgpu';
  } catch {}
  return 'wasm';
}

function setAiBusy(busy) {
  $('#aiRun').disabled = busy;
  $('#aiBar').classList.toggle('indeterminate', busy);
  if (!busy) $('#aiBar').style.width = '0';
}

async function runAI() {
  if (!state.audioBuffer) { alert('請先放入 MP3'); return; }
  if (location.protocol === 'file:') {
    alert('AI 辨識需要用「啟動.command」開啟網頁（網址是 http://localhost 開頭）才能使用。');
    return;
  }
  setAiBusy(true);
  const status = $('#aiStatus');
  const partial = $('#aiPartial');
  partial.textContent = '';
  partial.classList.add('hidden');
  const t0 = performance.now();
  let timer = null;

  try {
    status.textContent = '正在讀取音訊…';
    const pcm = await decodeTo16k(state.audioBuffer);
    const device = await pickDevice();
    if (!worker) worker = new Worker('lrc-worker.js', { type: 'module' });

    const result = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'status') {
          status.textContent = m.msg;
          if (m.msg.startsWith('辨識中')) {
            const base = m.msg;
            clearInterval(timer);
            timer = setInterval(() => {
              status.textContent = `${base}（已經過 ${fmtShort((performance.now() - t0) / 1000)}）`;
            }, 1000);
          }
        } else if (m.type === 'download') {
          const pct = m.total ? Math.round((m.loaded / m.total) * 100) : 0;
          $('#aiBar').classList.remove('indeterminate');
          $('#aiBar').style.width = pct + '%';
          status.textContent = `下載模型中… ${pct}%（${(m.loaded / 1048576).toFixed(0)} / ${(m.total / 1048576).toFixed(0)} MB，只有第一次需要）`;
          if (pct >= 100) $('#aiBar').classList.add('indeterminate');
        } else if (m.type === 'partial') {
          partial.classList.remove('hidden');
          partial.textContent += m.text;
          partial.scrollTop = partial.scrollHeight;
        } else if (m.type === 'done') resolve(m);
        else if (m.type === 'error') reject(new Error(m.msg));
      };
      worker.postMessage({ audio: pcm, model: $('#aiModel').value, language: $('#aiLang').value || null, device }, [pcm.buffer]);
    });

    partial.classList.add('hidden');
    const rows = await chunksToRows(result.chunks, audio.duration || pcm.length / 16000);
    if (!rows.filter((r) => r.text).length) {
      status.textContent = '⚠️ 沒有辨識到歌詞。可以換大一點的模型再試，或改用「貼上歌詞再對時」。';
    } else if (setRowsConfirm(rows)) {
      renderLrc();
      status.textContent = `✅ 辨識完成，共 ${rows.filter((r) => r.text).length} 句（花了 ${fmtShort((performance.now() - t0) / 1000)}）。請在右邊播放檢查並修正錯字。`;
    }
  } catch (err) {
    console.error(err);
    status.textContent = '❌ 辨識失敗：' + err.message;
    if (worker) { worker.terminate(); worker = null; }
  } finally {
    clearInterval(timer);
    setAiBusy(false);
  }
}
$('#aiRun').addEventListener('click', runAI);

const HALLUCINATION = /(字幕|訂閱|订阅|點讚|点赞|點贊|打賞|打赏|Amara|謝謝觀看|谢谢观看|多謝收看|多谢收看|請不吝|请不吝|明鏡|明镜|優優|优优|subtitles? by|thanks? for watching)/i;
const PUNCT = /[，。！？、；：「」『』（）《》〈〉“”‘’…—～·,.!?;:"()[\]{}~]/g;
const HAS_CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

function splitLine(text, maxLen) {
  const cjk = HAS_CJK.test(text);
  const pieces = text
    .split(cjk ? /[，。！？、；：,.!?;:\s]+/ : /[，。！？；,.!?;]+\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const limit = cjk ? maxLen : maxLen * 4;
  const out = [];
  let cur = '';
  for (let p of pieces) {
    while (p.length > limit) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(p.slice(0, limit));
      p = p.slice(limit);
    }
    if (!cur) cur = p;
    else if ((cur + p).length <= limit) cur += ' ' + p;
    else { out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  return out;
}

async function chunksToRows(chunks, duration) {
  const useS2T = $('#aiS2T').checked && ($('#aiLang').value === 'chinese' || !$('#aiLang').value);
  const cc = useS2T ? await loadOpenCC() : null;
  const doSplit = $('#aiSplit').checked;
  const maxLen = Math.max(4, parseInt($('#aiMaxLen').value, 10) || 14);
  const noPunct = $('#aiPunct').checked;
  const filter = $('#aiFilter').checked;
  const addGap = $('#aiGap').checked;
  const gapSec = parseFloat($('#aiGapSec').value) || 2.5;

  let segs = chunks.map((c, i) => {
    const s = c.timestamp?.[0] ?? 0;
    let e = c.timestamp?.[1];
    if (e == null) e = chunks[i + 1]?.timestamp?.[0] ?? duration ?? s + 4;
    return { s, e: Math.max(e, s + 0.3), text: (c.text || '').trim() };
  });
  if (cc) segs.forEach((g) => { g.text = cc(g.text); });
  if (filter) segs = segs.filter((g) => !HALLUCINATION.test(g.text));
  segs = segs.filter((g) => g.text.replace(PUNCT, '').trim());

  const lines = [];
  for (const g of segs) {
    if (!doSplit) {
      lines.push({ s: g.s, e: g.e, text: noPunct ? g.text.replace(PUNCT, ' ').replace(/\s+/g, ' ').trim() : g.text });
      continue;
    }
    const parts = splitLine(g.text, maxLen);
    const total = parts.reduce((a, p) => a + p.length, 0) || 1;
    let t = g.s;
    for (const p of parts) {
      const d = ((g.e - g.s) * p.length) / total;
      lines.push({ s: t, e: t + d, text: noPunct ? p.replace(PUNCT, ' ').replace(/\s+/g, ' ').trim() : p });
      t += d;
    }
  }

  const rows = [];
  lines.forEach((l, i) => {
    if (!l.text) return;
    rows.push({ t: l.s, text: l.text });
    const next = lines[i + 1];
    if (addGap && (!next || next.s - l.e >= gapSec)) rows.push({ t: l.e, text: '' });
  });
  return rows;
}

/* ---------------- 編輯區 ---------------- */

const rowsEl = $('#rows');

function renderRows() {
  const tapK = state.tap.on ? state.tap.k : -1;
  rowsEl.innerHTML = state.rows
    .map((r, i) => {
      const gap = !r.text;
      const cls = ['row', gap ? 'gap' : '', r.t == null ? 'bad' : '', i === tapK ? 'next-tap' : ''].join(' ');
      return `<div class="${cls}" data-i="${i}">
        <div class="time-cell">
          <button type="button" data-op="minus" title="提早 0.1 秒">−</button>
          <input class="time" data-k="t" value="${r.t == null ? '' : fmtLrc(r.t)}" placeholder="--:--.--">
          <button type="button" data-op="plus" title="延後 0.1 秒">＋</button>
        </div>
        <input class="text" data-k="text" value="${escapeAttr(r.text)}" placeholder="（句尾／間奏標記）">
        <div class="row-ops">
          <button type="button" data-op="play" title="從這句開始播放">▶</button>
          <button type="button" data-op="now" title="把時間設成目前播放位置">⏱</button>
          <button type="button" data-op="insert" title="在下面插入一句">＋</button>
          <button type="button" data-op="del" title="刪除">✕</button>
        </div>
      </div>`;
    })
    .join('');
  $('#rowsEmpty').classList.toggle('hidden', state.rows.length > 0);
  lastCurrent = -2;
  renderLrc();
}

rowsEl.addEventListener('input', (e) => {
  if (e.target.dataset.k !== 'text') return;
  const i = +e.target.closest('.row').dataset.i;
  state.rows[i].text = e.target.value;
  e.target.closest('.row').classList.toggle('gap', !e.target.value);
  renderLrc();
});

rowsEl.addEventListener('change', (e) => {
  if (e.target.dataset.k !== 't') return;
  const row = e.target.closest('.row');
  const i = +row.dataset.i;
  const t = parseTimeStr(e.target.value);
  state.rows[i].t = t;
  e.target.value = t == null ? '' : fmtLrc(t);
  row.classList.toggle('bad', t == null);
  renderLrc();
});

rowsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-op]');
  if (!btn) return;
  const row = btn.closest('.row');
  const i = +row.dataset.i;
  const r = state.rows[i];
  const setT = (t) => {
    r.t = Math.max(0, t);
    row.querySelector('input.time').value = fmtLrc(r.t);
    row.classList.remove('bad');
    renderLrc();
  };
  switch (btn.dataset.op) {
    case 'minus': if (r.t != null) setT(r.t - 0.1); break;
    case 'plus': if (r.t != null) setT(r.t + 0.1); break;
    case 'now': if (audio.src) setT(audio.currentTime); break;
    case 'play':
      if (audio.src && r.t != null) { audio.currentTime = Math.max(0, r.t - 0.5); audio.play(); }
      break;
    case 'insert': {
      const next = state.rows[i + 1];
      const t = r.t != null && next && next.t != null ? (r.t + next.t) / 2 : r.t;
      state.rows.splice(i + 1, 0, { t, text: '' });
      renderRows();
      rowsEl.querySelector(`.row[data-i="${i + 1}"] input.text`).focus();
      break;
    }
    case 'del':
      state.rows.splice(i, 1);
      renderRows();
      break;
  }
});

$('#addRow').addEventListener('click', () => {
  state.rows.push({ t: audio.src ? audio.currentTime : null, text: '新的一句' });
  renderRows();
  const last = rowsEl.lastElementChild;
  last.scrollIntoView({ block: 'nearest' });
  last.querySelector('input.text').select();
});
$('#addGap').addEventListener('click', () => {
  state.rows.push({ t: audio.src ? audio.currentTime : null, text: '' });
  sortRows();
});
function sortRows() {
  state.rows.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
  renderRows();
}
$('#sortRows').addEventListener('click', sortRows);
$('#shiftAll').addEventListener('click', () => {
  const v = prompt('全部時間要平移幾秒？（正數＝延後，負數＝提早，例如 -0.5）', '0');
  const d = parseFloat(v);
  if (!isFinite(d) || !d) return;
  state.rows.forEach((r) => { if (r.t != null) r.t = Math.max(0, r.t + d); });
  renderRows();
});
$('#clearRows').addEventListener('click', () => {
  if (state.rows.length && confirm('確定要清空編輯區嗎？')) {
    state.rows = [];
    renderRows();
  }
});

/* ---------------- 依序打點 ---------------- */

function nextLyricIndex(from) {
  for (let i = from; i < state.rows.length; i++) if (state.rows[i].text) return i;
  return -1;
}

function updateTapBar() {
  const total = state.rows.filter((r) => r.text).length;
  const done = state.rows.slice(0, state.tap.k).filter((r) => r.text).length;
  $('#tapProgress').textContent = state.tap.k < 0 ? `全部完成（${total} 句）` : `${done} / ${total}`;
}

async function startTap() {
  if (!audio.src) { alert('請先放入 MP3'); return; }
  if (!state.rows.some((r) => r.text)) { alert('編輯區還沒有歌詞，請先貼上歌詞並按「放進編輯區」'); return; }
  if (state.rows.some((r) => !r.text)) {
    state.rows = state.rows.filter((r) => r.text);
  }
  state.tap = { on: true, k: nextLyricIndex(0), history: [] };
  $('#tapBar').classList.remove('hidden');
  $('#tapBtn').textContent = '⏹ 結束打點';
  document.activeElement && document.activeElement.blur();
  renderRows();
  updateTapBar();
  audio.currentTime = 0;
  await audio.play();
}

function stopTap() {
  if (!state.tap.on) return;
  state.tap.on = false;
  $('#tapBar').classList.add('hidden');
  $('#tapBtn').textContent = '🎯 依序打點';
  audio.pause();
  renderRows();
}

function tapHit() {
  const k = state.tap.k;
  if (k < 0) return;
  const r = state.rows[k];
  state.tap.history.push({ type: 'hit', i: k, prev: r.t, at: audio.currentTime });
  r.t = audio.currentTime;
  state.tap.k = nextLyricIndex(k + 1);
  renderRows();
  scrollToTap();
  updateTapBar();
}

function tapGap() {
  const last = state.tap.history[state.tap.history.length - 1];
  if (!last || last.type !== 'hit') return;
  const at = last.i + 1;
  state.rows.splice(at, 0, { t: audio.currentTime, text: '' });
  if (state.tap.k >= at) state.tap.k++;
  state.tap.history.push({ type: 'gap', i: at, at: audio.currentTime });
  renderRows();
  updateTapBar();
}

function tapUndo() {
  const h = state.tap.history.pop();
  if (!h) return;
  if (h.type === 'hit') {
    state.rows[h.i].t = h.prev;
    state.tap.k = h.i;
  } else {
    state.rows.splice(h.i, 1);
    if (state.tap.k > h.i) state.tap.k--;
  }
  audio.currentTime = Math.max(0, h.at - 3);
  renderRows();
  scrollToTap();
  updateTapBar();
}

function scrollToTap() {
  const el = rowsEl.querySelector('.row.next-tap');
  if (el) el.scrollIntoView({ block: 'center' });
}

$('#tapBtn').addEventListener('click', () => (state.tap.on ? stopTap() : startTap()));
audio.addEventListener('ended', stopTap);

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.readOnly;
  if (state.tap.on) {
    if (e.key === 'Escape') { e.preventDefault(); stopTap(); return; }
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); tapHit(); }
    else if (e.code === 'KeyX') { e.preventDefault(); tapGap(); }
    else if (e.code === 'KeyZ') { e.preventDefault(); tapUndo(); }
    return;
  }
  if (typing) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
});

/* ---------------- 播放器 ---------------- */

function togglePlay() {
  if (!audio.src) return;
  if (audio.paused) audio.play();
  else audio.pause();
}
$('#playBtn').addEventListener('click', (e) => { e.currentTarget.blur(); togglePlay(); });
audio.addEventListener('play', () => { $('#playBtn').textContent = '⏸'; });
audio.addEventListener('pause', () => { $('#playBtn').textContent = '▶'; });
$('#seek').addEventListener('input', (e) => {
  if (isFinite(audio.duration)) audio.currentTime = (e.target.value / 1000) * audio.duration;
});

let lastCurrent = -2;
function tick() {
  const d = audio.duration;
  const t = audio.currentTime || 0;
  if (document.activeElement !== $('#seek')) $('#seek').value = isFinite(d) && d ? Math.round((t / d) * 1000) : 0;
  $('#timeLabel').textContent = `${fmtLrc(t)} / ${fmtShort(d)}`;

  let cur = -1;
  let best = -Infinity;
  state.rows.forEach((r, i) => {
    if (r.t != null && r.t <= t && r.t >= best) { best = r.t; cur = i; }
  });
  if (cur !== lastCurrent) {
    lastCurrent = cur;
    $$('#rows .row').forEach((el) => el.classList.toggle('current', +el.dataset.i === cur));
    if (cur >= 0 && !audio.paused && !state.tap.on) {
      const el = rowsEl.querySelector(`.row[data-i="${cur}"]`);
      if (el && !rowsEl.contains(document.activeElement)) el.scrollIntoView({ block: 'nearest' });
    }
  }
  requestAnimationFrame(tick);
}

/* ---------------- 輸出 ---------------- */

function buildLrc() {
  const head = [];
  const title = $('#songTitle').value.trim();
  const artist = $('#songArtist').value.trim();
  if (title) head.push(`[ti:${title}]`);
  if (artist) head.push(`[ar:${artist}]`);
  const timed = state.rows.filter((r) => r.t != null).slice().sort((a, b) => a.t - b.t);
  const body = timed.filter((r, i) => r.text || (i > 0 && timed[i - 1].text));
  return head.concat(body.map((r) => `[${fmtLrc(r.t)}]${r.text}`)).join('\n');
}

function renderLrc() {
  $('#lrcOut').value = state.rows.length ? buildLrc() : '';
  const missing = state.rows.filter((r) => r.t == null && r.text).length;
  const unsorted = state.rows.some((r, i) => i > 0 && r.t != null && state.rows[i - 1].t != null && r.t < state.rows[i - 1].t);
  const warns = [];
  if (missing) warns.push(`⚠️ 有 ${missing} 句還沒有時間（黃框），輸出時會被略過，可以用「🎯 依序打點」補上。`);
  if (unsorted) warns.push('ℹ️ 有幾句的時間順序顛倒，輸出時已自動依時間排序。');
  $('#lrcWarn').textContent = warns.join(' ');
}

$('#songTitle').addEventListener('input', renderLrc);
$('#songArtist').addEventListener('input', renderLrc);

$('#downloadLrc').addEventListener('click', () => {
  const text = buildLrc();
  if (!state.rows.length) { alert('還沒有歌詞'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `${$('#songTitle').value.trim() || state.audioName}.lrc`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#copyLrc').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(buildLrc());
    $('#copyLrc').textContent = '✅ 已複製';
  } catch {
    $('#lrcOut').select();
    document.execCommand('copy');
    $('#copyLrc').textContent = '✅ 已複製';
  }
  setTimeout(() => { $('#copyLrc').textContent = '📋 複製'; }, 1500);
});

$('#sendToMp4').addEventListener('click', () => {
  if (!state.rows.length) { alert('還沒有歌詞'); return; }
  localStorage.setItem('ktv-lrc-handoff', JSON.stringify({
    lrc: buildLrc(),
    title: $('#songTitle').value.trim(),
    artist: $('#songArtist').value.trim(),
    at: Date.now(),
  }));
  window.open('index.html', 'ktv-mp4');
  alert('歌詞已送到 MP4 製作頁的「3. 歌詞」。\n瀏覽器無法自動帶過去音樂檔，請在那邊再放一次同一首 MP3。');
});

/* ---------------- 初始化 ---------------- */

function setupDrop(dropEl, inputEl, handler) {
  inputEl.addEventListener('change', () => {
    if (inputEl.files.length) handler(Array.from(inputEl.files));
    inputEl.value = '';
  });
  dropEl.addEventListener('dragover', (e) => { e.preventDefault(); dropEl.classList.add('over'); });
  dropEl.addEventListener('dragleave', () => dropEl.classList.remove('over'));
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropEl.classList.remove('over');
    if (e.dataTransfer.files.length) handler(Array.from(e.dataTransfer.files));
  });
}

setupDrop($('#audioDrop'), $('#audioInput'), loadAudio);
renderRows();
requestAnimationFrame(tick);
