"use strict";
/* ============================================================
 * Editor application: state, tools, input, playback, file I/O.
 * ============================================================ */

const ED = {
  chart: null, timing: null, measures: [],
  curMs: 0, playing: false,
  zoom: 2, snapDiv: 16,
  tool: "bt",
  sel: null, hover: null,
  laserEdit: null, laserWideDefault: false,
  drag: null,
  chartVersion: 0, dirty: false,
  undoStack: [], redoStack: [],
  dirHandle: null, kshHandle: null, kshName: "", kshFiles: [],
  volMusic: 0.8, volHit: 0.7, volMet: 0.7,
  opts: { metronome: false, hitsounds: true, waveform: true, fxPreview: true },
  dom: {}, G: null,

  snapTicks() { return KSH.WHOLE_TICKS / this.snapDiv; },
  domainStartMs() { return Math.min(0, parseFloat(this.chart.meta.o) || 0); },
  domainEndMs() {
    const chartEnd = this.timing.tickToMs(KSH.endTick(this.chart) + KSH.WHOLE_TICKS * 2);
    return Math.max(AudioEng.durationMs(), chartEnd, 10000);
  },
  selNote() { return this.sel && (this.sel.type === "bt" || this.sel.type === "fx") ? this.sel.note : null; },
  selSeg() { return this.sel && (this.sel.type === "laserseg" || this.sel.type === "laserpoint") ? this.sel.seg : null; },
};

const FX_TYPES = [
  { name: "Retrigger", param: 8 }, { name: "Gate", param: 16 }, { name: "Flanger", param: null },
  { name: "PitchShift", param: 12 }, { name: "BitCrusher", param: 10 }, { name: "Phaser", param: null },
  { name: "Wobble", param: 12 }, { name: "TapeStop", param: null }, { name: "Echo", param: 4 },
  { name: "SideChain", param: null },
];
const FILTER_TYPES = ["peak", "lpf1", "hpf1", "bitc"];
const SNAP_DIVS = [4, 8, 12, 16, 24, 32, 48, 64];
const DIFFICULTIES = ["light", "challenge", "extended", "infinite"];
const SPIN_TYPES = [
  ["", "(none)"], ["@(", "Spin ←"], ["@)", "Spin →"],
  ["@<", "Half spin ←"], ["@>", "Half spin →"],
  ["S<", "Swing ←"], ["S>", "Swing →"],
];

/* ------------------------- derived state ------------------------- */

function rebuildTiming() {
  ED.timing = KSH.buildTiming(ED.chart);
  rebuildMeasures();
}
function rebuildMeasures() {
  const maxTick = Math.max(
    KSH.endTick(ED.chart),
    Math.ceil(ED.timing.msToTick(Math.max(AudioEng.durationMs(), 10000)))
  ) + KSH.WHOLE_TICKS * 8;
  ED.measures = KSH.measureList(ED.chart, maxTick);
}
let hitDirty = true;
function markEdit() {
  ED.chartVersion++; ED.dirty = true; hitDirty = true;
  rebuildMeasures(); updateTitle();
}

/* ----------------------------- undo ----------------------------- */

function pushUndo() {
  ED.undoStack.push(structuredClone(ED.chart));
  if (ED.undoStack.length > 200) ED.undoStack.shift();
  ED.redoStack.length = 0;
}
function undo() {
  if (!ED.undoStack.length) return;
  ED.redoStack.push(structuredClone(ED.chart));
  ED.chart = ED.undoStack.pop();
  afterRestore();
}
function redo() {
  if (!ED.redoStack.length) return;
  ED.undoStack.push(structuredClone(ED.chart));
  ED.chart = ED.redoStack.pop();
  afterRestore();
}
function afterRestore() {
  ED.sel = null; ED.laserEdit = null; ED.drag = null;
  rebuildTiming(); markEdit();
  syncInputsFromChart(); updateInspector();
}

/* ---------------------------- snapping ---------------------------- */

function snapTick(t) {
  const m = KSH.measureAt(ED.measures, Math.max(0, t));
  const step = ED.snapTicks();
  return Math.max(0, m.y + Math.round((t - m.y) / step) * step);
}

/* --------------------------- hit testing --------------------------- */

function hitInfo(x, y) {
  const G = ED.G || Render.geom();
  const tickRaw = G.tickOfY(y);
  const tick = snapTick(tickRaw);
  const rel = (x - G.trackX) / G.trackW;
  return {
    x, y, tickRaw, tick, rel,
    lane: Math.max(0, Math.min(3, Math.floor(rel * 4))),
    side: rel < 0.5 ? 0 : 1,
    inTrack: rel >= 0 && rel < 1,
    inWide: rel >= -0.5 && rel < 1.5,
  };
}
function laserVFrom(rel, wide) {
  let v = wide === 2 ? (rel + 0.5) / 2 : rel;
  return Math.round(Math.max(0, Math.min(1, v)) * 50) / 50;
}

function hitTest(x, y) {
  const G = ED.G || Render.geom();
  const c = ED.chart;
  const tol = 8 / G.ppt;
  const tickRaw = G.tickOfY(y);
  const rel = (x - G.trackX) / G.trackW;
  // laser points
  for (let s = 0; s < 2; s++)
    for (const seg of c.lasers[s])
      for (let i = 0; i < seg.points.length; i++) {
        const p = seg.points[i];
        if (Math.abs(G.laserX(p.v, seg.wide) - x) <= 8 && Math.abs(G.yOfTick(p.y) - y) <= 8)
          return { type: "laserpoint", side: s, seg, pt: i };
      }
  if (rel >= 0 && rel < 1) {
    const lane = Math.max(0, Math.min(3, Math.floor(rel * 4)));
    const side = rel < 0.5 ? 0 : 1;
    for (const n of c.bt[lane]) if (n.l === 0 && Math.abs(n.y - tickRaw) <= tol) return { type: "bt", lane, note: n };
    for (const n of c.fx[side]) if (n.l === 0 && Math.abs(n.y - tickRaw) <= tol) return { type: "fx", lane: side, note: n };
    for (const n of c.bt[lane]) if (n.l > 0 && tickRaw >= n.y - tol && tickRaw <= n.y + n.l + tol) return { type: "bt", lane, note: n };
    for (const n of c.fx[side]) if (n.l > 0 && tickRaw >= n.y - tol && tickRaw <= n.y + n.l + tol) return { type: "fx", lane: side, note: n };
  }
  // laser bands
  for (let s = 0; s < 2; s++)
    for (const seg of c.lasers[s]) {
      const pts = seg.points;
      if (!pts.length || tickRaw < pts[0].y || tickRaw > pts[pts.length - 1].y) continue;
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i], q = pts[i + 1];
        if (tickRaw < p.y || tickRaw > q.y) continue;
        const f = (tickRaw - p.y) / Math.max(1, q.y - p.y);
        const px = G.laserX(p.v + (q.v - p.v) * f, seg.wide);
        if (Math.abs(px - x) <= G.laneW * 0.5) return { type: "laserseg", side: s, seg };
      }
    }
  return null;
}

/* -------------------------- note editing -------------------------- */

