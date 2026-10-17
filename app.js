'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const audio = $('#audio');
const bgVideo = $('#bgVideo');
let W = canvas.width;
let H = canvas.height;

const TRANSITIONS = [
  ['none', '無'],
  ['fade', '淡入淡出'],
  ['slide-left', '向左推移'],
  ['slide-right', '向右推移'],
  ['slide-up', '向上推移'],
  ['slide-down', '向下推移'],
  ['zoom-in', '放大進入'],
  ['zoom-out', '縮小進入'],
  ['wipe', '擦除'],
  ['circle', '圓形展開'],
  ['blinds', '百葉窗'],
  ['blur', '模糊轉場'],
  ['rotate', '旋轉進入'],
];
const MOTIONS = [
  ['none', '靜止'],
  ['zoom-in', '緩慢放大'],
  ['zoom-out', '緩慢縮小'],
  ['pan-left', '向左平移'],
  ['pan-right', '向右平移'],
];
const COLOR_PRESETS = {
  blue: ['#ffffff', '#1a1a1a', '#2f7dff', '#ffffff'],
  pink: ['#ffffff', '#1a1a1a', '#ff3d8b', '#ffffff'],
  gold: ['#ffffff', '#202020', '#ffc21a', '#5a2a00'],
  green: ['#ffffff', '#1a1a1a', '#1fd17a', '#0b3d22'],
};
const MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.640028,mp4a.40.2"',
  'video/mp4;codecs="avc1.4D4028,mp4a.40.2"',
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs="vp9,opus"',
  'video/webm;codecs="vp8,opus"',
  'video/webm',
];
// 下一句歌詞提早幾秒出現
const PRE = 6;

const SUPPORTS_FILTER = (() => {
  try {
    const c = document.createElement('canvas').getContext('2d');
    c.filter = 'blur(2px)';
    return c.filter === 'blur(2px)';
  } catch {
    return false;
  }
})();

const state = {
  bgMode: 'none',
  images: [],
  lyrics: [],
  exporting: false,
  audioName: 'output',
  videoSmall: document.createElement('canvas'),
};

/* ---------------- 設定值 ---------------- */

const OPT_IDS = [
  'bgColor', 'bgDim', 'imageFit', 'imageTiming', 'videoFit', 'videoLoop',
  'lyricLayout', 'fontFamily', 'fontBold', 'fontSize', 'strokeWidth',
  'colorBase', 'colorBaseStroke', 'colorSung', 'colorSungStroke',
  'marginBottom', 'lyricOffset', 'lyricShade',
  'songTitle', 'songArtist', 'showTitleIntro',
  'resolution', 'fps', 'bitrate', 'muteMonitor',
];
const opt = {};

function readOpts() {
  for (const id of OPT_IDS) {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') opt[id] = el.checked;
    else if (el.type === 'range' || el.type === 'number') opt[id] = parseFloat(el.value) || 0;
    else opt[id] = el.value;
  }
  opt.fps = parseInt(opt.fps, 10) || 30;
  opt.bitrate = parseFloat(opt.bitrate) || 8;
  for (const o of $$('output[data-for]')) {
    o.textContent = document.getElementById(o.dataset.for).value;
  }
}

function onOptChange(e) {
  if (!OPT_IDS.includes(e.target.id)) return;
  readOpts();
  if (e.target.id === 'resolution') setResolution();
  if (e.target.id === 'imageTiming') renderImageList();
  if (e.target.id === 'videoLoop') bgVideo.loop = opt.videoLoop;
}
document.addEventListener('input', onOptChange);
document.addEventListener('change', onOptChange);

function setResolution() {
  const [w, h] = opt.resolution.split('x').map(Number);
  canvas.width = W = w;
  canvas.height = H = h;
}

