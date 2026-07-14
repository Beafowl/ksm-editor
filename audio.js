"use strict";
/* ============================================================
 * Audio engine: song playback (Web Audio), waveform peaks,
 * synthesized hitsounds / metronome clicks.
 * ============================================================ */

const AudioEng = {
  ctx: null,
  buffer: null,
  fileName: "",
  srcNode: null,
  musicGain: null,
  clickGain: null,
  playing: false,
  rate: 1,
  _startCtx: 0,
  _startMs: 0,
  peaks: null,       // Float32Array of |peak| per bin
  peakMs: 4,         // ms per bin

  metGain: null,

  _samples: {},

  ensureCtx() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.75;
    this.musicGain.connect(this.ctx.destination);
    this.clickGain = this.ctx.createGain();
    this.clickGain.gain.value = 0.5;
    this.clickGain.connect(this.ctx.destination);
    this.metGain = this.ctx.createGain();
    this.metGain.gain.value = 0.5;
    this.metGain.connect(this.ctx.destination);
    this._loadGameSounds();
  },

  // decode the embedded USC skin sounds (sounds.js); synth clicks remain the fallback
  _loadGameSounds() {
    if (typeof GAME_SOUNDS === "undefined") return;
    for (const [key, b64] of Object.entries(GAME_SOUNDS)) {
      const bin = atob(b64);
      const ab = new ArrayBuffer(bin.length);
      const u8 = new Uint8Array(ab);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      this.ctx.decodeAudioData(ab).then(buf => { this._samples[key] = buf; }).catch(() => {});
    }
  },

  async loadArrayBuffer(ab, name) {
    this.ensureCtx();
    this.stop();
    this.buffer = await this.ctx.decodeAudioData(ab);
    this.fileName = name || "";
    this._startMs = 0;
    this.buildPeaks();
  },

  durationMs() { return this.buffer ? this.buffer.duration * 1000 : 0; },

  play(fromMs) {
    if (!this.buffer) return false;
    this.ensureCtx();
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(typeof FXDSP !== "undefined" ? FXDSP.input() : this.musicGain);
    const now = this.ctx.currentTime;
    if (fromMs >= 0) src.start(now, Math.min(fromMs, this.durationMs()) / 1000);
    else src.start(now + (-fromMs / 1000) / this.rate, 0);
    this.srcNode = src;
    this._startCtx = now;
    this._startMs = fromMs;
    this.playing = true;
    return true;
  },

  positionMs() {
    return this.playing
      ? this._startMs + (this.ctx.currentTime - this._startCtx) * 1000 * this.rate
      : this._startMs;
  },

  msToCtxTime(ms) { return this._startCtx + (ms - this._startMs) / 1000 / this.rate; },

  stop() {
    if (this.srcNode) {
      try { this.srcNode.stop(); } catch (e) { /* not started yet */ }
      this.srcNode.disconnect();
      this.srcNode = null;
    }
    this.playing = false;
  },

  setRate(r) { this.rate = r; },
  setMusicVolume(v) { this.ensureCtx(); this.musicGain.gain.value = Math.max(0, Math.min(1, v)); },
  setClickVolume(v) { this.ensureCtx(); this.clickGain.gain.value = Math.max(0, Math.min(1, v)); },
  setMetVolume(v) { this.ensureCtx(); this.metGain.gain.value = Math.max(0, Math.min(1, v)); },

  buildPeaks() {
    const buf = this.buffer;
    const binSamp = Math.max(1, Math.round(buf.sampleRate * this.peakMs / 1000));
    const n = Math.ceil(buf.length / binSamp);
    const peaks = new Float32Array(n);
    for (let ch = 0; ch < Math.min(2, buf.numberOfChannels); ch++) {
      const data = buf.getChannelData(ch);
      for (let b = 0; b < n; b++) {
        let m = 0;
        const s0 = b * binSamp, s1 = Math.min(data.length, s0 + binSamp);
        for (let s = s0; s < s1; s += 2) { const a = Math.abs(data[s]); if (a > m) m = a; }
        if (m > peaks[b]) peaks[b] = m;
      }
    }
    this.peaks = peaks;
  },

  // max |peak| over [ms0, ms1)
  rangePeak(ms0, ms1) {
    if (!this.peaks) return 0;
    let b0 = Math.floor(ms0 / this.peakMs), b1 = Math.ceil(ms1 / this.peakMs);
    b0 = Math.max(0, b0); b1 = Math.min(this.peaks.length, Math.max(b1, b0 + 1));
    let m = 0;
    for (let b = b0; b < b1; b++) if (this.peaks[b] > m) m = this.peaks[b];
    return m;
  },

  /* ------------------- click sounds ------------------- */
  _clicks: {},
  _clickBuf(type) {
    if (this._clicks[type]) return this._clicks[type];
    const sr = this.ctx.sampleRate, len = Math.round(sr * 0.06);
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const spec = {
      bt:    { f: 1568, decay: 90,  noise: 0.25 },
      fx:    { f: 660,  decay: 60,  noise: 0.55 },
      slam:  { f: 330,  decay: 45,  noise: 0.85 },
      methi: { f: 1760, decay: 110, noise: 0.0  },
      metlo: { f: 880,  decay: 110, noise: 0.0  },
    }[type] || { f: 1000, decay: 80, noise: 0 };
    let seed = 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 * 2 - 1;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-t * spec.decay);
      d[i] = env * ((1 - spec.noise) * Math.sin(2 * Math.PI * spec.f * t) + spec.noise * rnd()) * 0.9;
    }
    this._clicks[type] = buf;
    return buf;
  },

  scheduleClick(type, ctxTime) {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this._samples[type] || this._clickBuf(type);
    src.connect(type === "methi" || type === "metlo" ? this.metGain : this.clickGain);
    src.start(Math.max(ctxTime, this.ctx.currentTime));
  },
};