function overlaps(a, b) {
  const a1 = a.y + Math.max(a.l, 1), b1 = b.y + Math.max(b.l, 1);
  return a.y < b1 && b.y < a1;
}
function cleanupOverlaps(arr, keep) {
  for (let i = arr.length - 1; i >= 0; i--)
    if (arr[i] !== keep && overlaps(arr[i], keep)) arr.splice(i, 1);
  arr.sort((a, b) => a.y - b.y);
}

function deleteObject(hit) {
  const c = ED.chart;
  if (hit.type === "bt") {
    const i = c.bt[hit.lane].indexOf(hit.note);
    if (i >= 0) c.bt[hit.lane].splice(i, 1);
  } else if (hit.type === "fx") {
    const i = c.fx[hit.lane].indexOf(hit.note);
    if (i >= 0) c.fx[hit.lane].splice(i, 1);
  } else if (hit.type === "laserpoint") {
    hit.seg.points.splice(hit.pt, 1);
    if (hit.seg.points.length < 2) removeSeg(hit.side, hit.seg);
  } else if (hit.type === "laserseg") {
    removeSeg(hit.side, hit.seg);
  }
}
function removeSeg(side, seg) {
  const i = ED.chart.lasers[side].indexOf(seg);
  if (i >= 0) ED.chart.lasers[side].splice(i, 1);
}

function finalizeLaser() {
  if (!ED.laserEdit) return;
  const { side, seg } = ED.laserEdit;
  ED.laserEdit = null;
  if (seg.points.length < 2) { removeSeg(side, seg); markEdit(); return; }
  seg.points.sort((a, b) => a.y - b.y);
  const first = seg.points[0].y, last = seg.points[seg.points.length - 1].y;
  const arr = ED.chart.lasers[side];
  for (let i = arr.length - 1; i >= 0; i--) {
    const o = arr[i];
    if (o === seg) continue;
    if (o.points[0].y <= last + KSH.SLAM_TICKS && o.points[o.points.length - 1].y >= first - KSH.SLAM_TICKS)
      arr.splice(i, 1);
  }
  arr.sort((a, b) => a.points[0].y - b.points[0].y);
  markEdit();
}

/* --------------------------- mouse input --------------------------- */

