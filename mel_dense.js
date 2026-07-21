"use strict";
/* ============================================================
 * v6 dense per-frame log-mel — mirrors sdvx_dataset/mel_dense.py
 * EXACTLY (native sr, n_fft 1024, hop round(0.01*sr), 80 HTK mels
 * over [0, sr/2], per-song p95 normalize, u8). Any change here must
 * be ported to mel_dense.py. The audio is forced to 44.1 kHz (the
 * training sample rate) before analysis so features match training.
 * ============================================================ */

const MelDense = (() => {
  const N_FFT = 1024, N_MELS = 80, TARGET_SR = 44100;

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
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= N_FFT; len <<= 1) {
      const step = N_FFT / len;
      for (let i = 0; i < N_FFT; i += len)
        for (let k = 0; k < len / 2; k++) {
          const tr = _tw.re[k * step], ti = _tw.im[k * step];
          const a = i + k, b = i + k + len / 2;
          const xr = re[b] * tr - im[b] * ti, xi = re[b] * ti + im[b] * tr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
    }
  }

  const _hann = (() => {
    const w = new Float32Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N_FFT - 1));
    return w;
  })();

  function melFilterbank(sr) {
    const nBins = N_FFT / 2 + 1;
    const melToHz = m => 700 * (10 ** (m / 2595) - 1);
    const top = 2595 * Math.log10(1 + (sr / 2) / 700);
    const pts = [];
    for (let i = 0; i < N_MELS + 2; i++) pts.push(melToHz(top * i / (N_MELS + 1)));
    const filt = [];
    for (let m = 0; m < N_MELS; m++) {
      const w = new Float32Array(nBins);
      const lo = pts[m], mid = pts[m + 1], hi = pts[m + 2];
      for (let k = 0; k < nBins; k++) {
        const f = k * sr / N_FFT;
        w[k] = Math.max(0, Math.min((f - lo) / Math.max(mid - lo, 1e-9),
                                    (hi - f) / Math.max(hi - mid, 1e-9)));
      }
      filt.push(w);
    }
    return filt;
  }

  function percentileLinear(arr, q) {
    const a = Float64Array.from(arr).sort();
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos), frac = pos - lo;
    return a[lo] + frac * ((a[Math.min(lo + 1, a.length - 1)] ?? a[lo]) - a[lo]);
  }

  // resample an AudioBuffer to 44.1 kHz mono via OfflineAudioContext (identity
  // for already-44.1k sources). Returns a Float32Array of mono samples.
  async function to44kMono(buffer) {
    let buf = buffer;
    if (Math.abs(buffer.sampleRate - TARGET_SR) > 1) {
      const oc = new OfflineAudioContext(1, Math.ceil(buffer.duration * TARGET_SR), TARGET_SR);
      const src = oc.createBufferSource();
      src.buffer = buffer; src.connect(oc.destination); src.start();
      buf = await oc.startRendering();
    }
    const nc = Math.min(2, buf.numberOfChannels), n = buf.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < nc; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i];
    }
    if (nc > 1) for (let i = 0; i < n; i++) mono[i] /= nc;
    return mono;
  }

  // -> { u8: Uint8Array(frames*80), frames, fps } ; endMs trims like Python
  async function dense(buffer, endMs) {
    const sr = TARGET_SR, hop = Math.round(0.01 * sr);
    let mono = await to44kMono(buffer);
    if (endMs != null) {
      const keep = Math.max(Math.floor((endMs / 1000 + 2) * sr), N_FFT * 2);
      if (mono.length > keep) mono = mono.subarray(0, keep);
    }
    if (mono.length < N_FFT * 2) return { u8: new Uint8Array(N_MELS), frames: 1, fps: sr / hop };
    const frames = 1 + Math.floor((mono.length - N_FFT) / hop);
    const filt = melFilterbank(sr);
    const melDb = new Float32Array(frames * N_MELS);
    const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT);
    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      for (let i = 0; i < N_FFT; i++) { re[i] = (mono[off + i] || 0) * _hann[i]; im[i] = 0; }
      fft1024(re, im);
      for (let m = 0; m < N_MELS; m++) {
        let acc = 0; const w = filt[m];
        for (let i = 0; i <= N_FFT / 2; i++) acc += w[i] * (re[i] * re[i] + im[i] * im[i]);
        melDb[f * N_MELS + m] = 10 * Math.log10(acc + 1e-10);
      }
    }
    const ref = percentileLinear(melDb, 0.95);
    const u8 = new Uint8Array(frames * N_MELS);
    for (let i = 0; i < melDb.length; i++) {
      const x = Math.max(0, Math.min(1, (melDb[i] - ref) / 60 + 1));
      u8[i] = Math.round(x * 255);
    }
    return { u8, frames, fps: sr / hop, mels: N_MELS };
  }

  return { dense, N_MELS };
})();
if (typeof module !== "undefined") module.exports = MelDense;
