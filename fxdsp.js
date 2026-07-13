"use strict";
/* ============================================================
 * FX audio preview: routes song playback through a Web Audio
 * effect chain and schedules approximations of KSM FX-hold
 * effects, plus a laser filter that follows the knobs.
 *
 * Graph:
 *   src -> preGain -> wobble(biquad) -> [dry | flanger | crusher] -> sum
 *       -> laserBiquad -> AudioEng.musicGain
 *   slice sources (retrigger/echo/tapestop/pitch) enter at `wobble`.
 * ============================================================ */

const FXDSP = (() => {

let ctx = null, built = false;
let preGain, wobble, dryGain, sum;
let flDelay, flFb, flWet, flOsc, flOscGain;
let crusher, crushWet;
let laserBiquad;
let liveSlices = [];
let curLaserType = "peak";

function makeCrushCurve(levels) {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1;
    c[i] = Math.round(x * levels) / levels;
  }
  return c;
}

function ensure() {
  if (built) return;
  AudioEng.ensureCtx();
  ctx = AudioEng.ctx;
  preGain = ctx.createGain();
  wobble = ctx.createBiquadFilter();
  wobble.type = "lowpass"; wobble.frequency.value = 20000; wobble.Q.value = 0.5;
  dryGain = ctx.createGain();

  flDelay = ctx.createDelay(0.05); flDelay.delayTime.value = 0.004;
  flFb = ctx.createGain(); flFb.gain.value = 0.45;
  flWet = ctx.createGain(); flWet.gain.value = 0;
  flOsc = ctx.createOscillator(); flOsc.frequency.value = 0.4;
  flOscGain = ctx.createGain(); flOscGain.gain.value = 0.0022;
  flOsc.connect(flOscGain); flOscGain.connect(flDelay.delayTime); flOsc.start();

  crusher = ctx.createWaveShaper(); crusher.curve = makeCrushCurve(20);
  crushWet = ctx.createGain(); crushWet.gain.value = 0;

  laserBiquad = ctx.createBiquadFilter();
  laserBiquad.type = "peaking"; laserBiquad.frequency.value = 1000;
  laserBiquad.gain.value = 0; laserBiquad.Q.value = 2.5;

  sum = ctx.createGain();
  preGain.connect(wobble);
  wobble.connect(dryGain); dryGain.connect(sum);
  wobble.connect(flDelay); flDelay.connect(flFb); flFb.connect(flDelay); flDelay.connect(flWet); flWet.connect(sum);
  wobble.connect(crusher); crusher.connect(crushWet); crushWet.connect(sum);
  sum.connect(laserBiquad);
  laserBiquad.connect(AudioEng.musicGain);
  built = true;
}

function input() { ensure(); return preGain; }

function autoParams() {
  return [preGain.gain, wobble.frequency, wobble.Q, flWet.gain, crushWet.gain, dryGain.gain];
}

function clear() {
  if (!built) return;
  for (const s of liveSlices) { try { s.stop(); } catch (e) { /* not started */ } }
  liveSlices = [];
  for (const p of autoParams()) p.cancelScheduledValues(0);
  preGain.gain.value = 1;
  wobble.frequency.value = 20000; wobble.Q.value = 0.5;
  flWet.gain.value = 0; crushWet.gain.value = 0; dryGain.gain.value = 1;
}

const T = ms => AudioEng.msToCtxTime(ms);

// play buffer[bufMs0 ..] at timeline atMs for durMs (timeline units), through the chain
function playSlice(bufMs0, durMs, atMs, vol, rateMul = 1, rateRampTo = null) {
  const rate = AudioEng.rate * rateMul;
  const src = ctx.createBufferSource();
  src.buffer = AudioEng.buffer;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  src.connect(g); g.connect(wobble);
  const t = Math.max(T(atMs), ctx.currentTime);
  const realDur = durMs / 1000 / AudioEng.rate;
  const fade = Math.min(0.004, realDur / 4);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + fade);
  g.gain.setValueAtTime(vol, Math.max(t + fade, t + realDur - fade));
  g.gain.linearRampToValueAtTime(0, t + realDur);
  if (rateRampTo !== null) {
    src.playbackRate.setValueAtTime(rate, t);
    src.playbackRate.linearRampToValueAtTime(rate * rateRampTo, t + realDur);
  }
  src.start(t, Math.max(0, bufMs0) / 1000);
  src.stop(t + realDur + 0.01);
  liveSlices.push(src);
}