function mousePos(e, cv) {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onHighwayDown(e) {
  AudioEng.ensureCtx();
  const { x, y } = mousePos(e, ED.dom.highway);
  if (e.button === 2) { onRightClick(x, y); return; }
  if (e.button !== 0 || ED.playing) return;
  const h = hitInfo(x, y);
  const c = ED.chart;

  if (ED.tool === "bt" || ED.tool === "fx") {
    if (ED.laserEdit) finalizeLaser();
    if (!h.inTrack || h.tick < 0) return;
    const isFx = ED.tool === "fx";
    const arr = isFx ? c.fx[h.side] : c.bt[h.lane];
    // toggle: clicking an existing chip removes it
    const existing = arr.find(n => n.l === 0 && n.y === h.tick);
    if (existing) {
      pushUndo(); arr.splice(arr.indexOf(existing), 1);
      markEdit(); setSel(null); return;
    }
    pushUndo();
    const note = isFx ? { y: h.tick, l: 0, fx: "" } : { y: h.tick, l: 0 };
    arr.push(note);
    ED.drag = { mode: "placeNote", arr, note, startTick: h.tick };
    setSel({ type: isFx ? "fx" : "bt", lane: isFx ? h.side : h.lane, note });
  } else if (ED.tool === "laserL" || ED.tool === "laserR") {
    const side = ED.tool === "laserL" ? 0 : 1;
    if (!h.inWide || h.tick < 0) return;
    if (!ED.laserEdit) {
      pushUndo();
      const seg = { points: [], wide: ED.laserWideDefault ? 2 : 1 };
      seg.points.push({ y: h.tick, v: laserVFrom(h.rel, seg.wide) });
      c.lasers[side].push(seg);
      ED.laserEdit = { side, seg };
    } else {
      const seg = ED.laserEdit.seg;
      const pts = seg.points;
      const last = pts[pts.length - 1];
      const v = laserVFrom(h.rel, seg.wide);
      let py = h.tick;
      if (py <= last.y) py = last.y + KSH.SLAM_TICKS; // same row => slam
      if (py === last.y && v === last.v) return;
      pts.push({ y: py, v });
    }
    markEdit();
  } else if (ED.tool === "select") {
    const hit = hitTest(x, y);
    setSel(hit);
    if (!hit) return;
    const G = ED.G || Render.geom();
    if (hit.type === "bt" || hit.type === "fx") {
      const n = hit.note;
      const isFx = hit.type === "fx";
      const resize = n.l > 0 && Math.abs(G.yOfTick(n.y + n.l) - y) < 8;
      ED.drag = {
        mode: resize ? "resizeNote" : "moveNote",
        note: n, isFx, lane: hit.lane, grabbed: false,
        grabOff: snapTick(G.tickOfY(y)) - n.y,
      };
    } else if (hit.type === "laserpoint") {
      const arr = ED.chart.lasers[hit.side];
      const si = arr.indexOf(hit.seg);
      const bounds = {};
      if (hit.pt === 0 && si > 0)
        bounds.min = arr[si - 1].points[arr[si - 1].points.length - 1].y + 2 * KSH.SLAM_TICKS;
      if (hit.pt === hit.seg.points.length - 1 && si >= 0 && si + 1 < arr.length)
        bounds.max = arr[si + 1].points[0].y - 2 * KSH.SLAM_TICKS;
      ED.drag = { mode: "movePoint", seg: hit.seg, side: hit.side, idx: hit.pt, grabbed: false, bounds };
    }
  }
}

function onRightClick(x, y) {
  if (ED.playing) return;
  if (ED.laserEdit) {
    // right-click while drawing a laser: remove last point / cancel
    const seg = ED.laserEdit.seg;
    seg.points.pop();
    if (!seg.points.length) { removeSeg(ED.laserEdit.side, seg); ED.laserEdit = null; }
    markEdit();
    return;
  }
  const hit = hitTest(x, y);
  if (!hit) return;
  pushUndo();
  deleteObject(hit);
  markEdit(); setSel(null);
}

function onHighwayMove(e) {
  const { x, y } = mousePos(e, ED.dom.highway);
  updateHover(x, y);
  const d = ED.drag;
  if (!d) return;
  const G = ED.G || Render.geom();
  const h = hitInfo(x, y);

  if (d.mode === "placeNote") {
    d.note.l = Math.max(0, snapTick(G.tickOfY(y)) - d.startTick);
  } else if (d.mode === "moveNote") {
    if (!d.grabbed) { pushUndo(); d.grabbed = true; }
    const newY = Math.max(0, snapTick(G.tickOfY(y)) - d.grabOff);
    d.note.y = newY;
    // lane / side switching
    if (h.inTrack) {
      const target = d.isFx ? h.side : h.lane;
      if (target !== d.lane) {
        const from = d.isFx ? ED.chart.fx[d.lane] : ED.chart.bt[d.lane];
        const to = d.isFx ? ED.chart.fx[target] : ED.chart.bt[target];
        const i = from.indexOf(d.note);
        if (i >= 0) { from.splice(i, 1); to.push(d.note); }
        d.lane = target;
        if (ED.sel && ED.sel.note === d.note) ED.sel.lane = target;
      }
    }
  } else if (d.mode === "resizeNote") {
    if (!d.grabbed) { pushUndo(); d.grabbed = true; }
    d.note.l = Math.max(0, snapTick(G.tickOfY(y)) - d.note.y);
  } else if (d.mode === "movePoint") {
    if (!d.grabbed) { pushUndo(); d.grabbed = true; }
    const pts = d.seg.points;
    let newY = snapTick(G.tickOfY(y));
    const prev = pts[d.idx - 1], next = pts[d.idx + 1];
    if (prev) newY = Math.max(newY, prev.y + KSH.SLAM_TICKS);
    if (next) newY = Math.min(newY, next.y - KSH.SLAM_TICKS);
    if (d.bounds.min !== undefined) newY = Math.max(newY, d.bounds.min);
    if (d.bounds.max !== undefined) newY = Math.min(newY, d.bounds.max);
    pts[d.idx].y = Math.max(0, newY);
    pts[d.idx].v = laserVFrom(h.rel, d.seg.wide);
  }
}

function onHighwayUp() {
  const d = ED.drag;
  if (!d) return;
  ED.drag = null;
  if (d.mode === "placeNote") {
    cleanupOverlaps(d.arr, d.note);
    markEdit(); updateInspector();
  } else if ((d.mode === "moveNote" || d.mode === "resizeNote") && d.grabbed) {
    const arr = d.isFx ? ED.chart.fx[d.lane] : ED.chart.bt[d.lane];
    cleanupOverlaps(arr, d.note);
    markEdit(); updateInspector();
  } else if (d.mode === "movePoint" && d.grabbed) {
    d.seg.points.sort((a, b) => a.y - b.y);
    markEdit(); updateInspector();
  }
}

function updateHover(x, y) {
  const h = hitInfo(x, y);
  ED.hover = null;
  if (h.tick < 0) return;
  if (ED.tool === "bt" && h.inTrack) ED.hover = { kind: "bt", lane: h.lane, tick: h.tick };
  else if (ED.tool === "fx" && h.inTrack) ED.hover = { kind: "fx", side: h.side, tick: h.tick };
  else if ((ED.tool === "laserL" || ED.tool === "laserR") && h.inWide) {
    const side = ED.tool === "laserL" ? 0 : 1;
    const wide = ED.laserEdit ? ED.laserEdit.seg.wide : (ED.laserWideDefault ? 2 : 1);
    let tick = h.tick;
    if (ED.laserEdit) {
      const last = ED.laserEdit.seg.points[ED.laserEdit.seg.points.length - 1];
      if (last && tick <= last.y) tick = last.y + KSH.SLAM_TICKS;
    }
    ED.hover = { kind: "laser", side, v: laserVFrom(h.rel, wide), tick };
  }
}

function onHighwayWheel(e) {
  e.preventDefault();
  if (e.ctrlKey) {
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    ED.zoom = Math.max(0.4, Math.min(10, ED.zoom * f));
    ED.dom.inZoom.value = ED.zoom;
  } else {
    seekBySnap(e.deltaY < 0 ? 1 : -1);
  }
}

function seekBySnap(dir) {
  const step = ED.snapTicks();
  const curTick = ED.timing.msToTick(ED.curMs);
  const m = KSH.measureAt(ED.measures, Math.max(0, curTick));
  const rel = curTick - m.y;
  const k = dir > 0 ? Math.floor(rel / step + 1e-6) + 1 : Math.ceil(rel / step - 1e-6) - 1;
  seekToMs(ED.timing.tickToMs(m.y + k * step));
}

function seekToMs(ms) {
  ms = Math.max(ED.domainStartMs(), Math.min(ED.domainEndMs(), ms));
  ED.curMs = ms;
  if (ED.playing) { AudioEng.play(ms); resetSched(); }
}

/* --------------------------- selection --------------------------- */

function setSel(sel) { ED.sel = sel; updateInspector(); }

function deleteSelection() {
  if (!ED.sel) return;
  pushUndo();
  deleteObject(ED.sel);
  markEdit(); setSel(null);
}

/* ----------------------- FX preview plan ----------------------- */

const BUILTIN_FX = { Retrigger: 8, Gate: 16, Flanger: null, PitchShift: null, BitCrusher: null,
  Phaser: null, Wobble: 12, TapeStop: null, Echo: 4, SideChain: 4 };

// #define_fx / #define_filter lines (header or body) -> { fx: {name: {type, div}}, filter: {...} }
function parseDefines(chart) {
  const defs = { fx: {}, filter: {} };
  const scan = s => {
    const m = /^#define_(fx|filter)\s+(\S+)\s+type=([A-Za-z]+)(.*)$/.exec(s);
    if (!m) return;
    let div = null;
    const pm = /(?:updatePeriod|waveLength|period)=1\/(\d+)/.exec(m[4]);
    if (pm) div = parseInt(pm[1]);
    defs[m[1]][m[2]] = { type: m[3], div };
  };
  for (const k of chart.metaKeys) if (k.startsWith("#define_")) scan(k + "=" + (chart.meta[k] || ""));
  for (const o of chart.other) scan(o.s);
  return defs;
}

// effect string ("Retrigger;8", "ret", custom;param) -> {type, div, semi} or null
function resolveEffect(str, defs) {
  const [name, p] = (str || "").split(";");
  if (!name) return null;
  let type = null, div = null, semi = null;
  if (name in BUILTIN_FX) type = name;
  else if (defs.fx[name]) { type = defs.fx[name].type; div = defs.fx[name].div; }
  if (!type || !(type in BUILTIN_FX)) return null;
  if (p != null && p !== "") {
    const pv = parseFloat(p);
    if (isFinite(pv)) { if (type === "PitchShift") semi = pv; else if (type !== "BitCrusher") div = pv; }
  }
  if (type === "PitchShift" && semi === null) semi = 12;
  if (div === null) div = BUILTIN_FX[type] || 8;
  return { type, div, semi };
}

function buildFxRegions() {
  const defs = parseDefines(ED.chart);
  const out = [];
  for (let s = 0; s < 2; s++)
    for (const n of ED.chart.fx[s]) {
      if (!(n.l > 0) || !n.fx) continue;
      const r = resolveEffect(n.fx, defs);
      if (!r) continue;
      const bpm = ED.timing.bpmAt(n.y);
      out.push({
        t0: ED.timing.tickToMs(n.y),
        t1: ED.timing.tickToMs(n.y + n.l),
        type: r.type,
        I: 240000 / bpm / Math.max(1, r.div),
        semi: r.semi,
      });
    }
  out.sort((a, b) => a.t0 - b.t0);
  return out;
}

// current laser filter state for the follower (null when no laser under cursor)
function laserStateNow() {
  const tick = ED.timing.msToTick(ED.curMs);
  let drive = -1;
  for (let s = 0; s < 2; s++)
    for (const seg of ED.chart.lasers[s]) {
      const pts = seg.points;
      if (tick < pts[0].y || tick > pts[pts.length - 1].y) continue;
      let v = pts[0].v;
      for (let i = 0; i + 1 < pts.length; i++)
        if (tick >= pts[i].y && tick <= pts[i + 1].y) {
          const f = (tick - pts[i].y) / Math.max(1, pts[i + 1].y - pts[i].y);
          v = pts[i].v + (pts[i + 1].v - pts[i].v) * f;
          break;
        }
      const d = s === 0 ? v : 1 - v;
      if (d > drive) drive = d;
    }
  if (drive < 0) return null;
  let type = ED.chart.meta.filtertype || "peak";
  for (const f of ED.chart.filters) { if (f.y <= tick) type = f.v; else break; }
  return { drive, type };
}

/* --------------------------- playback --------------------------- */

let hitEvents = [], schedPtr = 0, metNextTick = null;

function buildHitEvents() {
  hitEvents = [];
  const c = ED.chart, t = ED.timing;
  for (const lane of c.bt) for (const n of lane) hitEvents.push({ ms: t.tickToMs(n.y), type: "bt" });
  for (const side of c.fx) for (const n of side) hitEvents.push({ ms: t.tickToMs(n.y), type: "fx" });
  for (const side of c.lasers)
    for (const seg of side)
      for (let i = 0; i + 1 < seg.points.length; i++)
        if (seg.points[i + 1].y - seg.points[i].y <= KSH.SLAM_TICKS)
          hitEvents.push({ ms: t.tickToMs(seg.points[i].y), type: "slam" });
  hitEvents.sort((a, b) => a.ms - b.ms);
  hitDirty = false;
}

function resetSched() {
  if (hitDirty) buildHitEvents();
  const pos = AudioEng.positionMs();
  schedPtr = 0;
  while (schedPtr < hitEvents.length && hitEvents[schedPtr].ms <= pos) schedPtr++;
  metNextTick = nextBeatTick(ED.timing.msToTick(pos));
  if (AudioEng.playing && ED.opts.fxPreview) FXDSP.apply(buildFxRegions(), pos);
  else FXDSP.clear();
}
function nextBeatTick(fromTick) {
  const m = KSH.measureAt(ED.measures, Math.max(0, fromTick));
  const beatTicks = KSH.WHOLE_TICKS / m.d;
  const k = Math.floor(Math.max(0, fromTick - m.y) / beatTicks) + (fromTick < m.y ? 0 : 1);
  return m.y + k * beatTicks;
}

function scheduler() {
  if (hitDirty) { buildHitEvents(); resetSched(); }
  const pos = AudioEng.positionMs();
  const horizon = pos + 180 * AudioEng.rate;
  if (ED.opts.hitsounds) {
    while (schedPtr < hitEvents.length && hitEvents[schedPtr].ms <= horizon) {
      const ev = hitEvents[schedPtr++];
      if (ev.ms >= pos - 30) AudioEng.scheduleClick(ev.type, AudioEng.msToCtxTime(ev.ms));
    }
  }
  if (ED.opts.metronome && metNextTick !== null) {
    let guard = 0;
    while (ED.timing.tickToMs(metNextTick) <= horizon && guard++ < 64) {
      const m = KSH.measureAt(ED.measures, metNextTick);
      AudioEng.scheduleClick(metNextTick === m.y ? "methi" : "metlo",
        AudioEng.msToCtxTime(ED.timing.tickToMs(metNextTick)));
      metNextTick += KSH.WHOLE_TICKS / m.d;
      const mEnd = m.y + m.ticks;
      if (metNextTick > mEnd - 1 && metNextTick !== mEnd) metNextTick = mEnd;
    }
  }
}

function togglePlay() { ED.playing ? pausePlayback() : startPlayback(); }

function startPlayback() {
  if (!AudioEng.buffer) { toast("Load a song first (File ▸ Load Audio)"); return; }
  finalizeLaser();
  applyVolumes();
  if (ED.curMs >= ED.domainEndMs() - 5) ED.curMs = ED.domainStartMs();
  AudioEng.play(ED.curMs);
  ED.playing = true;
  resetSched();
  ED.dom.btnPlay.textContent = "❚❚";
}
function pausePlayback() {
  ED.curMs = Math.min(AudioEng.positionMs(), ED.domainEndMs());
  AudioEng.stop();
  FXDSP.clear();
  FXDSP.updateLaser(null);
  ED.playing = false;
  ED.dom.btnPlay.textContent = "▶";
}

function applyVolumes() {
  const mvol = parseFloat(ED.chart.meta.mvol);
  AudioEng.setMusicVolume((isFinite(mvol) ? mvol : 75) / 100 * ED.volMusic);
  AudioEng.setClickVolume(0.8 * ED.volHit);
  AudioEng.setMetVolume(0.8 * ED.volMet);
}

/* ------------------------- render loop ------------------------- */

let lastTimeStr = "";
function frame() {
  if (ED.playing) {
    ED.curMs = AudioEng.positionMs();
    if (ED.curMs >= ED.domainEndMs()) pausePlayback();
    else {
      scheduler();
      if (ED.opts.fxPreview) FXDSP.updateLaser(laserStateNow());
    }
  }
  Render.draw();
  updateTimeDisplay();
  requestAnimationFrame(frame);
}

function fmtTime(ms) {
  const neg = ms < 0; ms = Math.abs(ms);
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return (neg ? "-" : "") + String(m).padStart(2, "0") + ":" +
    String(s % 60).padStart(2, "0") + "." + String(Math.floor(ms % 1000)).padStart(3, "0");
}
function updateTimeDisplay() {
  const tick = ED.timing.msToTick(ED.curMs);
  const m = KSH.measureAt(ED.measures, Math.max(0, tick));
  const beat = Math.floor(Math.max(0, tick - m.y) / (KSH.WHOLE_TICKS / m.d)) + 1;
  const str = fmtTime(ED.curMs) + " / " + fmtTime(ED.domainEndMs());
  const bstr = "#" + String(m.idx + 1).padStart(3, "0") + " · beat " + beat +
    " · ♩=" + KSH.fmtNum(ED.timing.bpmAt(Math.max(0, tick)));
  if (str !== lastTimeStr) { ED.dom.timeDisp.textContent = str; lastTimeStr = str; }
  ED.dom.beatDisp.textContent = bstr;
  renderEventList(m);
}

/* ---------------- events panel (current measure) ---------------- */

let evListKey = "";
function renderEventList(m) {
  const key = m.idx + "|" + ED.chartVersion;
  if (key === evListKey) return;
  evListKey = key;
  const el = ED.dom.eventList;
  el.innerHTML = "";
  const inM = e => e.y >= m.y && e.y < m.y + m.ticks;
  const rows = [];
  for (const b of ED.chart.bpms) if (b.y > 0 && inM(b))
    rows.push({ y: b.y, txt: "t=" + KSH.fmtNum(b.v), del: () => { ED.chart.bpms = ED.chart.bpms.filter(x => x !== b); rebuildTiming(); syncInputsFromChart(); } });
  for (const s of ED.chart.sigs) if (s.y > 0 && inM(s))
    rows.push({ y: s.y, txt: `beat=${s.n}/${s.d}`, del: () => { ED.chart.sigs = ED.chart.sigs.filter(x => x !== s); rebuildTiming(); } });
  for (const f of ED.chart.filters) if (inM(f))
    rows.push({ y: f.y, txt: "filtertype=" + f.v, del: () => { ED.chart.filters = ED.chart.filters.filter(x => x !== f); } });
  for (const sp of ED.chart.spins) if (inM(sp))
    rows.push({ y: sp.y, txt: "spin " + sp.s, del: () => { ED.chart.spins = ED.chart.spins.filter(x => x !== sp); } });
  for (const o of ED.chart.other) if (inM(o))
    rows.push({ y: o.y, txt: o.s, del: () => { ED.chart.other = ED.chart.other.filter(x => x !== o); } });
  rows.sort((a, b) => a.y - b.y);
  if (!rows.length) { el.className = "hint"; el.textContent = "—"; return; }
  el.className = "";
  for (const r of rows.slice(0, 24)) {
    const div = document.createElement("div");
    div.className = "evrow";
    const span = document.createElement("span");
    span.className = "evtxt";
    span.textContent = tickLabel(r.y) + "  " + r.txt;
    span.title = r.txt;
    const btn = document.createElement("button");
    btn.textContent = "×";
    btn.title = "Delete this event";
    btn.addEventListener("click", () => { pushUndo(); r.del(); markEdit(); });
    div.appendChild(span); div.appendChild(btn);
    el.appendChild(div);
  }
  if (rows.length > 24) {
    const p = document.createElement("div");
    p.className = "hint";
    p.textContent = `… +${rows.length - 24} more`;
    el.appendChild(p);
  }
}

/* --------------------------- inspector --------------------------- */

function tickLabel(y) {
  const m = KSH.measureAt(ED.measures, y);
  const beatTicks = KSH.WHOLE_TICKS / m.d;
  const beat = Math.floor((y - m.y) / beatTicks) + 1;
  const rem = (y - m.y) % beatTicks;
  return "#" + (m.idx + 1) + "." + beat + (rem ? "+" + rem + "t" : "");
}

function updateInspector() {
  const d = ED.dom;
  const sel = ED.sel;
  d.inspNone.style.display = sel ? "none" : "";
  d.inspNote.style.display = sel && (sel.type === "bt" || sel.type === "fx") ? "" : "none";
  d.inspLaser.style.display = sel && (sel.type === "laserseg" || sel.type === "laserpoint") ? "" : "none";
  if (!sel) return;

  if (sel.type === "bt" || sel.type === "fx") {
    const n = sel.note;
    const kind = sel.type === "bt" ? "BT " + "ABCD"[sel.lane] : "FX " + "LR"[sel.lane];
    d.inspNoteInfo.textContent = `${kind} ${n.l > 0 ? "hold" : "chip"} @ ${tickLabel(n.y)}` +
      (n.l > 0 ? ` · length ${n.l}t (${KSH.fmtNum(n.l / 48)} beats)` : "");
    const isFxHold = sel.type === "fx" && n.l > 0;
    d.fxEffectBox.style.display = isFxHold ? "" : "none";
    if (isFxHold) {
      const [type, param] = (n.fx || "").split(";");
      setSelectValue(d.selFxType, type || "");
      const def = FX_TYPES.find(t => t.name === type);
      const isCustom = !!type && !def;
      d.inFxParam.style.display = (def && def.param !== null) || isCustom ? "" : "none";
      d.inFxParam.value = param != null && param !== "" ? param : (def && def.param !== null ? def.param : "");
    }
  } else {
    const seg = sel.seg;
    const pts = seg.points;
    d.inspLaserInfo.textContent =
      `Laser ${sel.side === 0 ? "L" : "R"} · ${pts.length} pts · ${tickLabel(pts[0].y)} → ${tickLabel(pts[pts.length - 1].y)}` +
      (sel.type === "laserpoint" ? ` · point ${sel.pt + 1} v=${KSH.fmtNum(pts[sel.pt].v)}` : "");
    d.chkSegWide.checked = seg.wide === 2;
    const f = ED.chart.filters.find(f => f.y === pts[0].y);
    setSelectValue(d.selFilter, f ? f.v : "");
    d.spinBox.style.display = sel.type === "laserpoint" ? "" : "none";
    if (sel.type === "laserpoint") {
      const sp = ED.chart.spins.find(s => s.y === pts[sel.pt].y);
      const m = sp && /^(@\(|@\)|@<|@>|S<|S>)\s*(\d*)/.exec(sp.s);
      d.selSpin.value = m ? m[1] : "";
      d.inSpinLen.value = m && m[2] ? m[2] : 96;
    }
  }
}

// set a select's value, adding the option on the fly if it's unknown
function setSelectValue(sel, value) {
  if (value && ![...sel.options].some(o => o.value === value)) {
    const o = document.createElement("option");
    o.value = value; o.textContent = value + " (custom)";
    sel.appendChild(o);
  }
  sel.value = value;
}

function applySpin() {
  const sel = ED.sel;
  if (!sel || sel.type !== "laserpoint") return;
  const y = sel.seg.points[sel.pt].y;
  const type = ED.dom.selSpin.value;
  const len = Math.max(6, parseInt(ED.dom.inSpinLen.value) || 96);
  const cur = ED.chart.spins.find(s => s.y === y);
  const str = type ? type + len : "";
  if ((cur ? cur.s : "") === str) return;
  pushUndo();
  ED.chart.spins = ED.chart.spins.filter(s => s.y !== y);
  if (str) { ED.chart.spins.push({ y, s: str }); ED.chart.spins.sort((a, b) => a.y - b.y); }
  markEdit();
}

function applyFxEffect() {
  const n = ED.selNote();
  if (!n || ED.sel.type !== "fx" || n.l === 0) return;
  const type = ED.dom.selFxType.value;
  const def = FX_TYPES.find(t => t.name === type);
  const isCustom = !!type && !def;
  ED.dom.inFxParam.style.display = (def && def.param !== null) || isCustom ? "" : "none";
  let str = "";
  if (type) {
    str = type;
    const p = ED.dom.inFxParam.value.trim();
    if (def && def.param !== null) str += ";" + (p === "" ? def.param : p);
    else if (isCustom && p !== "") str += ";" + p;
  }
  if (str !== (n.fx || "")) {
    pushUndo();
    n.fx = str;
    markEdit(); updateInspector();
  }
}

// rebuild effect/filter dropdowns from built-ins + the chart's #define lines
function rebuildEffectOptions() {
  const d = ED.dom;
  const defs = parseDefines(ED.chart);
  const fill = (sel, noneLabel, entries) => {
    sel.innerHTML = "";
    let o = document.createElement("option");
    o.value = ""; o.textContent = noneLabel; sel.appendChild(o);
    for (const [v, label] of entries) {
      o = document.createElement("option");
      o.value = v; o.textContent = label; sel.appendChild(o);
    }
  };
  fill(d.selFxType, "(no effect)", [
    ...FX_TYPES.map(t => [t.name, t.name]),
    ...Object.entries(defs.fx).map(([n, def]) => [n, `${n} (${def.type})`]),
  ]);
  const filterNames = new Map(FILTER_TYPES.map(n => [n, n]));
  for (const [n, def] of Object.entries(defs.filter)) filterNames.set(n, `${n} (${def.type})`);
  for (const f of ED.chart.filters) if (f.v && !filterNames.has(f.v)) filterNames.set(f.v, f.v);
  fill(d.selFilter, "(keep current)", [...filterNames.entries()]);
}

function applyLaserProps() {
  const seg = ED.selSeg();
  if (!seg) return;
  pushUndo();
  seg.wide = ED.dom.chkSegWide.checked ? 2 : 1;
  const t0 = seg.points[0].y;
  const val = ED.dom.selFilter.value;
  ED.chart.filters = ED.chart.filters.filter(f => f.y !== t0);
  if (val) { ED.chart.filters.push({ y: t0, v: val }); ED.chart.filters.sort((a, b) => a.y - b.y); }
  markEdit(); updateInspector();
}

/* ---------------------------- file I/O ---------------------------- */

function toast(msg, ms = 3000) {
  const el = ED.dom.toast;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

function updateTitle() {
  const m = ED.chart.meta;
  ED.dom.songTitle.textContent =
    (m.title || "(untitled)") + (m.artist ? " — " + m.artist : "") +
    `  [${m.difficulty || "?"} ${m.level || ""}]` + (ED.dirty ? " ●" : "");
  document.title = (ED.dirty ? "● " : "") + (m.title || "KSM Editor") + " – KSM Chart Editor";
}

function syncInputsFromChart() {
  ED.dom.inBpm.value = KSH.fmtNum(ED.chart.bpms[0].v);
  ED.dom.inOffset.value = Math.round(parseFloat(ED.chart.meta.o) || 0);
}

function setChart(chart) {
  if (ED.playing) pausePlayback();
  ED.chart = chart;
  ED.undoStack = []; ED.redoStack = [];
  ED.sel = null; ED.laserEdit = null; ED.drag = null;
  ED.dirty = false; hitDirty = true;
  ED.curMs = 0;
  rebuildTiming();
  ED.chartVersion++;
  rebuildEffectOptions();
  syncInputsFromChart(); updateTitle(); updateInspector();
}

async function openFolder() {
  if (!window.showDirectoryPicker) {
    toast("Folder access needs Chrome/Edge. Use “Open .ksh” + “Load Audio” instead.");
    return;
  }
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: "readwrite" }); } catch (e) { return; }
  ED.dirHandle = dir;
  const files = [];
  for await (const [name, h] of dir.entries())
    if (h.kind === "file" && name.toLowerCase().endsWith(".ksh")) files.push({ name, handle: h });
  if (!files.length) { toast("No .ksh files in that folder"); return; }
  for (const f of files) {
    const text = await (await f.handle.getFile()).text();
    const dm = /^difficulty=(.*)$/m.exec(text), lm = /^level=(.*)$/m.exec(text);
    const diff = dm ? dm[1].trim() : "?";
    f.label = `${diff}${lm ? " Lv" + lm[1].trim() : ""} — ${f.name}`;
    f.order = DIFFICULTIES.indexOf(diff);
    if (f.order < 0) f.order = 9;
  }
  files.sort((a, b) => a.order - b.order);
  ED.kshFiles = files;
  const sel = ED.dom.selDiff;
  sel.innerHTML = "";
  files.forEach((f, i) => { const o = document.createElement("option"); o.value = i; o.textContent = f.label; sel.appendChild(o); });
  sel.style.display = "";
  await loadKshEntry(files[0]);
}

