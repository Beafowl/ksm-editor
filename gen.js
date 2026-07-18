"use strict";
/* ============================================================
 * Chart generation: runs the trained ChartGPT model (ONNX) in the
 * browser. Mirrors sdvx_model/tokenizer.py — the vocab construction
 * MUST stay in sync with the Python side.
 *
 * The model file (chartgen.onnx) is user-supplied via a file picker
 * and cached in IndexedDB. The ORT runtime is vendored (vendor/) with
 * its wasm embedded so everything works from file:// URLs.
 * ============================================================ */

const GEN = (() => {

/* ---------------------- tokenizer mirror ---------------------- */

const RADAR_AXES = ["notes", "peak", "tsumami", "tricky", "hand-trip", "one-hand"];
const RADAR_BUCKETS = 11, BPM_BUCKETS = 64;
const DELTAS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 36, 48, 96];
const MEASURE = 192, GRID = 12;

function buildVocab() {
  const v = ["<pad>", "<bos>", "<eos>", "<uncond>"];
  for (let i = 1; i <= 20; i++) v.push("lv_" + i);
  for (const ax of RADAR_AXES) for (let b = 0; b < RADAR_BUCKETS; b++) v.push(ax + "_" + b);
  for (let i = 0; i < BPM_BUCKETS; i++) v.push("bpm_" + i);
  v.push("bar");
  for (const n of DELTAS) v.push("d_" + n);
  for (let l = 0; l < 4; l++) v.push("bt_chip_" + l, "bt_on_" + l, "bt_off_" + l);
  for (let s = 0; s < 2; s++) v.push("fx_chip_" + s, "fx_on_" + s, "fx_off_" + s);
  for (let s = 0; s < 2; s++) {
    v.push("la_on_" + s, "la_wide_" + s, "la_off_" + s);
    for (let i = 0; i <= 50; i++) v.push("la_v_" + s + "_" + i);
  }
  v.push("bpmch");
  return v;
}
const VOCAB = buildVocab();
const TID = Object.fromEntries(VOCAB.map((n, i) => [n, i]));
const PAD = TID["<pad>"], BOS = TID["<bos>"], EOS = TID["<eos>"], UNCOND = TID["<uncond>"];
const PREFIX_LEN = 9;

// defaults for runs/audio/best.pt; overridden by chartgen.onnx.json if picked
let MC = { n_layer: 8, n_head: 6, head_dim: 64, audio_dim: 16, ctx: 2048 };

const radarBucket = v => Math.max(0, Math.min(10, Math.round(v / 200 * 10)));
function bpmBucket(bpm) {
  bpm = Math.max(50, Math.min(400, bpm || 120));
  const x = (Math.log2(bpm) - Math.log2(50)) / (Math.log2(400) - Math.log2(50));
  return Math.max(0, Math.min(BPM_BUCKETS - 1, Math.round(x * (BPM_BUCKETS - 1))));
}
function condTokens(level, radar, bpm) {
  const lv = Math.max(1, Math.min(20, Math.round(level) || 1));
  const out = [TID["lv_" + lv]];
  for (const ax of RADAR_AXES) out.push(TID[ax + "_" + radarBucket(radar[ax])]);
  out.push(TID["bpm_" + bpmBucket(bpm)]);
  return out;
}

// token ids -> editor chart model (mirrors tokenizer.decode_body)
function decodeBody(tokens, bpm) {
  const chart = KSH.newChart();
  chart.bpms = [{ y: 0, v: bpm }];
  const btOpen = [null, null, null, null], fxOpen = [null, null], laOpen = [null, null];
  let pos = 0, pendingBpm = false;
  for (const t of tokens) {
    const name = VOCAB[t] || "<pad>";
    if (pendingBpm) {
      pendingBpm = false;
      if (name.startsWith("bpm_")) {
        const x = parseInt(name.slice(4)) / (BPM_BUCKETS - 1);
        const v = Math.round(2 ** (Math.log2(50) + x * (Math.log2(400) - Math.log2(50))) * 100) / 100;
        chart.bpms.push({ y: pos, v });
        continue;
      }
    }
    if (name === "bar") pos = (Math.floor(pos / MEASURE) + 1) * MEASURE;
    else if (name.startsWith("d_")) pos += parseInt(name.slice(2));
    else if (name === "bpmch") pendingBpm = true;
    else if (name.startsWith("bt_chip_")) chart.bt[+name.slice(-1)].push({ y: pos, l: 0 });
    else if (name.startsWith("bt_on_")) {
      const l = +name.slice(-1);
      if (!btOpen[l]) { btOpen[l] = { y: pos, l: 0 }; chart.bt[l].push(btOpen[l]); }
    } else if (name.startsWith("bt_off_")) {
      const l = +name.slice(-1);
      if (btOpen[l]) { btOpen[l].l = Math.max(0, pos - btOpen[l].y); btOpen[l] = null; }
    } else if (name.startsWith("fx_chip_")) chart.fx[+name.slice(-1)].push({ y: pos, l: 0, fx: "" });
    else if (name.startsWith("fx_on_")) {
      const s = +name.slice(-1);
      if (!fxOpen[s]) { fxOpen[s] = { y: pos, l: 0, fx: "" }; chart.fx[s].push(fxOpen[s]); }
    } else if (name.startsWith("fx_off_")) {
      const s = +name.slice(-1);
      if (fxOpen[s]) { fxOpen[s].l = Math.max(0, pos - fxOpen[s].y); fxOpen[s] = null; }
    } else if (name.startsWith("la_on_")) {
      laOpen[+name.slice(-1)] = { points: [], wide: 1 };
    } else if (name.startsWith("la_wide_")) {
      const s = +name.slice(-1);
      if (laOpen[s]) laOpen[s].wide = 2;
    } else if (name.startsWith("la_v_")) {
      const parts = name.split("_");
      const s = +parts[2], v = +parts[3] / 50;
      if (!laOpen[s]) laOpen[s] = { points: [], wide: 1 };
      const pts = laOpen[s].points;
      if (pts.length && pts[pts.length - 1].y === pos) pts[pts.length - 1].v = v;
      else pts.push({ y: pos, v });
    } else if (name.startsWith("la_off_")) {
      const s = +name.slice(-1);
      if (laOpen[s]) {
        if (laOpen[s].points.length >= 2) chart.lasers[s].push(laOpen[s]);
        laOpen[s] = null;
      }
    }
  }
  for (let l = 0; l < 4; l++) if (btOpen[l]) btOpen[l].l = Math.max(0, pos - btOpen[l].y);
  for (let s = 0; s < 2; s++) {
    if (fxOpen[s]) fxOpen[s].l = Math.max(0, pos - fxOpen[s].y);
    if (laOpen[s] && laOpen[s].points.length >= 2) chart.lasers[s].push(laOpen[s]);
  }
  return chart;
}

/* -------------------- onsets from loaded audio -------------------- */

const N_FFT = 1024, HOP = 512;
const _twiddle = (() => {
  const re = new Float32Array(N_FFT / 2), im = new Float32Array(N_FFT / 2);
  for (let i = 0; i < N_FFT / 2; i++) {
    re[i] = Math.cos(-2 * Math.PI * i / N_FFT);
    im[i] = Math.sin(-2 * Math.PI * i / N_FFT);
  }
  return { re, im };
})();

function fft1024(re, im) { // in-place iterative radix-2
  for (let i = 1, j = 0; i < N_FFT; i++) { // bit reversal
    let bit = N_FFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N_FFT; len <<= 1) {
    const step = N_FFT / len;
    for (let i = 0; i < N_FFT; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const tr = _twiddle.re[k * step], ti = _twiddle.im[k * step];
        const a = i + k, b = i + k + len / 2;
        const xr = re[b] * tr - im[b] * ti, xi = re[b] * ti + im[b] * tr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

const _hann = (() => {
  const w = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N_FFT - 1));
  return w;
})();

// AudioBuffer -> spectral-flux envelope (mirrors sdvx_dataset/onsets.py)
function onsetEnvelope(buffer) {
  const n = buffer.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i];
  }
  const nc = Math.min(2, buffer.numberOfChannels);
  if (nc > 1) for (let i = 0; i < n; i++) mono[i] /= nc;
  const frames = Math.max(1, 1 + Math.floor((n - N_FFT) / HOP));
  const flux = new Float32Array(frames);
  const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT);
  let prev = null;
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = (mono[off + i] || 0) * _hann[i];
      im[i] = 0;
    }
    fft1024(re, im);
    const mag = new Float32Array(N_FFT / 2 + 1);
    for (let i = 0; i <= N_FFT / 2; i++)
      mag[i] = Math.log1p(Math.hypot(re[i], im[i]));
    if (prev) {
      let s = 0;
      for (let i = 0; i < mag.length; i++) {
        const d = mag[i] - prev[i];
        if (d > 0) s += d;
      }
      flux[f] = s;
    }
    prev = mag;
  }
  const sorted = Array.from(flux).sort((a, b) => a - b);
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))];
  if (ref > 0) for (let i = 0; i < frames; i++) flux[i] = Math.min(1, flux[i] / ref);
  return { env: flux, fps: buffer.sampleRate / HOP };
}

