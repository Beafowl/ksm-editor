"use strict";
/* ============================================================
 * ChartGPT: in-browser chart generation with the trained model.
 * Mirrors sdvx_model/tokenizer.py — vocab construction MUST stay
 * in sync with the Python side.
 *
 * Model loading order: model/chartgen-model.js (embedded, if present)
 * -> IndexedDB cache -> file picker. The ORT runtime is vendored
 * (vendor/) with its wasm embedded so file:// works.
 * ============================================================ */

const GEN = (() => {

/* ---------------------- tokenizer mirror ---------------------- */

const RADAR_AXES = ["notes", "peak", "tsumami", "tricky", "hand-trip", "one-hand"];
const RADAR_BUCKETS = 11, BPM_BUCKETS = 64;
const DELTAS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 36, 48, 96];
const MEASURE = 192, GRID = 12, WINDOW = 16;

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

// model config; overridden by the embedded/picked model's metadata
let MC = { n_layer: 8, n_head: 6, head_dim: 64, audio_dim: 16, ctx: 2048 };
const featsPerCell = () => Math.max(1, Math.floor(MC.audio_dim / WINDOW));

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

/* -------- encode the current chart (context for range infill) -------- */

function encodeBody(chart) {
  const ev = []; // [tick, priority, tokens[]]
  for (let i = 1; i < chart.bpms.length; i++)
    ev.push([chart.bpms[i].y, 0, [TID.bpmch, TID["bpm_" + bpmBucket(chart.bpms[i].v)]]]);
  chart.bt.forEach((lane, l) => {
    for (const n of lane) {
      if (n.l > 0) {
        ev.push([n.y, 2, [TID["bt_on_" + l]]]);
        ev.push([n.y + n.l, 1, [TID["bt_off_" + l]]]);
      } else ev.push([n.y, 3, [TID["bt_chip_" + l]]]);
    }
  });
  chart.fx.forEach((side, s) => {
    for (const n of side) {
      if (n.l > 0) {
        ev.push([n.y, 2, [TID["fx_on_" + s]]]);
        ev.push([n.y + n.l, 1, [TID["fx_off_" + s]]]);
      } else ev.push([n.y, 3, [TID["fx_chip_" + s]]]);
    }
  });
  chart.lasers.forEach((side, s) => {
    for (const seg of side) {
      const start = [TID["la_on_" + s]];
      if (seg.wide === 2) start.push(TID["la_wide_" + s]);
      ev.push([seg.points[0].y, 4, start]);
      for (const p of seg.points)
        ev.push([p.y, 5, [TID["la_v_" + s + "_" + Math.max(0, Math.min(50, Math.round(p.v * 50)))]]]);
      ev.push([seg.points[seg.points.length - 1].y, 6, [TID["la_off_" + s]]]);
    }
  });
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const tokens = [], ticks = [];
  let pos = 0;
  for (const [tick, , toks] of ev) {
    while (pos < tick) {
      const nb = (Math.floor(pos / MEASURE) + 1) * MEASURE;
      if (tick >= nb) { pos = nb; tokens.push(TID.bar); }
      else {
        let d = DELTAS[0];
        for (const n of DELTAS) if (n <= tick - pos) d = n;
        pos += d;
        tokens.push(TID["d_" + d]);
      }
      ticks.push(pos);
    }
    for (const t of toks) { tokens.push(t); ticks.push(pos); }
  }
  return { tokens, ticks };
}

/* -------- decode generated tokens -> editor chart objects -------- */

function decodeBody(tokens, bpm, startPos = 0) {
  const chart = KSH.newChart();
  chart.bpms = [{ y: 0, v: bpm }];
  const btOpen = [null, null, null, null], fxOpen = [null, null], laOpen = [null, null];
  let pos = startPos, pendingBpm = false;
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

/* -------------------- audio features (v1 + v2) -------------------- */

const N_FFT = 1024, HOP = 512;
const _tw = (() => {
  const re = new Float32Array(N_FFT / 2), im = new Float32Array(N_FFT / 2);
  for (let i = 0; i < N_FFT / 2; i++) {
    re[i] = Math.cos(-2 * Math.PI * i / N_FFT);
    im[i] = Math.sin(-2 * Math.PI * i / N_FFT);
  }
  return { re, im };
})();

function fft1024(re, im) {
  for (let i = 1, j = 0; i < N_FFT; i++) {
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
        const tr = _tw.re[k * step], ti = _tw.im[k * step];
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

// AudioBuffer -> per-frame features (mirrors sdvx_dataset/onsets.py):
// bands[3] = clipped log-spectral-flux per band, rms = log loudness, total =
// broadband flux (the v1 scalar the first model generation was trained on)
function analyzeAudio(buffer) {
  const n = buffer.length, sr = buffer.sampleRate;
  const mono = new Float32Array(n);
  const nc = Math.min(2, buffer.numberOfChannels);
  for (let c = 0; c < nc; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i];
  }
  if (nc > 1) for (let i = 0; i < n; i++) mono[i] /= nc;
  const frames = Math.max(1, 1 + Math.floor((n - N_FFT) / HOP));
  const b1 = Math.ceil(200 * N_FFT / sr), b2 = Math.ceil(2000 * N_FFT / sr);
  const feats = [new Float32Array(frames), new Float32Array(frames),
                 new Float32Array(frames), new Float32Array(frames)];
  const total = new Float32Array(frames);
  const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT);
  let prev = null;
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let energy = 0;
    for (let i = 0; i < N_FFT; i++) {
      const s = mono[off + i] || 0;
      energy += s * s;
      re[i] = s * _hann[i];
      im[i] = 0;
    }
    feats[3][f] = Math.log1p(Math.sqrt(energy / N_FFT) * 20);
    fft1024(re, im);
    const mag = new Float32Array(N_FFT / 2 + 1);
    for (let i = 0; i <= N_FFT / 2; i++) mag[i] = Math.log1p(Math.hypot(re[i], im[i]));
    if (prev) {
      let s0 = 0, s1 = 0, s2 = 0;
      for (let i = 0; i <= N_FFT / 2; i++) {
        const d = mag[i] - prev[i];
        if (d > 0) { if (i < b1) s0 += d; else if (i < b2) s1 += d; else s2 += d; }
      }
      feats[0][f] = s0; feats[1][f] = s1; feats[2][f] = s2;
      total[f] = s0 + s1 + s2;
    }
    prev = mag;
  }
  const p98 = a => {
    const s = Array.from(a).sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.98))];
  };
  for (const a of [...feats, total]) {
    const ref = p98(a);
    if (ref > 0) for (let i = 0; i < a.length; i++) a[i] = Math.min(1, a[i] / ref);
  }
  return { feats, total, fps: sr / HOP };
}

