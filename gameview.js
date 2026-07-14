"use strict";
/* ============================================================
 * Game view: in-game style 3D rendering of the track, following
 * Unnamed SDVX Clone's camera model (Main/src/Camera.cpp,
 * Track.cpp). The track is a plane, so projecting polygon
 * corners through the same matrices USC uses is exact — plain
 * canvas 2D, no WebGL needed.
 *
 * Reads editor state `ED` (app.js).
 * ============================================================ */

const GameView = (() => {

/* ------------------------- USC constants ------------------------- */
const ZOOM_POW = 1.65;
const PITCH_UNIT = 180 / 12;          // KSM_PITCH_UNIT_POST_168
const FOV = 60;                       // landscape
const PITCH_OFFSET = 0.05;            // crit line 5% from bottom
const MAX_ROLL = 10 / 360;            // turns
const TRACK_W = 1.0;
const BTN_W = 1 / 6;
const TRACK_LEN = 10.0;
const LASER_EFF_W = TRACK_W - BTN_W;  // 5/6
const DEG = Math.PI / 180;

/* --------------------------- mat4 math --------------------------- */
// column-major 4x4
function mIdent() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function mMul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c*4+r] = a[r] * b[c*4] + a[4+r] * b[c*4+1] + a[8+r] * b[c*4+2] + a[12+r] * b[c*4+3];
  return o;
}
function mTrans(x, y, z) { const m = mIdent(); m[12] = x; m[13] = y; m[14] = z; return m; }
function mRotX(deg) {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1];
}
function mRotZ(deg) {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1];
}
function mPersp(fovYDeg, aspect, near, far) {
  const f = 1 / Math.tan(fovYDeg * DEG / 2);
  const nf = 1 / (near - far);
  return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0];
}
function mPoint(m, x, y, z) {
  return [
    m[0]*x + m[4]*y + m[8]*z + m[12],
    m[1]*x + m[5]*y + m[9]*z + m[13],
    m[2]*x + m[6]*y + m[10]*z + m[14],
    m[3]*x + m[7]*y + m[11]*z + m[15],
  ];
}

/* --------------------- USC camera construction --------------------- */
// GetOriginTransform (landscape branch)
function originTransform(pitch, offs, rollDeg) {
  let m = mRotZ(rollDeg);                                  // origin
  m = mMul(m, mMul(mTrans(offs, -0.9, 0), mRotX(1.5)));    // anchor
  m = mMul(m, mMul(mTrans(0, 0, -0.9), mRotX(-90 + pitch))); // contnr
  return m;
}
function pitchScale(input) {
  const kLower = -4, uLower = -3.05, kUpper = 5.59, uUpper = 4.75;
  let rot = 0;
  const dir = input < 0 ? -1 : 1;
  if (dir === -1) while (input < -12) { input += 24; rot++; }
  else while (input > 12) { input -= 24; rot++; }
  let scaled;
  if (input < kLower) scaled = -(-(input - kLower) / (12 + kLower)) * (12 + uLower) + uLower;
  else if (input < 0) scaled = (input / kLower) * uLower;
  else if (input < kUpper) scaled = (input / kUpper) * uUpper;
  else scaled = ((input - kUpper) / (12 - kUpper)) * (12 - uUpper) + uUpper;
  return rot * dir * 24 + scaled;
}
function zoomedTransform(m, laneZoom) {
  const px = m[12], py = m[13], pz = m[14];
  const dist = Math.hypot(px, py, pz) || 1;
  let amt;
  if (laneZoom <= 0) amt = Math.pow(ZOOM_POW, -laneZoom) - 1;
  else amt = dist * (Math.pow(ZOOM_POW, -Math.pow(laneZoom, 1.35)) - 1);
  return mMul(mTrans(px / dist * amt, py / dist * amt, pz / dist * amt), m);
}