// gain automation helper: hold `param` at `v` during [t0,t1] (timeline ms), restore to `back`
function holdParam(param, t0, t1, v, back) {
  const a = Math.max(T(t0), ctx.currentTime), b = Math.max(T(t1), ctx.currentTime + 0.001);
  param.setValueAtTime(back, a);
  param.linearRampToValueAtTime(v, a + 0.008);
  param.setValueAtTime(v, Math.max(b - 0.008, a + 0.009));
  param.linearRampToValueAtTime(back, b);
}

/* regions: [{t0, t1, type, I (interval ms), semi}] sorted by t0.
 * fromMs: only schedule what is still ahead of this position.
 * Must be called while AudioEng is playing (uses its clock mapping). */
function apply(regions, fromMs) {
  ensure();
  clear();
  if (!AudioEng.buffer || !AudioEng.playing) return;

  for (const r of regions) {
    if (r.t1 <= fromMs + 5) continue;
    const I = Math.max(10, r.I || 100);
    const k0 = Math.max(0, Math.floor((fromMs - r.t0) / I));

    switch (r.type) {
      case "Retrigger":
      case "Echo": {
        holdParam(preGain.gain, Math.max(r.t0, fromMs), r.t1, 0.02, 1);
        const decay = r.type === "Echo" ? 0.62 : 1;
        for (let k = k0; r.t0 + k * I < r.t1 - 1; k++) {
          const s = r.t0 + k * I;
          const dur = Math.min(I, r.t1 - s);
          const vol = 0.95 * Math.pow(decay, k);
          if (vol < 0.02) break;
          playSlice(r.t0, dur, s, vol);
        }
        break;
      }
      case "Gate": {
        const p = preGain.gain;
        for (let k = k0; r.t0 + k * I < r.t1 - 1; k++) {
          const s = r.t0 + k * I;
          const mid = s + I * 0.55, e = Math.min(s + I, r.t1);
          if (mid >= r.t1) break;
          p.setValueAtTime(1, Math.max(T(s), ctx.currentTime));
          p.setValueAtTime(1, Math.max(T(mid), ctx.currentTime));
          p.linearRampToValueAtTime(0.04, Math.max(T(mid) + 0.005, ctx.currentTime + 0.001));
          p.setValueAtTime(0.04, Math.max(T(e) - 0.005, ctx.currentTime));
          p.linearRampToValueAtTime(1, Math.max(T(e), ctx.currentTime + 0.002));
        }
        p.setValueAtTime(1, Math.max(T(r.t1), ctx.currentTime));
        break;
      }
      case "SideChain": {
        const p = preGain.gain;
        for (let k = k0; r.t0 + k * I < r.t1 - 1; k++) {
          const s = r.t0 + k * I;
          const t = Math.max(T(s), ctx.currentTime);
          p.setValueAtTime(0.22, t);
          p.linearRampToValueAtTime(1, t + (I * 0.8) / 1000 / AudioEng.rate);
        }
        p.setValueAtTime(1, Math.max(T(r.t1), ctx.currentTime));
        break;
      }
      case "TapeStop": {
        const s = Math.max(r.t0, fromMs);
        holdParam(preGain.gain, s, r.t1, 0.02, 1);
        playSlice(s, r.t1 - s, s, 0.95, 1, 0.04);
        break;
      }
      case "PitchShift": {
        const rateMul = Math.pow(2, (r.semi != null ? r.semi : 12) / 12);
        holdParam(preGain.gain, Math.max(r.t0, fromMs), r.t1, 0.02, 1);
        const G = 70; // grain size, timeline ms
        for (let k = Math.max(0, Math.floor((fromMs - r.t0) / G)); r.t0 + k * G < r.t1 - 1; k++) {
          const s = r.t0 + k * G;
          playSlice(s, Math.min(G, r.t1 - s), s, 0.9, rateMul);
        }
        break;
      }
      case "Wobble": {
        const t0 = Math.max(r.t0, fromMs), durReal = (r.t1 - t0) / 1000 / AudioEng.rate;
        if (durReal <= 0.01) break;
        const n = Math.max(8, Math.min(4000, Math.ceil(durReal * 100)));
        const curve = new Float32Array(n);
        const lo = 500, hi = 9000;
        for (let i = 0; i < n; i++) {
          const tMs = t0 + (i / (n - 1)) * (r.t1 - t0);
          const ph = ((tMs - r.t0) / I) * 2 * Math.PI - Math.PI / 2;
          curve[i] = lo * Math.pow(hi / lo, (1 + Math.sin(ph)) / 2);
        }
        try {
          wobble.frequency.setValueCurveAtTime(curve, Math.max(T(t0), ctx.currentTime), durReal);
          wobble.Q.setValueAtTime(1.6, Math.max(T(t0), ctx.currentTime));
          wobble.frequency.setValueAtTime(20000, T(r.t1) + 0.01);
          wobble.Q.setValueAtTime(0.5, T(r.t1) + 0.01);
        } catch (e) { /* overlapping wobble regions: skip */ }
        break;
      }
      case "Flanger":
      case "Phaser": {
        holdParam(flWet.gain, Math.max(r.t0, fromMs), r.t1, 0.75, 0);
        break;
      }
      case "BitCrusher": {
        const s = Math.max(r.t0, fromMs);
        holdParam(crushWet.gain, s, r.t1, 0.9, 0);
        holdParam(dryGain.gain, s, r.t1, 0.15, 1);
        break;
      }
    }
  }
}