async function loadKshEntry(f) {
  if (ED.dirty && !confirm("Discard unsaved changes?")) {
    // re-select current entry in the dropdown
    const i = ED.kshFiles.findIndex(x => x.handle === ED.kshHandle);
    if (i >= 0) ED.dom.selDiff.value = i;
    return;
  }
  const text = await (await f.handle.getFile()).text();
  setChart(KSH.parse(text));
  ED.kshHandle = f.handle; ED.kshName = f.name;
  const i = ED.kshFiles.indexOf(f);
  if (i >= 0) ED.dom.selDiff.value = i;
  const m = (ED.chart.meta.m || "").split(";")[0].trim();
  if (m && ED.dirHandle) {
    if (AudioEng.fileName === m) { rebuildMeasures(); }
    else try {
      const fh = await ED.dirHandle.getFileHandle(m);
      const ab = await (await fh.getFile()).arrayBuffer();
      await AudioEng.loadArrayBuffer(ab, m);
      rebuildMeasures(); ED.chartVersion++;
      toast(`Loaded ${f.name} + ${m}`);
    } catch (e) { toast(`Audio “${m}” not found in folder — use Load Audio`); }
  }
  updateTitle();
}

async function openKshFile(file) {
  if (ED.dirty && !confirm("Discard unsaved changes?")) return;
  const text = await file.text();
  setChart(KSH.parse(text));
  ED.kshHandle = null; ED.kshName = file.name;
  ED.dom.selDiff.style.display = "none";
  const m = (ED.chart.meta.m || "").split(";")[0].trim();
  if (m && AudioEng.fileName !== m) toast(`Chart wants “${m}” — click Load Audio to pick it`);
  updateTitle();
}