/* ---------------------- spin animation (USC) ---------------------- */
function dampedSin(t, amplitude, frequency, decay) {
  return amplitude * Math.pow(Math.E, -decay * t) * Math.sin(frequency * 2 * t * Math.PI);
}
const swing = t => dampedSin(t, 120 / 360, 1, 3.5);
function fullSpinRoll(time, dir) { // time in [0,1]
  const TSPIN = 0.375, TRECOV = 0.375;
  if (time <= TSPIN) return -dir * (TSPIN - time) / TSPIN;
  if (time < TSPIN + TRECOV) return swing((time - TSPIN) / TRECOV) * 0.25 * dir;
  return 0;
}

/* ------------------- chart camera-event graphs ------------------- */
// built lazily, invalidated by chartVersion
let gCache = { version: -1 };

function buildGraphs() {
  const c = ED.chart;
  const g = {
    version: ED.chartVersion,
    zt: [], zb: [], zs: [],          // {y, v} zoom graphs (value/100)
    tiltMan: [],                     // {y, v} manual tilt (turns)
    tiltModes: [],                   // {y, intensity (turns), keep, manual}
    spins: [],                       // {y, type, dir, durTicks, amp, freq, decay}
    stops: [],                       // {y, len}
  };
  for (const o of c.other) {
    const eq = o.s.indexOf("=");
    if (eq <= 0) continue;
    const key = o.s.slice(0, eq), val = o.s.slice(eq + 1).trim();
    if (key === "zoom_top") g.zt.push({ y: o.y, v: (parseFloat(val) || 0) / 100 });
    else if (key === "zoom_bottom") g.zb.push({ y: o.y, v: (parseFloat(val) || 0) / 100 });
    else if (key === "zoom_side") g.zs.push({ y: o.y, v: (parseFloat(val) || 0) / 100 });
    else if (key === "stop") g.stops.push({ y: o.y, len: parseInt(val) || 0 });
    else if (key === "tilt") {
      let v = val, keep = false;
      if (v.startsWith("keep_")) { keep = true; v = v.slice(5); }
      const kw = { normal: 1, bigger: 2, biggest: 3, zero: 0 };
      if (v in kw) {
        const i = kw[v];
        g.tiltModes.push({ y: o.y, keep, manual: false,
          intensity: i === 0 ? 0 : MAX_ROLL * (1 + 0.75 * (i - 1)) });
      } else {
        const num = parseFloat(v);
        if (isFinite(num)) {
          g.tiltModes.push({ y: o.y, keep: false, manual: true, intensity: MAX_ROLL });
          g.tiltMan.push({ y: o.y, v: num * -(10 / 360) });
        }
      }
    }
  }
  for (const sp of c.spins) {
    const m = /^(@\(|@\)|@<|@>|S<|S>)(\d+)?(?:;(\d+))?(?:;(\d+))?(?:;(\d+))?/.exec(sp.s);
    if (!m) continue;
    const t = m[1];
    g.spins.push({
      y: sp.y,
      type: t[0] === "S" ? "bounce" : (t[1] === "(" || t[1] === ")") ? "full" : "quarter",
      dir: (t[1] === "(" || t[1] === "<") ? -1 : 1,
      durTicks: parseInt(m[2]) || 96,
      amp: (parseInt(m[3]) || 250) / 250,
      freq: parseInt(m[4]) || 3,
      decay: [0, 1.5, 3][parseInt(m[5]) || 2] ?? 3,
    });
  }
  for (const arr of [g.zt, g.zb, g.zs, g.tiltMan]) arr.sort((a, b) => a.y - b.y);
  g.tiltModes.sort((a, b) => a.y - b.y);
  g.spins.sort((a, b) => a.y - b.y);
  g.stops.sort((a, b) => a.y - b.y);
  gCache = g;
}

function graphs() {
  if (gCache.version !== ED.chartVersion) buildGraphs();
  return gCache;
}

