import { pipeline, env, WhisperTextStreamer } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

let asr = null;
let loadedKey = '';

const post = (msg) => self.postMessage(msg);

async function getASR(model, device) {
  const key = `${model}|${device}`;
  if (asr && loadedKey === key) return asr;
  asr = null;
  const files = {};
  asr = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.file) {
        files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
        const all = Object.values(files);
        const loaded = all.reduce((a, f) => a + f.loaded, 0);
        const total = all.reduce((a, f) => a + f.total, 0);
        post({ type: 'download', loaded, total });
      }
    },
  });
  loadedKey = key;
  return asr;
}

self.onmessage = async (e) => {
  const { audio, model, language, device } = e.data;
  try {
    post({ type: 'status', msg: '正在載入辨識模型（第一次需要下載，之後會快很多）…' });
    let dev = device;
    let p;
    try {
      p = await getASR(model, dev);
    } catch (err) {
      if (dev !== 'webgpu') throw err;
      dev = 'wasm';
      post({ type: 'status', msg: '此電腦無法使用 GPU 加速，改用 CPU 載入模型…' });
      p = await getASR(model, dev);
    }

    post({ type: 'status', msg: `辨識中（${dev === 'webgpu' ? 'GPU 加速' : 'CPU'}），歌曲越長需要越久…` });
    const opts = {
      task: 'transcribe',
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    };
    if (language) opts.language = language;
    if (WhisperTextStreamer) {
      try {
        opts.streamer = new WhisperTextStreamer(p.tokenizer, {
          skip_prompt: true,
          callback_function: (text) => post({ type: 'partial', text }),
        });
      } catch {}
    }
    const out = await p(audio, opts);
    post({ type: 'done', chunks: out.chunks || [{ text: out.text, timestamp: [0, null] }], device: dev });
  } catch (err) {
    post({ type: 'error', msg: String((err && err.message) || err) });
  }
};