// constant-bpm 1/16 grid, max over +-1 frame (mirrors grid_onsets)
function gridOnsets(envelope, bpm, offsetMs, nCells) {
  const { env, fps } = envelope;
  const out = new Float32Array(nCells + MC.audio_dim);
  for (let c = 0; c < nCells; c++) {
    const idx = Math.round((offsetMs + c * 15000 / bpm) / 1000 * fps);
    let m = 0;
    for (let k = Math.max(0, idx - 1); k <= Math.min(env.length - 1, idx + 1); k++)
      m = Math.max(m, env[k]);
    out[c] = m;
  }
  return out;
}

/* ------------------------- ORT session ------------------------- */

let ortReady = null;
function loadOrt() {
  if (ortReady) return ortReady;
  ortReady = new Promise((resolve, reject) => {
    const s1 = document.createElement("script");
    s1.src = "vendor/ort.all.min.js";
    s1.onload = () => {
      const s2 = document.createElement("script");
      s2.src = "vendor/ort-embed.js";
      s2.onload = () => {
        const toBlob = (b64, type) => {
          const bin = atob(b64);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return URL.createObjectURL(new Blob([u8], { type }));
        };
        ort.env.wasm.numThreads = 1; // file:// has no cross-origin isolation
        ort.env.wasm.wasmPaths = {
          mjs: toBlob(ORT_MJS_B64, "text/javascript"),
          wasm: toBlob(ORT_WASM_B64, "application/wasm"),
        };
        resolve();
      };
      s2.onerror = () => reject(new Error("vendor/ort-embed.js missing"));
      document.head.appendChild(s2);
    };
    s1.onerror = () => reject(new Error("vendor/ort.all.min.js missing"));
    document.head.appendChild(s1);
  });
  return ortReady;
}