// sample a {y,v} graph with linear interpolation (same-tick pairs = step)
function sampleGraph(arr, tick, def = 0) {
  if (!arr.length) return def;
  if (tick <= arr[0].y) return arr[0].v;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].y <= tick) lo = mid; else hi = mid - 1; }
  const p0 = arr[lo], p1 = arr[lo + 1];
  if (!p1 || p1.y === p0.y) return p0.v;
  return p0.v + (p1.v - p0.v) * (tick - p0.y) / (p1.y - p0.y);
}

// scroll position: ticks minus time consumed by stops
function scrollTick(tick) {
  let t = tick;
  for (const s of graphs().stops) {
    if (s.y >= tick) break;
    t -= Math.min(s.len, tick - s.y);
  }
  return t;
}

// laser position at tick for roll (USC looks ahead 2 beats to upcoming lasers)
function laserPosAt(side, tick) {
  const lookahead = 2 * KSH.TICKS_PER_BEAT * 2; // 2 beats (48t each... 96t) — generous
  for (const seg of ED.chart.lasers[side]) {
    const pts = seg.points;
    const first = pts[0].y, last = pts[pts.length - 1].y;
    if (tick > last) continue;
    if (tick < first) return first - tick <= lookahead ? pts[0].v : null;
    for (let i = 0; i + 1 < pts.length; i++)
      if (tick >= pts[i].y && tick <= pts[i + 1].y) {
        const f = (tick - pts[i].y) / Math.max(1, pts[i + 1].y - pts[i].y);
        return pts[i].v + (pts[i + 1].v - pts[i].v) * f;
      }
    return pts[pts.length - 1].v;
  }
  return null;
}

/* ----------------------- roll simulation ----------------------- */
const sim = { lastMs: null, critRoll: 0, actualRoll: 0, keepTarget: 0 };

function lerpTo(value, target, maxChange) {
  if (target < value) return Math.max(value - maxChange, target);
  return Math.min(value + maxChange, target);
}

function cameraStateAt(ms) {
  const g = graphs();
  const tick = ED.timing.msToTick(ms);

  // roll target from lasers
  const posL = laserPosAt(0, tick), posR = laserPosAt(1, tick);
  const rollL = posL === null ? 0 : -posL;
  const rollR = posR === null ? 0 : 1 - posR;
  const laserTarget = Math.max(-1, Math.min(1, rollL + rollR));

  // tilt mode at tick
  let mode = { keep: false, manual: false, intensity: MAX_ROLL };
  for (const m of g.tiltModes) { if (m.y <= tick) mode = m; else break; }

  let critTarget = laserTarget * MAX_ROLL;
  let actualTarget;
  if (mode.manual) actualTarget = sampleGraph(g.tiltMan, tick, 0);
  else if (mode.keep) {
    // keep: target only grows in magnitude within the same sign
    const t = laserTarget;
    if (sim.keepTarget === 0 || (Math.sign(sim.keepTarget) === Math.sign(t) && Math.abs(t) > Math.abs(sim.keepTarget)))
      sim.keepTarget = t;
    actualTarget = sim.keepTarget * mode.intensity;
  } else {
    sim.keepTarget = 0;
    actualTarget = null; // derived from critRoll below
  }

  // integrate lerps (snap on seek/pause)
  const dt = sim.lastMs === null ? null : (ms - sim.lastMs) / 1000;
  const continuous = ED.playing && dt !== null && dt >= 0 && dt < 0.25;
  if (continuous) {
    sim.critRoll = lerpTo(sim.critRoll, critTarget, dt * MAX_ROLL * 4);
    const target = actualTarget !== null ? actualTarget : (sim.critRoll / MAX_ROLL) * mode.intensity;
    const speed = MAX_ROLL * 4 * (mode.manual ? 2.5 : Math.max(mode.intensity, MAX_ROLL) / MAX_ROLL);
    sim.actualRoll = lerpTo(sim.actualRoll, target, dt * speed);
  } else {
    sim.critRoll = critTarget;
    sim.actualRoll = actualTarget !== null ? actualTarget : (critTarget / MAX_ROLL) * mode.intensity;
  }
  sim.lastMs = ms;

  // spin (deterministic from time — scrubbable)
  let spinRoll = 0, bounceOffset = 0;
  for (const sp of g.spins) {
    const start = ED.timing.tickToMs(sp.y);
    if (start > ms) break;
    let durMs = ED.timing.tickToMs(sp.y + sp.durTicks) - start;
    if (sp.type === "bounce") durMs *= 0.5;
    if (durMs <= 0) continue;
    const p = (ms - start) / durMs;
    if (p >= 2) continue;
    if (sp.type === "full") spinRoll = fullSpinRoll(p / 2, sp.dir);
    else if (sp.type === "quarter") spinRoll = swing(p / 2) * sp.dir;
    else bounceOffset = dampedSin(p / 2, sp.amp, sp.freq / 2, sp.decay) * sp.dir;
  }

  const laneZoom = sampleGraph(g.zb, tick, 0);
  const lanePitchIn = sampleGraph(g.zt, tick, 0);
  const laneOffset = sampleGraph(g.zs, tick, 0);

  const pitch = pitchScale(lanePitchIn) * PITCH_UNIT;
  const totalRoll = spinRoll + sim.actualRoll;
  const totalOffset = (laneOffset * (5 * 100) / (6 * 116)) / 2 + bounceOffset;

  return { pitch, totalRoll, totalOffset, laneZoom, spinRoll, actualRoll: sim.actualRoll };
}