/* ---------------- 工具 ---------------- */

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function lrcTime(t) {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = (cs % 6000) / 100;
  return `[${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}]`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function optionsHtml(list, selected) {
  return list.map(([v, l]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${l}</option>`).join('');
}

function audioDur() {
  return isFinite(audio.duration) ? audio.duration : 0;
}

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

function makeSmall(src, sw, sh, target) {
  const c = target || document.createElement('canvas');
  const w = 48;
  const h = Math.max(1, Math.round((w * sh) / sw));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return c;
}

/* ---------------- 音訊 ---------------- */

let actx = null;
let recDest = null;
let monitorGain = null;

function ensureAudioGraph() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  const src = actx.createMediaElementSource(audio);
  recDest = actx.createMediaStreamDestination();
  monitorGain = actx.createGain();
  src.connect(recDest);
  src.connect(monitorGain);
  monitorGain.connect(actx.destination);
}

function loadAudio(files) {
  const file = files.find((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(f.name));
  if (!file || state.exporting) return;
  if (audio.src) URL.revokeObjectURL(audio.src);
  audio.src = URL.createObjectURL(file);
  state.audioName = file.name.replace(/\.[^.]+$/, '');
  $('#audioLabel').textContent = '🎵 ' + file.name;
  $('#audioDrop').classList.add('filled');

  if (!$('#songTitle').value && !$('#songArtist').value) {
    const parts = state.audioName.split(/\s+-\s+/);
    if (parts.length === 2) {
      $('#songArtist').value = parts[0];
      $('#songTitle').value = parts[1];
    } else {
      $('#songTitle').value = state.audioName;
    }
    readOpts();
  }
}

audio.addEventListener('loadedmetadata', () => {
  renderImageList();
  updatePlayerUI();
});

async function togglePlay() {
  if (!audio.src) { alert('請先選擇 MP3 音樂檔'); return; }
  if (state.exporting) return;
  ensureAudioGraph();
  await actx.resume();
  if (audio.paused) await audio.play();
  else audio.pause();
}

audio.addEventListener('play', () => { $('#playBtn').textContent = '⏸'; syncVideo(true); });
audio.addEventListener('pause', () => { $('#playBtn').textContent = '▶'; syncVideo(true); });
audio.addEventListener('ended', () => {
  if (state.exporting && recorder && recorder.state !== 'inactive') {
    setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), 300);
  }
});

$('#playBtn').addEventListener('click', (e) => { e.currentTarget.blur(); togglePlay(); });
$('#seek').addEventListener('input', (e) => {
  const d = audioDur();
  if (!d || state.exporting) return;
  audio.currentTime = (e.target.value / 1000) * d;
  syncVideo(true);
});

function updatePlayerUI() {
  const d = audioDur();
  const t = audio.currentTime || 0;
  if (document.activeElement !== $('#seek')) $('#seek').value = d ? Math.round((t / d) * 1000) : 0;
  $('#timeLabel').textContent = `${fmt(t)} / ${fmt(d)}`;
}

/* ---------------- 背景：模式 ---------------- */

$('#bgMode').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn || state.exporting) return;
  state.bgMode = btn.dataset.mode;
  $$('#bgMode button').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.bg-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== state.bgMode));
  syncVideo(true);
});

/* ---------------- 背景：圖片 ---------------- */

async function loadImageFile(file) {
  const bmp = await createImageBitmap(file);
  const MAX = 2560;
  const r = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * r);
  c.height = Math.round(bmp.height * r);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();

  const t = document.createElement('canvas');
  const tr = 160 / Math.max(c.width, c.height);
  t.width = Math.round(c.width * tr);
  t.height = Math.round(c.height * tr);
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);

  return {
    name: file.name,
    src: c,
    w: c.width,
    h: c.height,
    small: makeSmall(c, c.width, c.height),
    thumb: t.toDataURL('image/jpeg', 0.8),
    trans: 'none',
    transDur: 1,
    motion: 'none',
    duration: 5,
  };
}

async function addImages(files) {
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  for (const f of imgs) {
    try {
      state.images.push(await loadImageFile(f));
    } catch (err) {
      console.error(err);
      alert(`無法讀取圖片：${f.name}`);
    }
  }
  renderImageList();
}

function getImageDurations() {
  const n = state.images.length;
  const total = audioDur();
  return state.images.map((im) =>
    opt.imageTiming === 'auto' ? (total > 0 ? total / n : 5) : Math.max(0.5, im.duration || 5)
  );
}

function imageAt(t) {
  const durs = getImageDurations();
  const n = durs.length;
  const cycle = durs.reduce((a, b) => a + b, 0);
  if (opt.imageTiming === 'auto' && t >= cycle) {
    return { i: n - 1, local: durs[n - 1], dur: durs[n - 1], prev: -1, prevDur: 0, noTrans: true };
  }
  const cycleIdx = Math.floor(t / cycle);
  const tt = t - cycleIdx * cycle;
  let acc = 0;
  let i = 0;
  while (i < n - 1 && tt >= acc + durs[i]) { acc += durs[i]; i++; }
  let prev = i - 1;
  if (i === 0 && cycleIdx > 0) prev = n - 1;
  return {
    i,
    local: tt - acc,
    dur: durs[i],
    prev,
    prevDur: prev >= 0 ? durs[prev] : 0,
    noTrans: n === 1 && cycleIdx > 0,
  };
}

function imageStartTime(index) {
  const durs = getImageDurations();
  let acc = 0;
  for (let i = 0; i < index; i++) acc += durs[i];
  return acc;
}

function renderImageList() {
  const ul = $('#imageList');
  ul.innerHTML = '';
  const auto = opt.imageTiming === 'auto';
  const durs = getImageDurations();
  let acc = 0;
  state.images.forEach((im, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.index = i;
    li.innerHTML = `
      <img src="${im.thumb}" alt="">
      <div class="img-fields">
        <div class="img-title">#${i + 1} <span>${escapeHtml(im.name)}</span><small>${fmt(acc)} 開始</small></div>
        <label>轉場<select data-k="trans">${optionsHtml(TRANSITIONS, im.trans)}</select></label>
        <label>轉場秒數<input type="number" data-k="transDur" min="0.1" max="10" step="0.1" value="${im.transDur}"></label>
        <label>畫面動態<select data-k="motion">${optionsHtml(MOTIONS, im.motion)}</select></label>
        <label>顯示秒數<input type="number" data-k="duration" min="0.5" step="0.5" value="${auto ? durs[i].toFixed(1) : im.duration}"${auto ? ' disabled title="改成「每張自訂秒數」才能修改"' : ''}></label>
      </div>
      <div class="img-ops">
        <button type="button" data-op="jump" title="預覽這張">▶</button>
        <button type="button" data-op="up" title="上移">↑</button>
        <button type="button" data-op="down" title="下移">↓</button>
        <button type="button" data-op="del" title="刪除">✕</button>
      </div>`;
    acc += durs[i];
    ul.appendChild(li);
  });
}

const imageList = $('#imageList');

imageList.addEventListener('input', (e) => {
  const k = e.target.dataset.k;
  const li = e.target.closest('li');
  if (!k || !li) return;
  const im = state.images[+li.dataset.index];
  im[k] = e.target.tagName === 'SELECT' ? e.target.value : parseFloat(e.target.value) || 0;
});
imageList.addEventListener('change', (e) => {
  if (e.target.dataset.k === 'duration') renderImageList();
});
imageList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-op]');
  if (!btn) return;
  const i = +btn.closest('li').dataset.index;
  const imgs = state.images;
  switch (btn.dataset.op) {
    case 'jump':
      if (audioDur() && !state.exporting) {
        audio.currentTime = imageStartTime(i) + 0.001;
        syncVideo(true);
      }
      return;
    case 'up': if (i > 0) [imgs[i - 1], imgs[i]] = [imgs[i], imgs[i - 1]]; break;
    case 'down': if (i < imgs.length - 1) [imgs[i + 1], imgs[i]] = [imgs[i], imgs[i + 1]]; break;
    case 'del': imgs.splice(i, 1); break;
  }
  renderImageList();
});

let dragIndex = -1;
imageList.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  dragIndex = +li.dataset.index;
  e.dataTransfer.effectAllowed = 'move';
});
imageList.addEventListener('dragover', (e) => {
  const li = e.target.closest('li');
  if (!li || dragIndex < 0) return;
  e.preventDefault();
  $$('#imageList li').forEach((x) => x.classList.toggle('drag-over', x === li));
});
imageList.addEventListener('drop', (e) => {
  const li = e.target.closest('li');
  if (!li || dragIndex < 0) return;
  e.preventDefault();
  const to = +li.dataset.index;
  const [item] = state.images.splice(dragIndex, 1);
  state.images.splice(to, 0, item);
  dragIndex = -1;
  renderImageList();
});
imageList.addEventListener('dragend', () => {
  dragIndex = -1;
  $$('#imageList li').forEach((x) => x.classList.remove('drag-over'));
});

$('#bulkTrans').innerHTML = optionsHtml(TRANSITIONS, 'fade');
$('#bulkMotion').innerHTML = optionsHtml(MOTIONS, 'none');
$('#bulkApply').addEventListener('click', () => {
  const trans = $('#bulkTrans').value;
  const transDur = parseFloat($('#bulkTransDur').value) || 1;
  const motion = $('#bulkMotion').value;
  state.images.forEach((im) => Object.assign(im, { trans, transDur, motion }));
  renderImageList();
});

/* ---------------- 背景：影片 ---------------- */

function loadVideo(files) {
  const file = files.find((f) => f.type.startsWith('video/'));
  if (!file || state.exporting) return;
  if (bgVideo.src) URL.revokeObjectURL(bgVideo.src);
  bgVideo.src = URL.createObjectURL(file);
  bgVideo.muted = true;
  bgVideo.loop = opt.videoLoop;
  $('#videoLabel').textContent = '🎞 ' + file.name + '（已移除原聲）';
  $('#videoDrop').classList.add('filled');
  bgVideo.addEventListener('loadeddata', () => syncVideo(true), { once: true });
}

function videoTargetTime(t) {
  const d = bgVideo.duration;
  if (!d || !isFinite(d)) return 0;
  return opt.videoLoop ? t % d : Math.min(t, d - 0.05);
}

function syncVideo(force) {
  if (!bgVideo.src) return;
  if (state.bgMode !== 'video') {
    if (!bgVideo.paused) bgVideo.pause();
    return;
  }
  const d = isFinite(bgVideo.duration) ? bgVideo.duration : 0;
  if (d) {
    const target = videoTargetTime(audio.currentTime || 0);
    let diff = Math.abs(bgVideo.currentTime - target);
    if (opt.videoLoop) diff = Math.min(diff, d - diff);
    if ((force || diff > 0.35) && !bgVideo.seeking) bgVideo.currentTime = target;
  }
  const pastEnd = !opt.videoLoop && d && audio.currentTime >= d;
  if (!audio.paused && bgVideo.paused && !pastEnd) bgVideo.play().catch(() => {});
  if ((audio.paused || pastEnd) && !bgVideo.paused) bgVideo.pause();
}

/* ---------------- 畫面繪製 ---------------- */

function drawFit(src, sw, sh, cover, extra = 1) {
  const r = (cover ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh)) * extra;
  const dw = sw * r;
  const dh = sh * r;
  ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
}

function drawMedia(src, sw, sh, fit, motion, mp, small) {
  if (!sw || !sh) return;
  mp = clamp(mp, 0, 1);
  let s = 1;
  let dx = 0;
  switch (motion) {
    case 'zoom-in': s = 1 + 0.15 * mp; break;
    case 'zoom-out': s = 1.15 - 0.15 * mp; break;
    case 'pan-left': s = 1.15; dx = (0.5 - mp) * W * 0.12; break;
    case 'pan-right': s = 1.15; dx = (mp - 0.5) * W * 0.12; break;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  if (fit !== 'cover') {
    ctx.fillStyle = opt.bgColor;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.translate(W / 2 + dx, H / 2);
  ctx.scale(s, s);
  if (fit === 'cover') {
    drawFit(src, sw, sh, true);
  } else {
    if (fit === 'blur' && small) {
      drawFit(small, small.width, small.height, true, 1.15);
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(-W, -H, W * 2, H * 2);
    }
    drawFit(src, sw, sh, false);
  }
  ctx.restore();
}

function drawImageItem(im, mp) {
  drawMedia(im.src, im.w, im.h, opt.imageFit, im.motion, mp, im.small);
}

function layer(draw, setup) {
  ctx.save();
  if (setup) setup();
  draw();
  ctx.restore();
}

function scaleAround(s) {
  ctx.translate(W / 2, H / 2);
  ctx.scale(s, s);
  ctx.translate(-W / 2, -H / 2);
}

function applyTransition(type, p, drawPrev, drawCur) {
  const prev = () => { if (drawPrev) drawPrev(); };
  const S = Math.min(W, H) / 1080;
  switch (type) {
    case 'fade':
      prev(); layer(drawCur, () => { ctx.globalAlpha = p; }); break;
    case 'slide-left':
      layer(prev, () => ctx.translate(-p * W, 0)); layer(drawCur, () => ctx.translate((1 - p) * W, 0)); break;
    case 'slide-right':
      layer(prev, () => ctx.translate(p * W, 0)); layer(drawCur, () => ctx.translate(-(1 - p) * W, 0)); break;
    case 'slide-up':
      layer(prev, () => ctx.translate(0, -p * H)); layer(drawCur, () => ctx.translate(0, (1 - p) * H)); break;
    case 'slide-down':
      layer(prev, () => ctx.translate(0, p * H)); layer(drawCur, () => ctx.translate(0, -(1 - p) * H)); break;
    case 'zoom-in':
      prev(); layer(drawCur, () => { ctx.globalAlpha = p; scaleAround(0.5 + 0.5 * p); }); break;
    case 'zoom-out':
      prev(); layer(drawCur, () => { ctx.globalAlpha = p; scaleAround(1.6 - 0.6 * p); }); break;
    case 'wipe':
      prev(); layer(drawCur, () => { ctx.beginPath(); ctx.rect(0, 0, W * p, H); ctx.clip(); }); break;
    case 'circle':
      prev();
      layer(drawCur, () => {
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, Math.max(0.1, (p * Math.hypot(W, H)) / 2), 0, Math.PI * 2);
        ctx.clip();
      });
      break;
    case 'blinds':
      prev();
      layer(drawCur, () => {
        const n = 10;
        const sw = W / n;
        ctx.beginPath();
        for (let k = 0; k < n; k++) ctx.rect(k * sw, 0, sw * p, H);
        ctx.clip();
      });
      break;
    case 'blur':
      if (!SUPPORTS_FILTER) return applyTransition('fade', p, drawPrev, drawCur);
      layer(prev, () => { ctx.filter = `blur(${p * 24 * S}px)`; });
      layer(drawCur, () => { ctx.globalAlpha = p; ctx.filter = `blur(${(1 - p) * 24 * S}px)`; });
      break;
    case 'rotate':
      prev();
      layer(drawCur, () => {
        ctx.globalAlpha = p;
        ctx.translate(W / 2, H / 2);
        ctx.rotate((1 - p) * -Math.PI / 2);
        ctx.scale(0.2 + 0.8 * p, 0.2 + 0.8 * p);
        ctx.translate(-W / 2, -H / 2);
      });
      break;
    default:
      drawCur();
  }
}

function renderImages(t) {
  const a = imageAt(t);
  const cur = state.images[a.i];
  const drawCur = () => drawImageItem(cur, a.local / a.dur);
  const td = Math.min(cur.transDur || 1, a.dur * 0.9);
  if (cur.trans !== 'none' && !a.noTrans && a.local < td) {
    const p = easeInOut(a.local / td);
    const prev = a.prev >= 0 ? state.images[a.prev] : null;
    const drawPrev = prev ? () => drawImageItem(prev, (a.prevDur + a.local) / a.prevDur) : null;
    applyTransition(cur.trans, p, drawPrev, drawCur);
  } else {
    drawCur();
  }
  highlightCurrentImage(a.i);
}

let lastHighlighted = -1;
function highlightCurrentImage(i) {
  if (i === lastHighlighted) return;
  lastHighlighted = i;
  $$('#imageList li').forEach((li) => li.classList.toggle('current', +li.dataset.index === i));
}

function renderVideo() {
  if (!bgVideo.src || bgVideo.readyState < 2) return;
  const vw = bgVideo.videoWidth;
  const vh = bgVideo.videoHeight;
  let small = null;
  if (opt.videoFit === 'blur') small = makeSmall(bgVideo, vw, vh, state.videoSmall);
  drawMedia(bgVideo, vw, vh, opt.videoFit, 'none', 0, small);
}

function render() {
  const t = audio.currentTime || 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (SUPPORTS_FILTER) ctx.filter = 'none';
  ctx.fillStyle = opt.bgColor;
  ctx.fillRect(0, 0, W, H);

  if (state.bgMode === 'images' && state.images.length) renderImages(t);
  else if (state.bgMode === 'video') renderVideo();

  if (opt.bgDim > 0) {
    ctx.fillStyle = `rgba(0,0,0,${opt.bgDim / 100})`;
    ctx.fillRect(0, 0, W, H);
  }
  drawLyricsLayer(t);
}

/* ---------------- 歌詞解析 ---------------- */

const TIME_TAG = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;
const WORD_TAG = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
const toSec = (m, s) => parseInt(m, 10) * 60 + parseFloat(s.replace(':', '.'));

function parseWords(rest) {
  const matches = Array.from(rest.matchAll(WORD_TAG));
  if (!matches.length) return null;
  const segs = [];
  let pos = 0;
  let start = null;
  for (const m of matches) {
    const text = rest.slice(pos, m.index);
    if (text) segs.push({ text, start });
    start = toSec(m[1], m[2]);
    pos = m.index + m[0].length;
  }
  const tail = rest.slice(pos);
  let endMark = null;
  if (tail) segs.push({ text: tail, start });
  else endMark = start;
  return segs.length ? { segs, endMark } : null;
}

function parseLRC(text) {
  const entries = [];
  const meta = {};
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const om = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
    if (om) { offset = parseInt(om[1], 10) / 1000; continue; }
    const mm = line.match(/^\[(ti|ar|al|by):(.*)\]$/i);
    if (mm) { meta[mm[1].toLowerCase()] = mm[2].trim(); continue; }

    const times = [];
    let rest = line;
    let m;
    while ((m = rest.match(TIME_TAG))) {
      times.push(toSec(m[1], m[2]));
      rest = rest.slice(m[0].length);
    }
    if (!times.length) continue;
    const words = parseWords(rest);
    const plain = (words ? words.segs.map((s) => s.text).join('') : rest).trim();
    for (const t of times) {
      entries.push({ time: t - offset, text: plain, words: times.length === 1 ? words : null });
    }
  }
  entries.sort((a, b) => a.time - b.time);

  const lines = [];
  entries.forEach((e, i) => {
    if (!e.text) return;
    const next = entries[i + 1];
    const end = next ? next.time : Math.max(e.time + 6, audioDur());
    const line = { start: e.time, end, text: e.text, segs: null };
    if (e.words) {
      const segs = e.words.segs.map((s) => ({ text: s.text, start: s.start == null ? e.time : s.start - offset }));
      const endMark = e.words.endMark != null ? e.words.endMark - offset : end;
      segs.forEach((s, k) => { s.end = k < segs.length - 1 ? segs[k + 1].start : endMark; });
      line.text = segs.map((s) => s.text).join('');
      line.segs = segs;
    }
    lines.push(line);
  });
  return { lines, meta };
}

function updateLyrics() {
  const text = $('#lyricsInput').value;
  const { lines, meta } = parseLRC(text);
  state.lyrics = lines;
  if (meta.ti && !$('#songTitle').value) $('#songTitle').value = meta.ti;
  if (meta.ar && !$('#songArtist').value) $('#songArtist').value = meta.ar;
  readOpts();

  const status = $('#lyricsStatus');
  if (!text.trim()) status.textContent = '';
  else if (!lines.length) status.textContent = '⚠️ 沒有偵測到時間標記。請用「打點對時工具」幫歌詞加上時間。';
  else {
    const wc = lines.filter((l) => l.segs).length;
    status.textContent = `✅ 已解析 ${lines.length} 句歌詞${wc ? `（其中 ${wc} 句有逐字時間）` : ''}`;
  }
}

let lyricTimer = null;
$('#lyricsInput').addEventListener('input', () => {
  clearTimeout(lyricTimer);
  lyricTimer = setTimeout(updateLyrics, 200);
});
audio.addEventListener('loadedmetadata', updateLyrics);

$('#lrcInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $('#lyricsInput').value = await f.text();
  e.target.value = '';
  updateLyrics();
});

$('#exportLrc').addEventListener('click', () => {
  const text = $('#lyricsInput').value;
  if (!text.trim()) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `${opt.songTitle || state.audioName}.lrc`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ---------------- 歌詞繪製（KTV） ---------------- */

function lyricFont(fs) {
  return `${opt.fontBold ? 'bold ' : ''}${fs}px ${opt.fontFamily}`;
}

function lineProgressPx(line, tl, totalW) {
  if (tl <= line.start) return 0;
  if (line.segs) {
    let acc = '';
    let px = 0;
    for (const s of line.segs) {
      if (tl < s.start) break;
      const before = ctx.measureText(acc).width;
      const segW = ctx.measureText(acc + s.text).width - before;
      const f = clamp((tl - s.start) / Math.max(0.01, s.end - s.start), 0, 1);
      px = before + segW * f;
      acc += s.text;
    }
    return px;
  }
  return totalW * clamp((tl - line.start) / Math.max(0.01, line.end - line.start), 0, 1);
}

function drawKLine(line, x, baseY, align, fs, tl, active, alpha, dots, dotsPos) {
  const S = Math.min(W, H) / 1080;
  ctx.font = lyricFont(fs);
  const maxW = W * 0.86;
  let w = ctx.measureText(line.text).width;
  if (w > maxW) {
    fs = (fs * maxW) / w;
    ctx.font = lyricFont(fs);
    w = ctx.measureText(line.text).width;
  }
  const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  const lw = opt.strokeWidth * 2 * S * (fs / (opt.fontSize * S));

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const paint = (fill, stroke) => {
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 10 * S;
    ctx.shadowOffsetY = 3 * S;
    if (lw > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.strokeText(line.text, left, baseY);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = fill;
    ctx.fillText(line.text, left, baseY);
    ctx.shadowColor = 'transparent';
  };

  paint(opt.colorBase, opt.colorBaseStroke);

  const px = active ? lineProgressPx(line, tl, w) : 0;
  if (px > 0) {
    ctx.save();
    ctx.beginPath();
    const pad = lw + 2;
    const clipW = px >= w - 0.5 ? w + pad * 2 : px + pad;
    ctx.rect(left - pad, baseY - fs * 1.4, clipW, fs * 2);
    ctx.clip();
    paint(opt.colorSung, opt.colorSungStroke);
    ctx.restore();
  }

  if (dots > 0) {
    const r = fs * 0.12;
    ctx.fillStyle = opt.colorSung;
    ctx.strokeStyle = opt.colorSungStroke;
    ctx.lineWidth = Math.max(1, lw / 2);
    for (let k = 0; k < dots; k++) {
      let cx;
      let cy;
      if (dotsPos === 'left') {
        cx = left - fs * 0.35 - (dots - 1 - k) * fs * 0.38;
        cy = baseY - fs * 0.36;
      } else {
        cx = left + r + k * fs * 0.38;
        cy = baseY - fs * 1.1;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawIntro(tl, S) {
  if (!opt.showTitleIntro || !(opt.songTitle || opt.songArtist)) return;
  const first = state.lyrics[0];
  const endT = first ? first.start - PRE : 6;
  if (endT < 1.5 || tl >= endT) return;
  const alpha = clamp((endT - tl) / 0.8, 0, 1);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const draw = (text, size, y, fill) => {
    if (!text) return;
    ctx.font = lyricFont(size);
    const w = ctx.measureText(text).width;
    if (w > W * 0.86) ctx.font = lyricFont((size * W * 0.86) / w);
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = 14 * S;
    ctx.strokeStyle = opt.colorBaseStroke;
    ctx.lineWidth = opt.strokeWidth * 2 * S;
    if (ctx.lineWidth > 0) ctx.strokeText(text, W / 2, y);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = fill;
    ctx.fillText(text, W / 2, y);
  };
  draw(opt.songTitle, 104 * S, H * 0.44, opt.colorBase);
  draw(opt.songArtist, 56 * S, H * 0.44 + 100 * S, opt.colorSung);
  ctx.restore();
}

function drawLyricsLayer(t) {
  const L = state.lyrics;
  const S = Math.min(W, H) / 1080;
  const tl = t - (opt.lyricOffset || 0);

  if (opt.lyricShade && L.length) {
    const g = ctx.createLinearGradient(0, H * 0.5, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.5, W, H * 0.5);
  }

  drawIntro(tl, S);
  if (!L.length) return;

  let idx = -1;
  for (let i = 0; i < L.length; i++) {
    if (L[i].start <= tl) idx = i;
    else break;
  }

  const items = [];
  if (idx >= 0 && tl < L[idx].end) {
    items.push({ j: idx, active: true, dots: 0 });
    const nx = L[idx + 1];
    if (nx && nx.start - L[idx].end < PRE) items.push({ j: idx + 1, active: false, dots: 0 });
  } else {
    const n = idx + 1;
    const ln = L[n];
    if (ln && ln.start - tl < PRE) {
      const gapStart = n > 0 ? L[n - 1].end : 0;
      const remain = ln.start - tl;
      const dots = ln.start - gapStart >= 3 && remain <= 3 ? Math.ceil(remain) : 0;
      items.push({ j: n, active: false, dots });
      const n2 = L[n + 1];
      if (n2 && n2.start - ln.end < PRE) items.push({ j: n + 1, active: false, dots: 0 });
    }
  }
  if (!items.length) return;

  const fs = opt.fontSize * S;
  const bottom = H - (opt.marginBottom / 100) * H;

  if (opt.lyricLayout === 'center') {
    const [a, b] = items;
    const fs2 = fs * 0.68;
    const yA = b ? bottom - fs2 * 1.6 : bottom;
    drawKLine(L[a.j], W / 2, yA, 'center', fs, tl, a.active, 1, a.dots, 'top');
    if (b) drawKLine(L[b.j], W / 2, bottom, 'center', fs2, tl, false, 0.75, 0, 'top');
    return;
  }

  for (const it of items) {
    const slot = it.j % 2;
    if (slot === 0) drawKLine(L[it.j], W * 0.06, bottom - fs * 1.45, 'left', fs, tl, it.active, 1, it.dots, 'top');
    else drawKLine(L[it.j], W * 0.94, bottom, 'right', fs, tl, it.active, 1, it.dots, 'left');
  }
}

$$('.presets button[data-preset]').forEach((b) =>
  b.addEventListener('click', () => {
    const [c1, c2, c3, c4] = COLOR_PRESETS[b.dataset.preset];
    $('#colorBase').value = c1;
    $('#colorBaseStroke').value = c2;
    $('#colorSung').value = c3;
    $('#colorSungStroke').value = c4;
    readOpts();
  })
);

/* ---------------- 打點對時工具 ---------------- */

const tap = { lines: [], entries: [], k: 0, running: false };
const tapper = $('#tapper');

function lrcToPlain(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^(\[[^\]]*\])+/, '').replace(WORD_TAG, '').trim())
    .filter(Boolean)
    .join('\n');
}

function openTapper() {
  if (state.exporting) return;
  const cur = $('#lyricsInput').value;
  if (!$('#tapText').value.trim()) $('#tapText').value = lrcToPlain(cur);
  tap.running = false;
  tapper.classList.remove('hidden');
  updateTapView();
}

function closeTapper() {
  tap.running = false;
  $('#tapText').readOnly = false;
  tapper.classList.add('hidden');
  audio.pause();
}

function updateTapView() {
  const { lines, k } = tap;
  $('#tapPrev').textContent = lines[k - 1] || '';
  $('#tapCur').textContent = tap.running ? lines[k] || '（全部完成，可以按「套用」）' : '';
  $('#tapNext').textContent = tap.running ? lines[k + 1] || '' : '';
  $('#tapInfo').textContent = tap.running
    ? `進度 ${k} / ${lines.length} 句　·　目前 ${lrcTime(audio.currentTime).slice(1, -1)}`
    : '按「開始」後，音樂會從頭播放。';
}

async function tapStartRun() {
  if (!audio.src) { alert('請先選擇 MP3 音樂檔'); return; }
  tap.lines = $('#tapText').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!tap.lines.length) { alert('請先貼上歌詞'); return; }
  tap.entries = [];
  tap.k = 0;
  tap.running = true;
  $('#tapText').readOnly = true;
  document.activeElement && document.activeElement.blur();
  ensureAudioGraph();
  await actx.resume();
  audio.currentTime = 0;
  await audio.play();
  updateTapView();
}

function tapHit() {
  if (!tap.running || tap.k >= tap.lines.length) return;
  tap.entries.push({ t: audio.currentTime, text: tap.lines[tap.k] });
  tap.k++;
  updateTapView();
}

function tapGap() {
  if (!tap.running || !tap.entries.length) return;
  if (tap.entries[tap.entries.length - 1].text === '') return;
  tap.entries.push({ t: audio.currentTime, text: '' });
  updateTapView();
}

function tapUndo() {
  if (!tap.entries.length) return;
  const e = tap.entries.pop();
  if (e.text) tap.k--;
  audio.currentTime = Math.max(0, e.t - 3);
  updateTapView();
}

function buildLRC(entries) {
  const head = [];
  if (opt.songTitle) head.push(`[ti:${opt.songTitle}]`);
  if (opt.songArtist) head.push(`[ar:${opt.songArtist}]`);
  return head.concat(entries.map((e) => lrcTime(e.t) + e.text)).join('\n');
}

function applyTapResult(entries) {
  $('#lyricsInput').value = buildLRC(entries);
  updateLyrics();
  closeTapper();
}

function tapDone() {
  if (!tap.entries.length) { alert('還沒有打任何點'); return; }
  const left = tap.lines.length - tap.k;
  if (left > 0 && !confirm(`還有 ${left} 句沒有打點，這些句子會被略過。確定要套用嗎？`)) return;
  applyTapResult(tap.entries);
}

function tapEven() {
  const d = audioDur();
  if (!d) { alert('請先選擇 MP3 音樂檔'); return; }
  const lines = $('#tapText').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) { alert('請先貼上歌詞'); return; }
  const startAt = Math.min(10, d * 0.08);
  const step = (d - startAt - 3) / lines.length;
  applyTapResult(lines.map((text, i) => ({ t: startAt + i * step, text })));
}

$('#openTapper').addEventListener('click', openTapper);
$('#tapClose').addEventListener('click', closeTapper);
$('#tapStart').addEventListener('click', tapStartRun);
$('#tapHit').addEventListener('click', (e) => { e.currentTarget.blur(); tapHit(); });
$('#tapGap').addEventListener('click', (e) => { e.currentTarget.blur(); tapGap(); });
$('#tapUndo').addEventListener('click', (e) => { e.currentTarget.blur(); tapUndo(); });
$('#tapDone').addEventListener('click', tapDone);
$('#tapEven').addEventListener('click', tapEven);
audio.addEventListener('timeupdate', () => { if (!tapper.classList.contains('hidden')) updateTapView(); });

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.readOnly;
  if (!tapper.classList.contains('hidden')) {
    if (e.key === 'Escape') { closeTapper(); return; }
    if (!tap.running || typing) return;
    if (e.code === 'Space') { e.preventDefault(); tapHit(); }
    else if (e.code === 'KeyX') { e.preventDefault(); tapGap(); }
    else if (e.code === 'KeyZ') { e.preventDefault(); tapUndo(); }
    return;
  }
  if (typing) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
});

/* ---------------- 輸出 ---------------- */

let recorder = null;
let recChunks = [];
let exportCancelled = false;
let ticker = null;
let downloadURL = null;

function pickMime() {
  if (!window.MediaRecorder) return null;
  for (const m of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return '';
}

// 用 Worker 計時，切到背景分頁時也比較不會被瀏覽器降速
function startTicker() {
  const interval = 1000 / opt.fps;
  try {
    const code = 'let id;onmessage=e=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data);};';
    const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    w.onmessage = frame;
    w.postMessage(interval);
    ticker = { stop: () => w.terminate() };
  } catch {
    const id = setInterval(frame, interval);
    ticker = { stop: () => clearInterval(id) };
  }
}

function stopTicker() {
  if (ticker) ticker.stop();
  ticker = null;
}

function setExportUI(on) {
  $('#exportBtn').disabled = on;
  $('#cancelBtn').classList.toggle('hidden', !on);
  $('#playBtn').disabled = on;
  $('#seek').disabled = on;
  $('#resolution').disabled = on;
  $('#fps').disabled = on;
  $('#bitrate').disabled = on;
  if (on) $('#downloadLink').classList.add('hidden');
}

function waitSeek(el, time) {
  return new Promise((resolve) => {
    const done = () => { el.removeEventListener('seeked', done); resolve(); };
    el.addEventListener('seeked', done);
    el.currentTime = time;
    setTimeout(done, 1500);
  });
}

async function startExport() {
  if (!audio.src || !audioDur()) { alert('請先選擇 MP3 音樂檔'); return; }
  if (!canvas.captureStream || !window.MediaRecorder) {
    alert('這個瀏覽器不支援錄製影片，請改用最新版 Chrome、Edge 或 Safari。');
    return;
  }
  const mime = pickMime();
  ensureAudioGraph();
  await actx.resume();
  audio.pause();
  await waitSeek(audio, 0);
  if (state.bgMode === 'video' && bgVideo.src) await waitSeek(bgVideo, 0);

  state.exporting = true;
  setExportUI(true);
  monitorGain.gain.value = opt.muteMonitor ? 0 : 1;
  render();

  const vStream = canvas.captureStream(opt.fps);
  const stream = new MediaStream([...vStream.getVideoTracks(), ...recDest.stream.getAudioTracks()]);
  const options = { videoBitsPerSecond: opt.bitrate * 1e6, audioBitsPerSecond: 192000 };
  if (mime) options.mimeType = mime;
  try {
    recorder = new MediaRecorder(stream, options);
  } catch (err) {
    console.error(err);
    alert('無法啟動錄製：' + err.message);
    state.exporting = false;
    setExportUI(false);
    return;
  }
  recChunks = [];
  exportCancelled = false;
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => finishExport(mime, vStream);
  recorder.start(1000);
  startTicker();
  $('#exportStatus').textContent = '輸出中…';
  try {
    await audio.play();
  } catch (err) {
    exportCancelled = true;
    recorder.stop();
    alert('無法播放音樂：' + err.message);
  }
}

function finishExport(mime, vStream) {
  stopTicker();
  vStream.getTracks().forEach((t) => t.stop());
  state.exporting = false;
  setExportUI(false);
  if (monitorGain) monitorGain.gain.value = 1;
  audio.pause();

  if (exportCancelled) {
    $('#exportStatus').textContent = '已取消輸出。';
    $('#progressBar').style.width = '0';
    return;
  }
  const type = ((recorder && recorder.mimeType) || mime || 'video/webm').split(';')[0];
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(recChunks, { type });
  if (downloadURL) URL.revokeObjectURL(downloadURL);
  downloadURL = URL.createObjectURL(blob);
  const link = $('#downloadLink');
  link.href = downloadURL;
  link.download = `${opt.songTitle || state.audioName}.${ext}`;
  link.textContent = `⬇ 下載影片（${ext.toUpperCase()}，${(blob.size / 1048576).toFixed(1)} MB）`;
  link.classList.remove('hidden');
  $('#progressBar').style.width = '100%';
  $('#exportStatus').textContent =
    ext === 'mp4' ? '✅ 完成！' : '✅ 完成！（此瀏覽器只能輸出 WebM，若需要 MP4 請改用最新版 Chrome 或 Safari）';
  link.click();
}

function cancelExport() {
  if (!state.exporting || !recorder) return;
  exportCancelled = true;
  audio.pause();
  if (recorder.state !== 'inactive') recorder.stop();
}

$('#exportBtn').addEventListener('click', startExport);
$('#cancelBtn').addEventListener('click', cancelExport);

document.addEventListener('visibilitychange', () => {
  if (state.exporting && document.hidden) {
    $('#exportStatus').textContent = '⚠️ 偵測到切換分頁，影片可能會卡頓，請回到這個分頁直到輸出完成。';
  }
});

/* ---------------- 主迴圈 ---------------- */

function frame() {
  syncVideo(false);
  render();
  updatePlayerUI();
  if (state.exporting) {
    const d = audioDur();
    const t = audio.currentTime;
    $('#progressBar').style.width = `${d ? (t / d) * 100 : 0}%`;
    if (!document.hidden) $('#exportStatus').textContent = `輸出中… ${fmt(t)} / ${fmt(d)}（需要即時播放完整首歌）`;
  }
}

function rafLoop() {
  if (!state.exporting) frame();
  requestAnimationFrame(rafLoop);
}

/* ---------------- 初始化 ---------------- */

setupDrop($('#audioDrop'), $('#audioInput'), loadAudio);
setupDrop($('#imageDrop'), $('#imageInput'), addImages);
setupDrop($('#videoDrop'), $('#videoInput'), loadVideo);

readOpts();
setResolution();
bgVideo.loop = opt.videoLoop;

(function showFormatBadge() {
  const badge = $('#formatBadge');
  const mime = pickMime();
  if (mime === null || !canvas.captureStream) {
    badge.textContent = '⚠️ 此瀏覽器無法錄製影片';
    badge.classList.add('warn');
  } else if (mime.startsWith('video/mp4')) {
    badge.textContent = '✅ 可直接輸出 MP4';
    badge.classList.add('ok');
  } else {
    badge.textContent = '⚠️ 此瀏覽器只能輸出 WebM（建議用最新版 Chrome / Safari）';
    badge.classList.add('warn');
  }
})();

function receiveLrcHandoff(raw) {
  if (!raw) return;
  localStorage.removeItem('ktv-lrc-handoff');
  try {
    const d = JSON.parse(raw);
    if (state.exporting || !d.lrc) return;
    $('#lyricsInput').value = d.lrc;
    if (d.title) $('#songTitle').value = d.title;
    if (d.artist) $('#songArtist').value = d.artist;
    updateLyrics();
    $('#lyricsInput').scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {}
}
receiveLrcHandoff(localStorage.getItem('ktv-lrc-handoff'));
window.addEventListener('storage', (e) => {
  if (e.key === 'ktv-lrc-handoff') receiveLrcHandoff(e.newValue);
});

requestAnimationFrame(rafLoop);