const IDB = {
  open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open("ksmgen", 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore("files");
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const rq = db.transaction("files").objectStore("files").get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  },
  async put(key, val) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const rq = db.transaction("files", "readwrite").objectStore("files").put(val, key);
      rq.onsuccess = () => res();
      rq.onerror = () => rej(rq.error);
    });
  },
};

let session = null, sessionEp = "";
async function ensureSession(modelBytes) {
  if (session) return session;
  await loadOrt();
  for (const eps of [["webgpu"], ["wasm"]]) {
    try {
      session = await ort.InferenceSession.create(modelBytes, { executionProviders: eps });
      sessionEp = eps[0];
      return session;
    } catch (e) { /* try next provider */ }
  }
  throw new Error("could not create ONNX session");
}

/* ------------------------ generation loop ------------------------ */

function sampleTopP(logits, temperature, topP) {
  const V = logits.length;
  let mx = -Infinity;
  for (let i = 0; i < V; i++) mx = Math.max(mx, logits[i]);
  const probs = new Float64Array(V);
  let sum = 0;
  for (let i = 0; i < V; i++) { probs[i] = Math.exp((logits[i] - mx) / Math.max(1e-6, temperature)); sum += probs[i]; }
  const idx = Array.from({ length: V }, (_, i) => i).sort((a, b) => probs[b] - probs[a]);
  let cum = 0, cut = V;
  for (let r = 0; r < V; r++) {
    cum += probs[idx[r]] / sum;
    if (cum >= topP) { cut = r + 1; break; }
  }
  let z = 0;
  for (let r = 0; r < cut; r++) z += probs[idx[r]];
  let u = Math.random() * z;
  for (let r = 0; r < cut; r++) {
    u -= probs[idx[r]];
    if (u <= 0) return idx[r];
  }
  return idx[cut - 1];
}