// -> Float32Array (nCells + WINDOW) * F, layout [cell][feature]
function gridFeatures(analysis, bpm, offsetMs, nCells) {
  const F = featsPerCell();
  const src = F === 1 ? [analysis.total] : analysis.feats.slice(0, F);
  const out = new Float32Array((nCells + WINDOW) * F);
  const nFrames = src[0].length;
  for (let c = 0; c < nCells; c++) {
    const idx = Math.round((offsetMs + c * 15000 / bpm) / 1000 * analysis.fps);
    for (let f = 0; f < F; f++) {
      let m = 0;
      for (let k = Math.max(0, idx - 1); k <= Math.min(nFrames - 1, idx + 1); k++)
        m = Math.max(m, src[f][k]);
      out[c * F + f] = m;
    }
  }
  return out;
}

/* ------------------------- ORT session ------------------------- */

let ortReady = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(src + " missing"));
    document.head.appendChild(s);
  });
}
function loadOrt() {
  if (!ortReady)
    ortReady = loadScript("vendor/ort.all.min.js")
      .then(() => loadScript("vendor/ort-embed.js"))
      .then(() => {
        const toBlob = (b64, type) => {
          const bin = atob(b64);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return URL.createObjectURL(new Blob([u8], { type }));
        };
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.wasmPaths = {
          mjs: toBlob(ORT_MJS_B64, "text/javascript"),
          wasm: toBlob(ORT_WASM_B64, "application/wasm"),
        };
      });
  return ortReady;
}

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