async function loadAudioFile(file) {
  try {
    const ab = await file.arrayBuffer();
    await AudioEng.loadArrayBuffer(ab, file.name);
    if (!ED.chart.meta.m) { ED.chart.meta.m = file.name; ED.dirty = true; }
    rebuildMeasures(); ED.chartVersion++;
    toast(`Audio loaded: ${file.name} (${fmtTime(AudioEng.durationMs())})`);
    updateTitle();
  } catch (e) {
    toast("Could not decode that audio file");
  }
}

async function saveChart() {
  finalizeLaser();
  const text = KSH.serialize(ED.chart);
  if (ED.kshHandle && ED.kshHandle.createWritable) {
    try {
      const w = await ED.kshHandle.createWritable();
      await w.write(text); await w.close();
      ED.dirty = false; updateTitle();
      toast("Saved " + ED.kshName);
      return;
    } catch (e) { toast("Save failed — downloading instead"); }
  }
  const name = ED.kshName || ((ED.chart.meta.title || "chart") + ".ksh");
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  ED.dirty = false; updateTitle();
}

function newChart() {
  if (ED.dirty && !confirm("Discard unsaved changes?")) return;
  const c = KSH.newChart();
  if (AudioEng.fileName) c.meta.m = AudioEng.fileName;
  setChart(c);
  ED.kshHandle = null; ED.kshName = "";
  ED.dom.selDiff.style.display = "none";
  openMetaModal();
}