async function generate(opts, onProgress) {
  const { level, radar, bpm, measures, guidance, onsets } = opts;
  const B = 2, NL = MC.n_layer, NH = MC.n_head, HD = MC.head_dim, A = MC.audio_dim;
  const cond = [BOS, ...condTokens(level, radar, bpm)];
  const uncond = [BOS, cond[1], UNCOND, UNCOND, UNCOND, UNCOND, UNCOND, UNCOND, cond[8]];
  const window_ = pos => {
    const w = new Float32Array(A);
    if (onsets) {
      const c = Math.min(Math.floor(pos / GRID), onsets.length - A - 1);
      for (let i = 0; i < A; i++) w[i] = onsets[c + i];
    }
    return w;
  };

  const t64 = a => new ort.Tensor("int64", BigInt64Array.from(a.map(BigInt)), [B, a.length / B]);
  let past = [];
  for (let i = 0; i < 2 * NL; i++)
    past.push(new ort.Tensor("float32", new Float32Array(0), [B, NH, 0, HD]));

  const feeds = out => {
    for (let i = 0; i < NL; i++) {
      past[2 * i] = out["pres_k_" + i];
      past[2 * i + 1] = out["pres_v_" + i];
    }
  };
  const runStep = async (ids, audioF, mask, S, P) => {
    const f = {
      idx: t64(ids),
      audio: new ort.Tensor("float32", audioF, [B, S, A]),
      mask: new ort.Tensor("float32", mask, [B, 1, S, P + S]),
    };
    for (let i = 0; i < NL; i++) {
      f["past_k_" + i] = past[2 * i];
      f["past_v_" + i] = past[2 * i + 1];
    }
    return session.run(f);
  };

  // prefill (S = PREFIX_LEN, causal mask)
  const S0 = PREFIX_LEN;
  const preMask = new Float32Array(B * S0 * S0);
  for (let b = 0; b < B; b++)
    for (let i = 0; i < S0; i++)
      for (let j = 0; j < S0; j++)
        preMask[(b * S0 + i) * S0 + j] = j <= i ? 0 : -1e9;
  const preAudio = new Float32Array(B * S0 * A);
  const w0 = window_(0);
  for (let b = 0; b < B; b++)
    for (let i = 0; i < S0; i++) preAudio.set(w0, (b * S0 + i) * A);
  let out = await runStep([...cond, ...uncond], preAudio, preMask, S0, 0);
  feeds(out);

  const body = [];
  let pos = 0, P = S0;
  const V = VOCAB.length;
  const maxTok = Math.min(opts.maxTokens || 6000, MC.ctx - S0 - 1);
  while (body.length < maxTok && pos < measures * MEASURE) {
    const lg = out.logits.data;
    const off0 = (0 * out.logits.dims[1] + (out.logits.dims[1] - 1)) * V;
    const off1 = (1 * out.logits.dims[1] + (out.logits.dims[1] - 1)) * V;
    const mixed = new Float32Array(V);
    for (let i = 0; i < V; i++)
      mixed[i] = lg[off1 + i] + guidance * (lg[off0 + i] - lg[off1 + i]);
    const t = sampleTopP(mixed, 0.95, 0.95);
    if (t === EOS) break;
    if (t !== PAD && t !== BOS) {
      body.push(t);
      const name = VOCAB[t];
      if (name === "bar") pos = (Math.floor(pos / MEASURE) + 1) * MEASURE;
      else if (name.startsWith("d_")) pos += parseInt(name.slice(2));
    }
    if (opts.cancelled && opts.cancelled()) return null;
    if (onProgress && body.length % 25 === 0)
      onProgress(body.length, Math.floor(pos / MEASURE), measures);
    const w = window_(pos);
    const stepAudio = new Float32Array(B * A);
    stepAudio.set(w, 0); stepAudio.set(w, A);
    out = await runStep([t, t], stepAudio, new Float32Array(B * (P + 1)), 1, P);
    feeds(out);
    P += 1;
  }
  return body;
}

/* --------------------------- dialog --------------------------- */

let modelBytes = null;

async function open() {
  const d = ED.dom;
  d.genModal.showModal();
  d.genBpm.value = KSH.fmtNum(ED.chart.bpms[0].v);
  const hasAudio = !!AudioEng.buffer;
  d.chkGenAudio.disabled = !hasAudio;
  d.chkGenAudio.checked = hasAudio;
  updateStatus("");
  if (!modelBytes) {
    const cached = await IDB.get("model").catch(() => null);
    if (cached) {
      modelBytes = cached.bytes;
      if (cached.meta) MC = Object.assign(MC, cached.meta);
      updateStatus(`model loaded from cache (${(modelBytes.byteLength / 1e6).toFixed(0)} MB)`);
    } else {
      updateStatus("no model loaded — pick chartgen.onnx (and its .json) below");
    }
  } else {
    updateStatus(`model ready (${(modelBytes.byteLength / 1e6).toFixed(0)} MB)`);
  }
}