function sampleTopP(logits, temperature, topP, banned) {
  const V = logits.length;
  for (const t of banned) logits[t] = -1e9;
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

/* ---- playability / grammar state for constrained sampling ---- */

function newGenState() {
  return { btOpen: [false, false, false, false], fxOpen: [false, false],
           laOpen: [false, false], laPts: [0, 0], tickNotes: 0 };
}

function stateStep(st, t) {
  const name = VOCAB[t] || "";
  if (name === "bar" || name.startsWith("d_")) st.tickNotes = 0;
  else if (name.startsWith("bt_chip_")) st.tickNotes++;
  else if (name.startsWith("bt_on_")) { st.btOpen[+name.slice(-1)] = true; st.tickNotes++; }
  else if (name.startsWith("bt_off_")) st.btOpen[+name.slice(-1)] = false;
  else if (name.startsWith("fx_chip_")) st.tickNotes++;
  else if (name.startsWith("fx_on_")) { st.fxOpen[+name.slice(-1)] = true; st.tickNotes++; }
  else if (name.startsWith("fx_off_")) st.fxOpen[+name.slice(-1)] = false;
  else if (name.startsWith("la_on_")) { const s = +name.slice(-1); st.laOpen[s] = true; st.laPts[s] = 0; }
  else if (name.startsWith("la_v_")) st.laPts[+name.split("_")[2]]++;
  else if (name.startsWith("la_off_")) st.laOpen[+name.slice(-1)] = false;
}

// which hand a lane belongs to: left = BT A/B + FX-L, right = BT C/D + FX-R
const ZONE = [
  ["bt_chip_0", "bt_on_0", "bt_chip_1", "bt_on_1", "fx_chip_0", "fx_on_0"],
  ["bt_chip_2", "bt_on_2", "bt_chip_3", "bt_on_3", "fx_chip_1", "fx_on_1"],
];
const ALL_NOTE_STARTS = ZONE[0].concat(ZONE[1]);

function tokenMask(st, rangeMode, pos, stopPos) {
  const banned = new Set([PAD, BOS]);
  if (rangeMode) { banned.add(EOS); banned.add(TID.bpmch); }
  else if (pos < stopPos * 0.75) banned.add(EOS);
  for (let l = 0; l < 4; l++) {
    if (st.btOpen[l]) { banned.add(TID["bt_on_" + l]); banned.add(TID["bt_chip_" + l]); }
    else banned.add(TID["bt_off_" + l]);
  }
  for (let s = 0; s < 2; s++) {
    if (st.fxOpen[s]) { banned.add(TID["fx_on_" + s]); banned.add(TID["fx_chip_" + s]); }
    else banned.add(TID["fx_off_" + s]);
    if (st.laOpen[s]) {
      banned.add(TID["la_on_" + s]);
      if (st.laPts[s] > 0) banned.add(TID["la_wide_" + s]); // wide only right after on
      if (st.laPts[s] < 2) banned.add(TID["la_off_" + s]);  // segments need 2+ points
    } else {
      banned.add(TID["la_off_" + s]);
      banned.add(TID["la_wide_" + s]);
      for (let v = 0; v <= 50; v++) banned.add(TID["la_v_" + s + "_" + v]);
    }
  }
  // playability: an active laser occupies that hand -> no notes in its zone;
  // chord size (incl. held holds) capped at 4 / 2 with one laser / 0 with both
  for (let s = 0; s < 2; s++)
    if (st.laOpen[s]) for (const n of ZONE[s]) banned.add(TID[n]);
  const held = st.btOpen.filter(Boolean).length + st.fxOpen.filter(Boolean).length;
  const cap = st.laOpen[0] && st.laOpen[1] ? 0 : (st.laOpen[0] || st.laOpen[1] ? 2 : 4);
  if (st.tickNotes + held >= cap)
    for (const n of ALL_NOTE_STARTS) banned.add(TID[n]);
  return banned;
}

/* opts: {level, radar, bpm, guidance, audioGuidance, onsets|null,
          context: {tokens, ticks} | null, startPos, stopPos, maxTokens,
          cancelled, onProgress}
   Generation is chunked: when the context window fills up, the session is
   re-primed with the conditioning plus the most recent tokens, so any
   range length works. -> {tokens} | null on cancel */
async function generate(opts) {
  const F = featsPerCell(), A = MC.audio_dim;
  const NL = MC.n_layer, NH = MC.n_head, HD = MC.head_dim;
  const haveAudio = !!opts.onsets;
  const B = haveAudio ? 3 : 2; // rows: cond+audio, uncond-radar, [cond no-audio]
  const cond = [BOS, ...condTokens(opts.level, opts.radar, opts.bpm)];
  const uncond = [BOS, cond[1], UNCOND, UNCOND, UNCOND, UNCOND, UNCOND, UNCOND, cond[8]];
  const CHUNK_TAIL = 900; // recent tokens carried over when re-priming

  const window_ = pos => {
    const w = new Float32Array(A);
    if (opts.onsets) {
      const c = Math.min(Math.floor(pos / GRID), opts.onsets.length / F - WINDOW - 1);
      for (let i = 0; i < A; i++) w[i] = opts.onsets[c * F + i];
    }
    return w;
  };

  let past = [];
  const runStep = async (idsPerRow, audioF, mask, S, P) => {
    const flat = [];
    for (const row of idsPerRow) flat.push(...row);
    const f = {
      idx: new ort.Tensor("int64", BigInt64Array.from(flat.map(BigInt)), [B, S]),
      audio: new ort.Tensor("float32", audioF, [B, S, A]),
      mask: new ort.Tensor("float32", mask, [B, 1, S, P + S]),
    };
    for (let i = 0; i < NL; i++) {
      f["past_k_" + i] = past[2 * i];
      f["past_v_" + i] = past[2 * i + 1];
    }
    const out = await session.run(f);
    for (let i = 0; i < NL; i++) {
      past[2 * i] = out["pres_k_" + i];
      past[2 * i + 1] = out["pres_v_" + i];
    }
    return out;
  };

  const prefill = async (tailTokens, tailTicks) => {
    past = [];
    for (let i = 0; i < 2 * NL; i++)
      past.push(new ort.Tensor("float32", new Float32Array(0), [B, NH, 0, HD]));
    const rowsC = cond.concat(tailTokens);
    const rowsU = uncond.concat(tailTokens);
    const S0 = rowsC.length;
    const mask = new Float32Array(B * S0 * S0);
    for (let b = 0; b < B; b++)
      for (let i = 0; i < S0; i++)
        for (let j = 0; j < S0; j++)
          mask[(b * S0 + i) * S0 + j] = j <= i ? 0 : -1e9;
    const audio = new Float32Array(B * S0 * A);
    for (let i = 0; i < S0; i++) {
      const w = window_(i < PREFIX_LEN ? 0 : tailTicks[i - PREFIX_LEN]);
      for (let b = 0; b < B; b++)
        if (!(haveAudio && b === 2)) audio.set(w, (b * S0 + i) * A);
    }
    const rows = haveAudio ? [rowsC, rowsU, rowsC] : [rowsC, rowsU];
    const out = await runStep(rows, audio, mask, S0, 0);
    return { out, S0 };
  };

  const ctxTokens = opts.context ? opts.context.tokens : [];
  const ctxTicks = opts.context ? opts.context.ticks : [];
  const st = newGenState();
  for (const t of ctxTokens) stateStep(st, t); // seed holds/lasers crossing the boundary
  st.tickNotes = 0;

  let { out, S0 } = await prefill(ctxTokens, ctxTicks);
  let P = S0;
  const body = [], bodyTicks = [];
  let pos = opts.startPos;
  const V = VOCAB.length;
  const gr = opts.guidance, ga = opts.audioGuidance;
  const maxTok = opts.maxTokens || 20000;
  const rangeMode = !!opts.context;

  while (body.length < maxTok && pos < opts.stopPos) {
    const lg = out.logits.data;
    const S = out.logits.dims[1];
    const off = b => (b * S + (S - 1)) * V;
    const mixed = new Float32Array(V);
    for (let i = 0; i < V; i++) {
      let x = lg[off(0) + i] + (gr - 1) * (lg[off(0) + i] - lg[off(1) + i]);
      if (haveAudio) x += (ga - 1) * (lg[off(0) + i] - lg[off(2) + i]);
      mixed[i] = x;
    }
    const t = sampleTopP(mixed, 0.95, 0.95, tokenMask(st, rangeMode, pos, opts.stopPos));
    if (t === EOS) break;
    body.push(t);
    stateStep(st, t);
    const name = VOCAB[t];
    if (name === "bar") pos = (Math.floor(pos / MEASURE) + 1) * MEASURE;
    else if (name.startsWith("d_")) pos += parseInt(name.slice(2));
    bodyTicks.push(pos);
    if (opts.cancelled()) return null;
    if (opts.onProgress && body.length % 25 === 0) opts.onProgress(body.length, pos);

    if (P + 1 >= MC.ctx - 4) {
      // window full: re-prime with conditioning + the most recent tokens
      const all = ctxTokens.concat(body), allTicks = ctxTicks.concat(bodyTicks);
      const tail = all.slice(-CHUNK_TAIL), tailTicks = allTicks.slice(-CHUNK_TAIL);
      ({ out, S0 } = await prefill(tail, tailTicks));
      P = S0;
      continue;
    }
    const w = window_(pos);
    const stepAudio = new Float32Array(B * A);
    for (let b = 0; b < B; b++)
      if (!(haveAudio && b === 2)) stepAudio.set(w, b * A);
    out = await runStep(Array.from({ length: B }, () => [t]),
                        stepAudio, new Float32Array(B * (P + 1)), 1, P);
    P += 1;
  }
  return { tokens: body };
}

/* --------------------------- dialog --------------------------- */

let modelBytes = null, running = false, cancelFlag = false;

function bookmarks() {
  return ED.chart.other
    .filter(o => o.s.startsWith("//bm:"))
    .map(o => ({ y: o.y, name: o.s.slice(5) || "(unnamed)" }))
    .sort((a, b) => a.y - b.y);
}

async function tryEmbeddedModel() {
  try {
    await loadScript("model/chartgen-model.js");
    if (typeof CHARTGEN_ONNX_B64 !== "undefined") {
      const bin = atob(CHARTGEN_ONNX_B64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      modelBytes = u8.buffer;
      if (typeof CHARTGEN_META !== "undefined") MC = Object.assign(MC, CHARTGEN_META);
      return true;
    }
  } catch (e) { /* no embedded model shipped */ }
  return false;
}

async function open() {
  const d = ED.dom;
  d.genModal.showModal();
  d.genBpm.value = KSH.fmtNum(ED.chart.bpms[0].v);
  const hasAudio = !!AudioEng.buffer;
  d.chkGenAudio.disabled = !hasAudio;
  d.chkGenAudio.checked = hasAudio;
  const bms = bookmarks();
  for (const sel of [d.genBmFrom, d.genBmTo]) {
    sel.innerHTML = "";
    bms.forEach((b, i) => {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = `#${Math.floor(b.y / MEASURE) + 1} · ${b.name}`;
      sel.appendChild(o);
    });
  }
  if (bms.length >= 2) d.genBmTo.value = bms.length - 1;
  d.genRange.querySelector('option[value="bm"]').disabled = bms.length < 2;
  if (bms.length < 2) d.genRange.value = "all";
  updateRangeUI();

  if (!modelBytes) {
    updateStatus("loading model ...");
    if (await tryEmbeddedModel()) {
      updateStatus(`model ready (${(modelBytes.byteLength / 1e6).toFixed(0)} MB)`);
    } else {
      updateStatus("model files missing from the editor build (model/chartgen-model.js)");
    }
  } else {
    updateStatus(`model ready (${(modelBytes.byteLength / 1e6).toFixed(0)} MB)`);
  }
}

function updateRangeUI() {
  const d = ED.dom;
  const bm = d.genRange.value === "bm";
  d.genBmRow.style.display = bm ? "" : "none";
  d.genMeasuresRow.style.display = bm ? "none" : "";
}

function updateStatus(msg) { ED.dom.genStatus.textContent = msg; }

function setRunning(on) {
  const d = ED.dom;
  running = on;
  d.btnGenGo.disabled = on;
  d.btnGenerate.disabled = on;
  d.btnGenCancel.style.display = on ? "" : "none";
}

async function go() {
  const d = ED.dom;
  if (running || !modelBytes) {
    if (!modelBytes) updateStatus("load a model file first");
    return;
  }
  const rangeMode = d.genRange.value === "bm";
  if (!rangeMode && ED.dirty && !confirm("Discard unsaved changes and generate a new chart?")) return;
  cancelFlag = false;
  setRunning(true);
  try {
    updateStatus("starting ONNX session ...");
    await ensureSession(modelBytes);
    const bpm = parseFloat(d.genBpm.value) || 170;
    const level = parseInt(d.genLevel.value) || 15;
    const radar = {};
    for (const ax of RADAR_AXES)
      radar[ax] = Math.round(parseFloat(d["genS_" + ax].value) * 200);

    // range bounds + context
    let startPos = 0, stopPos, context = null;
    if (rangeMode) {
      const bms = bookmarks();
      const A = bms[parseInt(d.genBmFrom.value)], Bm = bms[parseInt(d.genBmTo.value)];
      if (!A || !Bm || Bm.y <= A.y) { updateStatus("pick two bookmarks in order"); return; }
      startPos = A.y;
      stopPos = Bm.y;
      const enc = encodeBody(ED.chart);
      let cut = enc.tokens.length;
      for (let i = 0; i < enc.tokens.length; i++)
        if (enc.ticks[i] >= A.y) { cut = i; break; }
      const keep = Math.max(0, cut - (MC.ctx - 600)); // leave room to generate
      context = { tokens: enc.tokens.slice(keep, cut), ticks: enc.ticks.slice(keep, cut) };
    } else {
      stopPos = Math.max(4, Math.min(128, parseInt(d.genMeasures.value) || 48)) * MEASURE;
    }

    let onsets = null, offsetMs = 0;
    if (d.chkGenAudio.checked && AudioEng.buffer) {
      updateStatus("analyzing audio ...");
      offsetMs = Math.max(0, Math.round(parseFloat(ED.chart.meta.o) || 0));
      const analysis = analyzeAudio(AudioEng.buffer);
      onsets = gridFeatures(analysis, bpm, offsetMs, Math.ceil(stopPos / GRID) + 1);
    }

    updateStatus(`generating (${sessionEp}) ...`);
    const t0 = performance.now();
    const res = await generate({
      level, radar, bpm,
      guidance: Math.max(1, Math.min(3, parseFloat(d.genGuidance.value) || 2)),
      audioGuidance: Math.max(1, Math.min(3, parseFloat(d.genAudioG.value) || 2.5)),
      onsets, context, startPos, stopPos,
      cancelled: () => cancelFlag,
      onProgress: (tok, pos) =>
        updateStatus(`generating ... ${tok} tokens, measure ${Math.floor(pos / MEASURE)}/${Math.ceil(stopPos / MEASURE)}`),
    });
    if (res === null) { updateStatus("cancelled"); return; }
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    const gen = decodeBody(res.tokens, bpm, startPos);

    if (rangeMode) {
      applyRange(gen, startPos, stopPos);
      d.genModal.close();
      toast(`Regenerated measures ${Math.floor(startPos / MEASURE) + 1}-${Math.floor(stopPos / MEASURE) + 1} in ${secs}s (${sessionEp})`);
    } else {
      const m = gen.meta;
      m.title = "Generated lv" + level;
      m.artist = "ChartGPT";
      m.effect = "ChartGPT";
      m.difficulty = "infinite";
      m.level = String(level);
      if (d.chkGenAudio.checked && AudioEng.buffer) {
        m.m = ED.chart.meta.m;
        m.o = String(offsetMs);
      }
      setChart(gen);
      ED.kshHandle = null;
      ED.kshName = "";
      ED.dirty = true;
      updateTitle();
      d.genModal.close();
      toast(`Generated ${sumNotes(gen)} notes in ${secs}s (${sessionEp}) — review and save`);
    }
  } catch (e) {
    updateStatus("failed: " + e.message);
  } finally {
    setRunning(false);
  }
}

// splice generated objects into [A, B) of the current chart (undoable)
function applyRange(gen, A, B) {
  pushUndo();
  const inRange = y => y >= A && y < B;
  for (let l = 0; l < 4; l++) {
    ED.chart.bt[l] = ED.chart.bt[l].filter(n => !inRange(n.y));
    for (const n of gen.bt[l]) if (inRange(n.y)) {
      n.l = Math.min(n.l, Math.max(0, B - n.y));
      ED.chart.bt[l].push(n);
    }
    ED.chart.bt[l].sort((a, b) => a.y - b.y);
  }
  for (let s = 0; s < 2; s++) {
    ED.chart.fx[s] = ED.chart.fx[s].filter(n => !inRange(n.y));
    for (const n of gen.fx[s]) if (inRange(n.y)) {
      n.l = Math.min(n.l, Math.max(0, B - n.y));
      ED.chart.fx[s].push(n);
    }
    ED.chart.fx[s].sort((a, b) => a.y - b.y);
    ED.chart.lasers[s] = ED.chart.lasers[s].filter(g => !inRange(g.points[0].y));
    for (const g of gen.lasers[s]) {
      if (!inRange(g.points[0].y)) continue;
      g.points = g.points.filter(p => p.y < B);
      if (g.points.length >= 2) ED.chart.lasers[s].push(g);
    }
    ED.chart.lasers[s].sort((a, b) => a.points[0].y - b.points[0].y);
  }
  setSel(null);
  markEdit();
}

function sumNotes(chart) {
  return chart.bt.reduce((a, l) => a + l.length, 0) + chart.fx.reduce((a, s) => a + s.length, 0);
}

function init() {
  const d = ED.dom;
  d.btnGenerate.addEventListener("click", open);
  d.genModal.addEventListener("close", () => { cancelFlag = true; });
  d.btnGenClose.addEventListener("click", () => { cancelFlag = true; d.genModal.close(); });
  d.btnGenCancel.addEventListener("click", () => { cancelFlag = true; });
  d.btnGenGo.addEventListener("click", go);
  d.genRange.addEventListener("change", updateRangeUI);
  for (const ax of RADAR_AXES) {
    const slider = d["genS_" + ax];
    slider.addEventListener("input", () => {
      d["genV_" + ax].textContent = parseFloat(slider.value).toFixed(2);
    });
  }
}

return { init };
})();