/* --------------------------- metadata --------------------------- */

function openMetaModal() {
  const m = ED.chart.meta, d = ED.dom;
  d.mTitle.value = m.title || ""; d.mArtist.value = m.artist || "";
  d.mEffect.value = m.effect || ""; d.mJacket.value = m.jacket || "";
  d.mDifficulty.value = DIFFICULTIES.includes(m.difficulty) ? m.difficulty : "light";
  d.mLevel.value = m.level || "1"; d.mMvol.value = m.mvol || "75";
  d.mMusic.value = m.m || "";
  d.metaModal.showModal();
}
function saveMetaModal() {
  pushUndo();
  const m = ED.chart.meta, d = ED.dom;
  m.title = d.mTitle.value; m.artist = d.mArtist.value;
  m.effect = d.mEffect.value; m.jacket = d.mJacket.value;
  m.difficulty = d.mDifficulty.value; m.level = d.mLevel.value;
  m.mvol = d.mMvol.value; m.m = d.mMusic.value;
  applyVolumes(); markEdit(); updateTitle();
  ED.dom.metaModal.close();
}

/* ------------------------------ init ------------------------------ */

function $(id) { return document.getElementById(id); }

function init() {
  const d = ED.dom;
  for (const id of ["highway", "timeline", "btnPlay", "timeDisp", "beatDisp", "songTitle", "toast",
    "inBpm", "inOffset", "inZoom", "selSnap", "selRate", "inVolMusic", "inVolHit", "inVolMet", "selDiff",
    "chkMetronome", "chkHitsounds", "chkWaveform", "chkWide", "chkFxPreview",
    "inspNone", "inspNote", "inspNoteInfo", "fxEffectBox", "selFxType", "inFxParam",
    "inspLaser", "inspLaserInfo", "chkSegWide", "selFilter", "btnDelSel",
    "spinBox", "selSpin", "inSpinLen", "eventList",
    "btnOpenFolder", "btnOpenKsh", "btnLoadAudio", "btnNew", "btnSave", "btnMeta", "btnHelp", "btnInsBpm", "btnInsSig", "btnInsCmd",
    "fileKsh", "fileAudio", "metaModal", "helpModal",
    "mTitle", "mArtist", "mEffect", "mJacket", "mDifficulty", "mLevel", "mMvol", "mMusic",
    "btnMetaSave", "btnMetaCancel"])
    d[id] = $(id);

  setChart(KSH.newChart());

  // populate selects
  for (const s of SNAP_DIVS) {
    const o = document.createElement("option");
    o.value = s; o.textContent = "1/" + s;
    d.selSnap.appendChild(o);
  }
  d.selSnap.value = ED.snapDiv;
  for (const r of [0.25, 0.5, 0.75, 1]) {
    const o = document.createElement("option");
    o.value = r; o.textContent = Math.round(r * 100) + "%";
    d.selRate.appendChild(o);
  }
  d.selRate.value = 1;
  for (const [v, label] of SPIN_TYPES) {
    const o = document.createElement("option"); o.value = v; o.textContent = label;
    d.selSpin.appendChild(o);
  }
  for (const diff of DIFFICULTIES) {
    const o = document.createElement("option"); o.value = diff; o.textContent = diff;
    d.mDifficulty.appendChild(o);
  }
  rebuildEffectOptions();

  // highway input
  const hw = d.highway;
  hw.addEventListener("mousedown", onHighwayDown);
  hw.addEventListener("dblclick", () => { finalizeLaser(); });
  window.addEventListener("mousemove", e => { if (e.target === hw || ED.drag) onHighwayMove(e); });
  window.addEventListener("mouseup", onHighwayUp);
  hw.addEventListener("mouseleave", () => { ED.hover = null; });
  hw.addEventListener("wheel", onHighwayWheel, { passive: false });
  hw.addEventListener("contextmenu", e => e.preventDefault());

  // timeline scrubbing
  const tl = d.timeline;
  let scrubbing = false;
  const tlSeek = e => {
    const { x } = mousePos(e, tl);
    const W = tl.getBoundingClientRect().width;
    const dom0 = ED.domainStartMs(), dom1 = ED.domainEndMs();
    seekToMs(dom0 + Math.max(0, Math.min(1, x / W)) * (dom1 - dom0));
  };
  tl.addEventListener("mousedown", e => { AudioEng.ensureCtx(); scrubbing = true; tlSeek(e); });
  window.addEventListener("mousemove", e => { if (scrubbing) tlSeek(e); });
  window.addEventListener("mouseup", () => { scrubbing = false; });
  tl.addEventListener("wheel", e => { e.preventDefault(); seekBySnap(e.deltaY < 0 ? 1 : -1); }, { passive: false });

  // tools
  document.querySelectorAll(".toolbtn").forEach(b => {
    b.addEventListener("click", () => setTool(b.dataset.tool));
  });

  // transport & options
  d.btnPlay.addEventListener("click", togglePlay);
  d.selRate.addEventListener("change", () => {
    AudioEng.setRate(parseFloat(d.selRate.value));
    if (ED.playing) { AudioEng.play(ED.curMs = AudioEng.positionMs()); resetSched(); }
  });
  d.inVolMusic.addEventListener("input", () => { ED.volMusic = parseFloat(d.inVolMusic.value); applyVolumes(); });
  d.inVolHit.addEventListener("input", () => { ED.volHit = parseFloat(d.inVolHit.value); applyVolumes(); });
  d.inVolMet.addEventListener("input", () => { ED.volMet = parseFloat(d.inVolMet.value); applyVolumes(); });
  d.selSnap.addEventListener("change", () => { ED.snapDiv = parseInt(d.selSnap.value); });
  d.inZoom.addEventListener("input", () => { ED.zoom = parseFloat(d.inZoom.value); });
  d.chkMetronome.addEventListener("change", () => { ED.opts.metronome = d.chkMetronome.checked; if (ED.playing) resetSched(); });
  d.chkHitsounds.addEventListener("change", () => { ED.opts.hitsounds = d.chkHitsounds.checked; });
  d.chkWaveform.addEventListener("change", () => { ED.opts.waveform = d.chkWaveform.checked; });
  d.chkFxPreview.addEventListener("change", () => {
    ED.opts.fxPreview = d.chkFxPreview.checked;
    if (!ED.opts.fxPreview) FXDSP.updateLaser(null);
    if (ED.playing) resetSched();
  });
  d.chkWide.addEventListener("change", () => { ED.laserWideDefault = d.chkWide.checked; });

  // timing inputs
  d.inBpm.addEventListener("change", () => {
    const v = parseFloat(d.inBpm.value);
    if (!isFinite(v) || v <= 0) { syncInputsFromChart(); return; }
    pushUndo();
    ED.chart.bpms[0].v = v;
    rebuildTiming(); markEdit();
  });
  d.inOffset.addEventListener("change", () => {
    const v = parseFloat(d.inOffset.value);
    if (!isFinite(v)) { syncInputsFromChart(); return; }
    pushUndo();
    ED.chart.meta.o = String(Math.round(v));
    rebuildTiming(); markEdit();
  });
  d.btnInsBpm.addEventListener("click", () => {
    const tick = snapTick(ED.timing.msToTick(ED.curMs));
    const cur = ED.timing.bpmAt(Math.max(0, tick));
    const val = prompt(`BPM change at ${tickLabel(Math.max(0, tick))}:`, KSH.fmtNum(cur));
    if (val === null) return;
    const v = parseFloat(val);
    if (!isFinite(v) || v <= 0) { toast("Invalid BPM"); return; }
    pushUndo();
    ED.chart.bpms = ED.chart.bpms.filter(b => b.y !== tick || tick === 0);
    if (tick === 0) ED.chart.bpms[0].v = v;
    else { ED.chart.bpms.push({ y: tick, v }); ED.chart.bpms.sort((a, b) => a.y - b.y); }
    rebuildTiming(); markEdit(); syncInputsFromChart();
  });
  d.btnInsSig.addEventListener("click", () => {
    const tick = ED.timing.msToTick(ED.curMs);
    const m = KSH.measureAt(ED.measures, Math.max(0, tick));
    const val = prompt(`Time signature from measure ${m.idx + 1}:`, m.n + "/" + m.d);
    if (val === null) return;
    const mm = /^(\d+)\s*\/\s*(\d+)$/.exec(val.trim());
    if (!mm) { toast("Enter a signature like 4/4 or 7/8"); return; }
    const n = parseInt(mm[1]), dd = parseInt(mm[2]);
    if (n < 1 || n > 256 || dd < 1 || (KSH.WHOLE_TICKS * n) % dd !== 0) {
      toast("Unsupported signature (denominator must divide 192·n)"); return;
    }
    pushUndo();
    // preserve each sig change's measure INDEX while the grid shifts
    const byIdx = new Map();
    for (const s of ED.chart.sigs) byIdx.set(KSH.measureAt(ED.measures, s.y).idx, { n: s.n, d: s.d });
    byIdx.set(m.idx, { n, d: dd });
    const maxIdx = Math.max(...byIdx.keys());
    const sigs = [];
    let t = 0, cn = 4, cd = 4;
    for (let i = 0; i <= maxIdx; i++) {
      const ch = byIdx.get(i);
      if (ch && (ch.n !== cn || ch.d !== cd || i === 0)) { cn = ch.n; cd = ch.d; sigs.push({ y: t, n: cn, d: cd }); }
      else if (ch) { cn = ch.n; cd = ch.d; }
      t += Math.round(KSH.WHOLE_TICKS * cn / cd);
    }
    if (!sigs.length || sigs[0].y > 0) sigs.unshift({ y: 0, n: 4, d: 4 });
    ED.chart.sigs = sigs;
    rebuildTiming(); markEdit();
    toast(`Measure ${m.idx + 1} onward: ${n}/${dd}`);
  });
  d.btnInsCmd.addEventListener("click", () => {
    const tick = Math.max(0, snapTick(ED.timing.msToTick(ED.curMs)));
    const line = prompt(
      "Chart command to insert at " + tickLabel(tick) +
      "\nExamples: zoom_top=100 · zoom_bottom=-50 · zoom_side=30 · tilt=normal · stop=192");
    if (line === null) return;
    const s = line.trim();
    if (!s || /^[0-2]{4}\|/.test(s)) { toast("That is not a command line"); return; }
    const eq = s.indexOf("=");
    const key = eq > 0 ? s.slice(0, eq) : "";
    if (key === "beat") { toast("Use +Sig for time signatures"); return; }
    if (key === "fx-l" || key === "fx-r" || key.startsWith("laserrange")) { toast("Use the Inspector for that"); return; }
    pushUndo();
    if (key === "t") {
      const v = parseFloat(s.slice(eq + 1));
      if (isFinite(v) && v > 0) {
        ED.chart.bpms = ED.chart.bpms.filter(b => b.y !== tick || tick === 0);
        if (tick === 0) ED.chart.bpms[0].v = v;
        else { ED.chart.bpms.push({ y: tick, v }); ED.chart.bpms.sort((a, b) => a.y - b.y); }
        rebuildTiming(); syncInputsFromChart();
      }
    } else if (key === "filtertype") {
      ED.chart.filters = ED.chart.filters.filter(f => f.y !== tick);
      ED.chart.filters.push({ y: tick, v: s.slice(eq + 1) });
      ED.chart.filters.sort((a, b) => a.y - b.y);
    } else {
      ED.chart.other.push({ y: tick, s });
      ED.chart.other.sort((a, b) => a.y - b.y);
    }
    markEdit();
  });

  // inspector
  d.selFxType.addEventListener("change", applyFxEffect);
  d.inFxParam.addEventListener("change", applyFxEffect);
  d.chkSegWide.addEventListener("change", applyLaserProps);
  d.selFilter.addEventListener("change", applyLaserProps);
  d.selSpin.addEventListener("change", applySpin);
  d.inSpinLen.addEventListener("change", applySpin);
  d.btnDelSel.addEventListener("click", deleteSelection);

  // files
  d.btnOpenFolder.addEventListener("click", openFolder);
  d.btnOpenKsh.addEventListener("click", () => d.fileKsh.click());
  d.fileKsh.addEventListener("change", () => { if (d.fileKsh.files[0]) openKshFile(d.fileKsh.files[0]); d.fileKsh.value = ""; });
  d.btnLoadAudio.addEventListener("click", () => d.fileAudio.click());
  d.fileAudio.addEventListener("change", () => { if (d.fileAudio.files[0]) loadAudioFile(d.fileAudio.files[0]); d.fileAudio.value = ""; });
  d.btnNew.addEventListener("click", newChart);
  d.btnSave.addEventListener("click", saveChart);
  d.selDiff.addEventListener("change", () => loadKshEntry(ED.kshFiles[parseInt(d.selDiff.value)]));
  d.btnMeta.addEventListener("click", openMetaModal);
  d.btnHelp.addEventListener("click", () => d.helpModal.showModal());
  d.btnMetaSave.addEventListener("click", e => { e.preventDefault(); saveMetaModal(); });
  d.btnMetaCancel.addEventListener("click", e => { e.preventDefault(); d.metaModal.close(); });

  // drag & drop
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", async e => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) {
      if (f.name.toLowerCase().endsWith(".ksh")) await openKshFile(f);
      else if (/\.(ogg|mp3|wav|flac|m4a)$/i.test(f.name)) await loadAudioFile(f);
    }
  });

  // keyboard
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("beforeunload", e => { if (ED.dirty) { e.preventDefault(); e.returnValue = ""; } });

  updateInspector();
  requestAnimationFrame(frame);
}