/* --------------------------- projection --------------------------- */
function makeCamera(st, W, H) {
  const aspect = W / H;
  const world = originTransform(st.pitch, st.totalOffset, st.totalRoll * 360);
  const trackOrigin = zoomedTransform(world, st.laneZoom);

  const noRoll = originTransform(st.pitch, 0, 0);
  const px = noRoll[12], py = noRoll[13], pz = noRoll[14];
  const len = Math.hypot(px, py, pz) || 1;
  const rotToCrit = -Math.atan2(py / len, -pz / len) / DEG;
  const camPitch = rotToCrit - (FOV / 2 - FOV * PITCH_OFFSET);

  const view = mRotX(camPitch);
  const proj = mPersp(FOV, aspect, 0.1, 100);

  // crit line gets actual roll + a wobble tied to spin (USC critOrigin)
  const critWorld = originTransform(st.pitch, st.totalOffset,
    st.actualRoll * 360 + Math.sin(st.spinRoll * Math.PI * 2) * 20);
  const critOrigin = zoomedTransform(critWorld, st.laneZoom);

  const projPoint = (m, x, yDist) => {
    const w = mPoint(m, x, yDist, 0);
    const c = mPoint(view, w[0], w[1], w[2]);
    const p = mPoint(proj, c[0], c[1], c[2]);
    const pw = -c[2]; // perspective divide uses -z (w component)
    if (pw <= 0.01) return null;
    return [(0.5 + 0.5 * p[0] / p[3]) * W, (0.5 - 0.5 * p[1] / p[3]) * H];
  };
  return { track: (x, y) => projPoint(trackOrigin, x, y), crit: (x, y) => projPoint(critOrigin, x, y) };
}

function poly(ctx, pts) {
  if (pts.some(p => p === null)) return false;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  return true;
}