function updateStatus(msg) { ED.dom.genStatus.textContent = msg; }

async function pickModel(files) {
  let bytes = null, meta = null;
  for (const f of files) {
    if (f.name.endsWith(".onnx")) bytes = await f.arrayBuffer();
    else if (f.name.endsWith(".json")) {
      const j = JSON.parse(await f.text());
      meta = {
        n_layer: j.n_layer, n_head: j.n_head, head_dim: j.head_dim,
        audio_dim: j.model_cfg.audio_dim, ctx: j.model_cfg.ctx,
      };
    }
  }
  if (!bytes) { updateStatus("that was not a .onnx file"); return; }
  modelBytes = bytes;
  if (meta) MC = Object.assign(MC, meta);
  session = null;
  await IDB.put("model", { bytes, meta }).catch(() => {});
  updateStatus(`model ready (${(bytes.byteLength / 1e6).toFixed(0)} MB) — cached for next time`);
}

let running = false, cancelFlag = false;

async function go() {
  const d = ED.dom;
  if (running) return;
  if (!modelBytes) { updateStatus("load a model file first"); return; }
  if (ED.dirty && !confirm("Discard unsaved changes and generate a new chart?")) return;
  running = true;
  cancelFlag = false;
  d.btnGenGo.disabled = true;
  try {
    updateStatus("starting ONNX session ...");
    await ensureSession(modelBytes);
    updateStatus(`session ready (${sessionEp}) — generating ...`);
    const bpm = parseFloat(d.genBpm.value) || 170;
    const measures = Math.max(4, Math.min(128, parseInt(d.genMeasures.value) || 48));
    const radar = {};
    for (const ax of RADAR_AXES)
      radar[ax] = Math.round(parseFloat(d["genS_" + ax].value) * 200);
    let onsets = null, offsetMs = 0;
    if (d.chkGenAudio.checked && AudioEng.buffer) {
      updateStatus("analyzing audio ...");
      offsetMs = Math.max(0, Math.round(parseFloat(ED.chart.meta.o) || 0));
      const env = onsetEnvelope(AudioEng.buffer);
      onsets = gridOnsets(env, bpm, offsetMs, measures * MEASURE / GRID + 1);
    }
    const t0 = performance.now();
    const body = await generate({
      level: parseInt(d.genLevel.value) || 15,
      radar, bpm, measures,
      guidance: parseFloat(d.genGuidance.value) || 2,
      onsets,
      cancelled: () => cancelFlag,
    }, (tok, m, total) => updateStatus(`generating ... ${tok} tokens, measure ${m}/${total}`));
    if (body === null) { updateStatus("cancelled"); return; }
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    const chart = decodeBody(body, bpm);
    const m = chart.meta;
    m.title = "Generated lv" + d.genLevel.value;
    m.artist = "ChartGPT";
    m.effect = "ChartGPT";
    m.difficulty = "infinite";
    m.level = String(parseInt(d.genLevel.value) || 15);
    if (d.chkGenAudio.checked && AudioEng.buffer) {
      m.m = ED.chart.meta.m; // keep the loaded song hooked up
      m.o = String(offsetMs);
    }
    setChart(chart);
    ED.kshHandle = null;
    ED.kshName = "";
    ED.dirty = true;
    updateTitle();
    d.genModal.close();
    toast(`Generated ${sumNotes(chart)} notes in ${secs}s (${sessionEp}) — review and save`);
  } catch (e) {
    updateStatus("failed: " + e.message);
  } finally {
    running = false;
    d.btnGenGo.disabled = false;
  }
}

function sumNotes(chart) {
  return chart.bt.reduce((a, l) => a + l.length, 0) + chart.fx.reduce((a, s) => a + s.length, 0);
}

function init() {
  const d = ED.dom;
  d.btnGenerate.addEventListener("click", open);
  d.genModal.addEventListener("close", () => { cancelFlag = true; });
  d.btnGenClose.addEventListener("click", () => { cancelFlag = true; d.genModal.close(); });
  d.btnGenGo.addEventListener("click", go);
  d.genModelFile.addEventListener("change", () => pickModel([...d.genModelFile.files]));
  for (const ax of RADAR_AXES) {
    const slider = d["genS_" + ax];
    slider.addEventListener("input", () => {
      d["genV_" + ax].textContent = parseFloat(slider.value).toFixed(2);
    });
  }
}

return { init };
})();