/* Laser filter follower — call every frame while playing.
 * state: null | {drive: 0..1, type: "peak"|"lpf1"|"hpf1"|...} */
function updateLaser(state) {
  if (!built) return;
  const now = ctx.currentTime;
  const tc = 0.025;
  let type = state ? state.type : curLaserType;
  if (type !== "lpf1" && type !== "hpf1") type = "peak"; // bitc/custom -> peak preview
  if (type !== curLaserType) {
    curLaserType = type;
    laserBiquad.type = type === "lpf1" ? "lowpass" : type === "hpf1" ? "highpass" : "peaking";
  }
  const f = laserBiquad.frequency, q = laserBiquad.Q, g = laserBiquad.gain;
  if (!state) {
    if (curLaserType === "lpf1") { f.setTargetAtTime(20000, now, tc); q.setTargetAtTime(0.5, now, tc); }
    else if (curLaserType === "hpf1") { f.setTargetAtTime(5, now, tc); q.setTargetAtTime(0.5, now, tc); }
    else g.setTargetAtTime(0, now, tc);
    return;
  }
  const d = Math.max(0, Math.min(1, state.drive));
  if (curLaserType === "lpf1") {
    f.setTargetAtTime(9000 * Math.pow(240 / 9000, d), now, tc);
    q.setTargetAtTime(5, now, tc);
    g.setTargetAtTime(0, now, tc);
  } else if (curLaserType === "hpf1") {
    f.setTargetAtTime(70 * Math.pow(50, d), now, tc);
    q.setTargetAtTime(5, now, tc);
    g.setTargetAtTime(0, now, tc);
  } else {
    f.setTargetAtTime(130 * Math.pow(60, d), now, tc);
    q.setTargetAtTime(2.5, now, tc);
    g.setTargetAtTime(2 + 12 * d, now, tc);
  }
}

return { input, apply, clear, updateLaser };
})();