/* ----------------------------- render ----------------------------- */
function draw() {
  const cv = ED.dom.gameview;
  if (!cv || cv.clientWidth === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#06060d");
  bg.addColorStop(0.5, "#10101f");
  bg.addColorStop(1, "#07070e");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const st = cameraStateAt(ED.curMs);
  const cam = makeCamera(st, W, H);
  const P = cam.track;

  const curTick = ED.timing.msToTick(ED.curMs);
  const curScroll = scrollTick(curTick);
  const viewTicks = (2 * 4 * KSH.TICKS_PER_BEAT) / (ED.hispeed || 1); // 2 measures @ 4/4 per track view
  const yOf = tick => (scrollTick(tick) - curScroll) / viewTicks * TRACK_LEN;
  const Y0 = -1, Y1 = TRACK_LEN;
  // inverse (approx, ignores stops in the window edges) for culling
  const tickAtY = y => curTick + y / TRACK_LEN * viewTicks;
  const tMin = tickAtY(Y0) - 8, tMax = tickAtY(Y1) + viewTicks; // stops can push things closer: pad generously

  // ---- track base ----
  if (poly(ctx, [P(-TRACK_W/2, Y0), P(TRACK_W/2, Y0), P(TRACK_W/2, Y1), P(-TRACK_W/2, Y1)])) {
    ctx.fillStyle = "#14141d";
    ctx.fill();
  }
  // subtle side gutters (laser area)
  ctx.fillStyle = "rgba(120,140,255,0.05)";
  for (const sgn of [-1, 1])
    if (poly(ctx, [P(sgn*TRACK_W/2, Y0), P(sgn*(TRACK_W/2 - BTN_W/2), Y0), P(sgn*(TRACK_W/2 - BTN_W/2), Y1), P(sgn*TRACK_W/2, Y1)]))
      ctx.fill();

  // lane dividers
  ctx.strokeStyle = "rgba(160,160,200,0.22)";
  ctx.lineWidth = 1;
  for (let l = 0; l <= 4; l++) {
    const x = -2 * BTN_W + l * BTN_W;
    const a = P(x, 0), b = P(x, Y1);
    if (a && b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
  }
  // track edges
  ctx.strokeStyle = "rgba(200,200,255,0.35)";
  for (const x of [-TRACK_W/2, TRACK_W/2]) {
    const a = P(x, Y0), b = P(x, Y1);
    if (a && b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
  }

  // measure lines
  ctx.strokeStyle = "rgba(220,220,255,0.28)";
  for (const m of ED.measures) {
    if (m.y > tMax) break;
    if (m.y < tMin) continue;
    const y = yOf(m.y);
    if (y < Y0 || y > Y1) continue;
    const a = P(-TRACK_W/2, y), b = P(TRACK_W/2, y);
    if (a && b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
  }

  const clampSpan = (y0, y1) => y0 <= Y1 && y1 >= Y0 ? [Math.max(y0, Y0), Math.min(y1, Y1)] : null;

  // ---- FX holds ----
  for (let s = 0; s < 2; s++) {
    const x0 = -2 * BTN_W + s * 2 * BTN_W, x1 = x0 + 2 * BTN_W;
    for (const n of ED.chart.fx[s]) {
      if (n.l <= 0 || n.y > tMax || n.y + n.l < tMin) continue;
      const span = clampSpan(yOf(n.y), yOf(n.y + n.l));
      if (!span) continue;
      if (poly(ctx, [P(x0+0.01, span[0]), P(x1-0.01, span[0]), P(x1-0.01, span[1]), P(x0+0.01, span[1])])) {
        ctx.fillStyle = "rgba(255,120,20,0.32)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,150,60,0.6)";
        ctx.stroke();
      }
    }
  }
  // ---- BT holds ----
  for (let l = 0; l < 4; l++) {
    const x0 = -2 * BTN_W + l * BTN_W + 0.015, x1 = x0 + BTN_W - 0.03;
    for (const n of ED.chart.bt[l]) {
      if (n.l <= 0 || n.y > tMax || n.y + n.l < tMin) continue;
      const span = clampSpan(yOf(n.y), yOf(n.y + n.l));
      if (!span) continue;
      if (poly(ctx, [P(x0, span[0]), P(x1, span[0]), P(x1, span[1]), P(x0, span[1])])) {
        ctx.fillStyle = "rgba(235,235,255,0.30)";
        ctx.fill();
        ctx.strokeStyle = "rgba(235,235,255,0.55)";
        ctx.stroke();
      }
    }
  }

  // ---- lasers (USC style: additive glow, hues 200/330, BPM-scaled slams) ----
  const LW = BTN_W;                                    // laser body width = Track::laserWidth
  const LCOL = [[0, 170, 255], [255, 0, 128]];          // HSV(200,1,1) / HSV(330,1,1)
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const LAYERS = [[1.0, 0.22], [0.55, 0.5], [0.22, 0.9]]; // [width factor, alpha] glow stack
  // slam bar height = 0.1s of view distance (Camera::m_slamDuration)
  const slamH = tick => {
    const msPerTick = 60000 / (ED.timing.bpmAt(Math.max(0, tick)) * KSH.TICKS_PER_BEAT);
    return (100 / msPerTick) / viewTicks * TRACK_LEN;
  };
  ctx.globalCompositeOperation = "lighter";
  for (let s = 0; s < 2; s++) {
    const col = LCOL[s];
    const core = col.map(v => Math.round(v + (255 - v) * 0.7));
    for (const seg of ED.chart.lasers[s]) {
      const pts = seg.points;
      if (pts[0].y > tMax || pts[pts.length - 1].y < tMin) continue;
      const lx = v => ((seg.wide === 2 ? v * 2 - 0.5 : v) - 0.5) * LASER_EFF_W;

      // entry tail fading in below the first point
      {
        const x = lx(pts[0].v), yS = yOf(pts[0].y);
        const yB = Math.max(yS - 1.0, Y0), yT = Math.min(yS, Y1);
        if (yT > yB) {
          const a = P(x, yB), b = P(x, yT);
          if (a && b) {
            const grad = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
            grad.addColorStop(0, rgba(col, 0));
            grad.addColorStop(1, rgba(col, 0.45));
            if (poly(ctx, [P(x - LW / 2, yB), P(x + LW / 2, yB), P(x + LW / 2, yT), P(x - LW / 2, yT)])) {
              ctx.fillStyle = grad; ctx.fill();
            }
          }
        }
      }

      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i], q = pts[i + 1];
        if (q.y < tMin || p.y > tMax) continue;
        const isSlam = q.y - p.y <= KSH.SLAM_TICKS;
        const prevSlam = i > 0 && p.y - pts[i - 1].y <= KSH.SLAM_TICKS;
        if (isSlam) {
          // skewed bar from -0.5H to +1.5H around the slam tick, ends widened by the body
          const H = slamH(p.y);
          const span = clampSpan(yOf(p.y) - 0.5 * H, yOf(p.y) + 1.5 * H);
          if (!span) continue;
          const xa = lx(p.v), xb = lx(q.v);
          const dir = Math.sign(xb - xa) || 1;
          const xmin = Math.min(xa, xb), xmax = Math.max(xa, xb);
          const bar = (w, skew, y0c, y1c, style) => {
            if (y1c <= y0c) return;
            if (poly(ctx, [
              P(xmin - w + skew, y0c), P(xmax + w + skew, y0c),
              P(xmax + w - skew, y1c), P(xmin - w - skew, y1c)])) {
              ctx.fillStyle = style;
              ctx.fill();
            }
          };
          const sk = dir * LW / 2;
          bar(LW / 2, sk, span[0], span[1], rgba(col, 0.18));                 // soft glow
          bar(LW / 4, sk * 0.6, span[0] + 0.08 * H, span[1] - 0.08 * H, rgba(col, 0.62)); // body
          const midY = (span[0] + span[1]) / 2, coreH = (span[1] - span[0]) * 0.16;
          bar(LW / 8, sk * 0.3, midY - coreH, midY + coreH, rgba(core, 0.7)); // bright core stripe
        } else {
          let y0 = yOf(p.y), y1 = yOf(q.y);
          if (prevSlam) y0 = yOf(pts[i - 1].y) + slamH(pts[i - 1].y); // resume above the slam bar
          if (y1 <= y0) continue;
          const span = clampSpan(y0, y1);
          if (!span) continue;
          const f0 = (span[0] - y0) / (y1 - y0), f1 = (span[1] - y0) / (y1 - y0);
          const xA = lx(p.v) + (lx(q.v) - lx(p.v)) * f0;
          const xB = lx(p.v) + (lx(q.v) - lx(p.v)) * f1;
          for (const [wf, alpha] of LAYERS) {
            const w = LW * wf;
            if (poly(ctx, [P(xA - w / 2, span[0]), P(xA + w / 2, span[0]), P(xB + w / 2, span[1]), P(xB - w / 2, span[1])])) {
              ctx.fillStyle = rgba(wf < 0.3 ? core : col, alpha);
              ctx.fill();
            }
          }
        }
      }

      // exit fade above the last point (above the bar when it ends on a slam)
      {
        const last = pts.length - 1;
        const endsSlam = pts[last].y - pts[last - 1].y <= KSH.SLAM_TICKS;
        const x = lx(pts[last].v);
        const yE = endsSlam ? yOf(pts[last - 1].y) + 1.5 * slamH(pts[last - 1].y) : yOf(pts[last].y);
        const yB = Math.max(yE, Y0), yT = Math.min(yE + 0.6, Y1);
        if (yT > yB) {
          const a = P(x, yB), b = P(x, yT);
          if (a && b) {
            const grad = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
            grad.addColorStop(0, rgba(col, 0.5));
            grad.addColorStop(1, rgba(col, 0));
            if (poly(ctx, [P(x - LW / 2, yB), P(x + LW / 2, yB), P(x + LW / 2, yT), P(x - LW / 2, yT)])) {
              ctx.fillStyle = grad; ctx.fill();
            }
          }
        }
      }
    }
  }
  ctx.globalCompositeOperation = "source-over";

  // ---- chips ----
  const CHIP_H = 0.10, FXCHIP_H = 0.12;
  for (let s = 0; s < 2; s++) {
    const x0 = -2 * BTN_W + s * 2 * BTN_W + 0.01, x1 = x0 + 2 * BTN_W - 0.02;
    for (const n of ED.chart.fx[s]) {
      if (n.l > 0 || n.y > tMax || n.y < tMin) continue;
      const y = yOf(n.y);
      if (y < Y0 || y > Y1) continue;
      if (poly(ctx, [P(x0, y), P(x1, y), P(x1, y + FXCHIP_H), P(x0, y + FXCHIP_H)])) {
        ctx.fillStyle = "#e8781e";
        ctx.fill();
        ctx.strokeStyle = "#7e430e";
        ctx.stroke();
      }
    }
  }
  for (let l = 0; l < 4; l++) {
    const x0 = -2 * BTN_W + l * BTN_W + 0.012, x1 = x0 + BTN_W - 0.024;
    for (const n of ED.chart.bt[l]) {
      if (n.l > 0 || n.y > tMax || n.y < tMin) continue;
      const y = yOf(n.y);
      if (y < Y0 || y > Y1) continue;
      if (poly(ctx, [P(x0, y), P(x1, y), P(x1, y + CHIP_H), P(x0, y + CHIP_H)])) {
        ctx.fillStyle = "#f4f4fb";
        ctx.fill();
        ctx.strokeStyle = "#9a9ab6";
        ctx.stroke();
      }
    }
  }

  // ---- crit line (own transform: rolls with actualRoll + spin wobble) ----
  {
    const C = cam.crit;
    const a = C(-TRACK_W/2 - 0.12, 0), b = C(TRACK_W/2 + 0.12, 0);
    if (a && b) {
      ctx.strokeStyle = "#ff2a48";
      ctx.lineWidth = 4;
      ctx.shadowColor = "#ff2a48";
      ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,235,240,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // ---- info overlay ----
  ctx.fillStyle = "rgba(160,160,190,0.75)";
  ctx.font = "11px 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(
    `pitch ${st.pitch.toFixed(1)}°  roll ${(st.totalRoll * 360).toFixed(1)}°  ` +
    `zoom ${st.laneZoom.toFixed(2)}  offs ${st.totalOffset.toFixed(2)}`, 8, H - 8);
}

function resetSim() { sim.lastMs = null; sim.critRoll = 0; sim.actualRoll = 0; sim.keepTarget = 0; }

return { draw, resetSim };
})();
