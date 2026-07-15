"use strict";
/* ============================================================
 * Audio engine: song playback (media element through Web Audio,
 * so changing the speed keeps the pitch), waveform peaks,
 * synthesized hitsounds / metronome clicks.
 * ============================================================ */

const AudioEng = {
  ctx: null,
  buffer: null,      // decoded copy: waveform peaks, duration, FX preview slices
  fileName: "",
  mediaEl: null,     // song playback element — playbackRate preserves pitch
  mediaNode: null,
  mediaUrl: null,
  musicGain: null,
  clickGain: null,
  playing: false,
  rate: 1,
  _startCtx: 0,
  _startMs: 0,
  _pending: null,    // timer for a lead-in start before audio time 0
  _endCtx: null,     // ctx time when the media ended (chart longer than song)
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
    const blob = new Blob([ab.slice(0)]); // copy: decodeAudioData detaches ab
    this.buffer = await this.ctx.decodeAudioData(ab);
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.mediaUrl = URL.createObjectURL(blob);
    if (!this.mediaEl) {
      this.mediaEl = new Audio();
      this.mediaEl.preservesPitch = true; // time-stretch: slow playback keeps pitch
      this.mediaNode = this.ctx.createMediaElementSource(this.mediaEl);
      this.mediaNode.connect(typeof FXDSP !== "undefined" ? FXDSP.input() : this.musicGain);
    }
    this.mediaEl.src = this.mediaUrl;
    this.fileName = name || "";
    this._startMs = 0;
    this.buildPeaks();
  },

  durationMs() { return this.buffer ? this.buffer.duration * 1000 : 0; },

  play(fromMs) {
    if (!this.buffer || !this.mediaEl) return false;
    this.ensureCtx();
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.stop();
    const el = this.mediaEl;
    el.playbackRate = this.rate;
    this._startCtx = this.ctx.currentTime;
    this._startMs = fromMs;
    this.playing = true;
    if (fromMs >= 0) {
      el.currentTime = Math.min(fromMs, this.durationMs()) / 1000;
      el.play().catch(() => {});
    } else {
      // negative offset: wait out the lead-in on the ctx clock, then start at 0
      el.currentTime = 0;
      this._pending = setTimeout(() => {
        this._pending = null;
        if (this.playing) el.play().catch(() => {});
      }, -fromMs / this.rate);
    }
    return true;
  },

  positionMs() {
    if (!this.playing) return this._startMs;
    if (this._pending)
      return this._startMs + (this.ctx.currentTime - this._startCtx) * 1000 * this.rate;
    if (this.mediaEl.ended) {
      // keep the playhead moving past the song's end (chart may be longer)
      if (this._endCtx === null) this._endCtx = this.ctx.currentTime;
      return this.durationMs() + (this.ctx.currentTime - this._endCtx) * 1000 * this.rate;
    }
    this._endCtx = null;
    return this.mediaEl.currentTime * 1000;
  },

  msToCtxTime(ms) { return this.ctx.currentTime + (ms - this.positionMs()) / 1000 / this.rate; },

  stop() {
    if (this._pending) { clearTimeout(this._pending); this._pending = null; }
    if (this.mediaEl && !this.mediaEl.paused) this.mediaEl.pause();
    this._endCtx = null;
    this.playing = false;
  },

  setRate(r) {
    this.rate = r;
    if (this.mediaEl && this.playing) this.mediaEl.playbackRate = r;
  },
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
    const sr = this.ctx.sampleRate;
    let seed = 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 * 2 - 1;
    let buf;
    if (type === "bt" || type === "fx") {
      // pitchless tick: a few ms of high-passed noise with a very fast decay —
      // no tonal component, so it reads as "tick", not a pitched click
      const decay = type === "bt" ? 1100 : 700;
      const hp = type === "bt" ? 0.93 : 0.78;
      const len = Math.round(sr * 0.03);
      buf = this.ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      let prev = 0;
      for (let i = 0; i < len; i++) {
        const x = rnd() * Math.exp(-(i / sr) * decay);
        d[i] = (x - prev * hp) * 0.7;
        prev = x;
      }
    } else {
      const len = Math.round(sr * 0.06);
      buf = this.ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      const spec = {
        slam:  { f: 330,  decay: 45,  noise: 0.85 },
        methi: { f: 1760, decay: 110, noise: 0.0  },
        metlo: { f: 880,  decay: 110, noise: 0.0  },
      }[type] || { f: 1000, decay: 80, noise: 0 };
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const env = Math.exp(-t * spec.decay);
        d[i] = env * ((1 - spec.noise) * Math.sin(2 * Math.PI * spec.f * t) + spec.noise * rnd()) * 0.9;
      }
    }
    this._clicks[type] = buf;
    return buf;
  },

  scheduleClick(type, ctxTime) {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    // bt/fx always use the synthesized tick — the skin's claps/clicks sound pitched
    src.buffer = (type === "bt" || type === "fx")
      ? this._clickBuf(type)
      : this._samples[type] || this._clickBuf(type);
    src.connect(type === "methi" || type === "metlo" ? this.metGain : this.clickGain);
    src.start(Math.max(ctxTime, this.ctx.currentTime));
  },
};