function setTool(tool) {
  if (ED.laserEdit && tool !== ED.tool) finalizeLaser();
  ED.tool = tool;
  document.querySelectorAll(".toolbtn").forEach(b =>
    b.classList.toggle("active", b.dataset.tool === tool));
}

function onKeyDown(e) {
  if (document.querySelector("dialog[open]")) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    if (e.key === "Escape") document.activeElement.blur();
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (ctrl && e.key.toLowerCase() === "s") { e.preventDefault(); saveChart(); return; }
  switch (e.key) {
    case " ": e.preventDefault(); togglePlay(); break;
    case "ArrowUp": e.preventDefault(); seekBySnap(1); break;
    case "ArrowDown": e.preventDefault(); seekBySnap(-1); break;
    case "PageUp": { e.preventDefault();
      const t = ED.timing.msToTick(ED.curMs);
      const m = KSH.measureAt(ED.measures, Math.max(0, t));
      seekToMs(ED.timing.tickToMs(m.y + m.ticks)); break; }
    case "PageDown": { e.preventDefault();
      const t = ED.timing.msToTick(ED.curMs);
      const m = KSH.measureAt(ED.measures, Math.max(0, t));
      const target = t - m.y > 1 ? m.y : (m.idx > 0 ? ED.measures[m.idx - 1].y : 0);
      seekToMs(ED.timing.tickToMs(target)); break; }
    case "Home": e.preventDefault(); seekToMs(ED.domainStartMs()); break;
    case "End": e.preventDefault(); seekToMs(ED.timing.tickToMs(KSH.endTick(ED.chart))); break;
    case "1": setTool("select"); break;
    case "2": setTool("bt"); break;
    case "3": setTool("fx"); break;
    case "4": setTool("laserL"); break;
    case "5": setTool("laserR"); break;
    case "Delete": case "Backspace": e.preventDefault(); deleteSelection(); break;
    case "Enter": if (ED.laserEdit) { e.preventDefault(); finalizeLaser(); } break;
    case "Escape":
      if (ED.laserEdit) finalizeLaser();
      else setSel(null);
      break;
  }
}

document.addEventListener("DOMContentLoaded", init);
