"use strict";
/* ============================================================
 * Editor application: state, tools, input, playback, file I/O.
 * ============================================================ */

const ED = {
  chart: null, timing: null, measures: [],
  curMs: 0, playing: false,
  zoom: 2, snapDiv: 16,
  viewMode: "split",
  edSpeed: 1, hispeed: 1, // editor / game view lane speeds (zoom = 2 * edSpeed)
  tool: "bt",
  sel: null, selList: [], hover: null,
  laserEdit: null,
  drag: null,
  chartVersion: 0, dirty: false,
  undoStack: [], redoStack: [],
  dirHandle: null, kshHandle: null, kshName: "", kshFiles: [], audioRaw: null,
  volMusic: 0.8, volHit: 0.7, volMet: 0.7,
  opts: { metronome: false, hitsounds: true },
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

/* ------------------------ user preferences ------------------------ */

const PREFS_KEY = "ksm-editor-prefs";

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      snapDiv: ED.snapDiv,
      edSpeed: ED.edSpeed,
      gameSpeed: ED.hispeed,
      viewMode: ED.viewMode,
      rate: AudioEng.rate,
      volMusic: ED.volMusic, volHit: ED.volHit, volMet: ED.volMet,
      opts: ED.opts,
    }));
  } catch (e) { /* storage unavailable */ }
}

function loadPrefs() {
  let p;
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch (e) { return; }
  const vol = v => (isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
  if (SNAP_DIVS.includes(p.snapDiv)) ED.snapDiv = p.snapDiv;
  const spd = v => (isFinite(v) && v >= 0.1 && v <= 100 ? v : null);
  const es = spd(p.edSpeed) || spd(p.hispeed); // p.hispeed: pre-split prefs
  const gs = spd(p.gameSpeed) || spd(p.hispeed);
  if (es) { ED.edSpeed = es; ED.zoom = 2 * es; }
  if (gs) ED.hispeed = gs;
  if (["editor", "split", "game"].includes(p.viewMode)) ED.viewMode = p.viewMode;
  if ([0.25, 0.5, 0.75, 1].includes(p.rate)) AudioEng.rate = p.rate;
  if (vol(p.volMusic) !== null) ED.volMusic = vol(p.volMusic);
  if (vol(p.volHit) !== null) ED.volHit = vol(p.volHit);
  if (vol(p.volMet) !== null) ED.volMet = vol(p.volMet);
  if (p.opts && typeof p.opts === "object")
    for (const k of Object.keys(ED.opts))
      if (typeof p.opts[k] === "boolean") ED.opts[k] = p.opts[k];
}

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
  ED.sel = null; ED.selList = []; ED.laserEdit = null; ED.drag = null;
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

// clearly outside the track => the laser must be 2x wide to reach there
const relOutside = rel => rel < -0.05 || rel > 1.05;

// convert a segment between 1x and 2x range, keeping points visually in place
function setSegWide(seg, wide) {
  if (seg.wide === wide) return;
  seg.wide = wide;
  for (const p of seg.points)
    p.v = wide === 2
      ? Math.round((p.v + 0.5) / 2 * 50) / 50
      : Math.round(Math.max(0, Math.min(1, p.v * 2 - 0.5)) * 50) / 50;
}

// cycle=true (selection clicks): when the nearest laser point is already
// selected, return the next point stacked under the cursor instead — that is
// what makes overlapping points (slam ends, clustered points at low lane
// speed) individually selectable by clicking again.
function hitTest(x, y, cycle = false) {
  const G = ED.G || Render.geom();
  const c = ED.chart;
  const tol = 8 / G.ppt;
  const tickRaw = G.tickOfY(y);
  const rel = (x - G.trackX) / G.trackW;
  // laser points: gather every candidate under the cursor, nearest first
  const cands = [];
  for (let s = 0; s < 2; s++)
    for (const seg of c.lasers[s])
      for (let i = 0; i < seg.points.length; i++) {
        const p = seg.points[i];
        const dx = G.laserX(p.v, seg.wide) - x, dy = G.yOfTick(p.y) - y;
        if (Math.abs(dx) <= 8 && Math.abs(dy) <= 8)
          cands.push({ d: dx * dx + dy * dy, hit: { type: "laserpoint", side: s, seg, pt: i } });
      }
  if (cands.length) {
    cands.sort((a, b) => a.d - b.d);
    if (cycle && cands.length > 1) {
      const unsel = cands.find(cd => !ED.selList.some(s => sameSel(s, cd.hit)));
      if (unsel && ED.selList.some(s => sameSel(s, cands[0].hit))) return unsel.hit;
    }
    return cands[0].hit;
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
  const { side, seg, basePts = 0 } = ED.laserEdit;
  ED.laserEdit = null;
  if (seg.points.length < 2) { removeSeg(side, seg); markEdit(); return; }
  if (basePts > 0 && seg.points.length === basePts) return; // resumed laser, nothing added
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
      // clicking the end point of an existing laser continues that laser —
      // starting a new one there would overlap and replace it on finalize
      const G = ED.G || Render.geom();
      const resume = c.lasers[side].find(s => {
        const p = s.points[s.points.length - 1];
        return Math.abs(G.laserX(p.v, s.wide) - x) <= 10 && Math.abs(G.yOfTick(p.y) - y) <= 10;
      });
      if (resume) {
        pushUndo();
        ED.laserEdit = { side, seg: resume, basePts: resume.points.length };
        return;
      }
      pushUndo();
      const seg = { points: [], wide: relOutside(h.rel) ? 2 : 1 };
      seg.points.push({ y: h.tick, v: laserVFrom(h.rel, seg.wide) });
      c.lasers[side].push(seg);
      ED.laserEdit = { side, seg };
    } else {
      const seg = ED.laserEdit.seg;
      if (relOutside(h.rel)) setSegWide(seg, 2); // reaches outside the track
      const pts = seg.points;
      const last = pts[pts.length - 1];
      const v = laserVFrom(h.rel, seg.wide);
      let py = h.tick;
      if (py <= last.y) py = last.y + KSH.SLAM_TICKS; // same row => slam
      if (py === last.y && v === last.v) return;
      pts.push({ y: py, v });
    }
    markEdit();
  } else if (ED.tool === "remove") {
    const hit = hitTest(x, y);
    if (!hit) return;
    pushUndo();
    deleteObject(hit);
    pruneSel();
    markEdit(); updateInspector();
  } else if (ED.tool === "select") {
    const hit = hitTest(x, y, true); // cycle through stacked laser points
    const add = e.shiftKey;
    const wasInGroup = hit && ED.selList.some(s => sameSel(s, hit));
    setSel(hit, add);
    if (!hit || add) return; // shift-click only toggles membership
    const G = ED.G || Render.geom();
    if (hit.type === "bt" || hit.type === "fx") {
      if (ED.selList.length > 1) {
        // drag moves every selected note together (tick delta only)
        const items = ED.selList
          .filter(s => s.type === "bt" || s.type === "fx")
          .map(s => ({ s, origY: s.note.y }));
        ED.drag = {
          mode: "moveMulti", items, grabbed: false,
          grabTick: snapTick(G.tickOfY(y)),
          collapseTo: wasInGroup ? hit : null,
        };
        return;
      }
      const n = hit.note;
      const isFx = hit.type === "fx";
      const resize = n.l > 0 && Math.abs(G.yOfTick(n.y + n.l) - y) < 8;
      ED.drag = {
        mode: resize ? "resizeNote" : "moveNote",
        note: n, isFx, lane: hit.lane, grabbed: false,
        grabOff: snapTick(G.tickOfY(y)) - n.y,
      };
    } else if (hit.type === "laserpoint" && ED.selList.length === 1) {
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
    // right-click while drawing a laser: remove last point / cancel.
    // On a resumed laser only the added points are removable — never the
    // points the laser already had.
    const { side, seg, basePts = 0 } = ED.laserEdit;
    if (seg.points.length > basePts) seg.points.pop();
    if (!seg.points.length) { removeSeg(side, seg); ED.laserEdit = null; }
    else if (seg.points.length <= basePts) ED.laserEdit = null; // back to the original laser
    markEdit();
    return;
  }
  const hit = hitTest(x, y);
  if (!hit) return;
  // right-click on a member of a multi-selection deletes the whole selection
  if (ED.selList.length > 1 && ED.selList.some(s => sameSel(s, hit))) {
    deleteSelection();
    return;
  }
  pushUndo();
  deleteObject(hit);
  pruneSel();
  markEdit(); updateInspector();
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
  } else if (d.mode === "moveMulti") {
    if (!d.grabbed) { pushUndo(); d.grabbed = true; }
    const delta = snapTick(G.tickOfY(y)) - d.grabTick;
    for (const it of d.items) it.s.note.y = Math.max(0, it.origY + delta);
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
    if (relOutside(h.rel)) setSegWide(d.seg, 2); // dragged outside the track
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
  } else if (d.mode === "moveMulti") {
    if (d.grabbed) {
      for (const it of d.items) {
        const arr = it.s.type === "fx" ? ED.chart.fx[it.s.lane] : ED.chart.bt[it.s.lane];
        cleanupOverlaps(arr, it.s.note);
      }
      pruneSel();
      markEdit(); updateInspector();
    } else if (d.collapseTo) {
      // plain click on a group member without dragging: collapse to it
      ED.selList = [d.collapseTo];
      ED.sel = d.collapseTo;
      updateInspector();
    }
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
    const wide = relOutside(h.rel) ? 2 : (ED.laserEdit ? ED.laserEdit.seg.wide : 1);
    let tick = h.tick;
    if (ED.laserEdit) {
      const last = ED.laserEdit.seg.points[ED.laserEdit.seg.points.length - 1];
      if (last && tick <= last.y) tick = last.y + KSH.SLAM_TICKS;
    }
    ED.hover = { kind: "laser", side, v: laserVFrom(h.rel, wide), tick, wide };
  }
}

function onHighwayWheel(e) {
  e.preventDefault();
  if (e.ctrlKey) {
    setEditorSpeed(ED.edSpeed * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
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
  GameView.resetSim();
}

function setViewMode(mode) {
  ED.viewMode = mode;
  ED.dom.highwayWrap.className = "view-" + mode;
  ED.dom.btnView.textContent = "View: " + mode[0].toUpperCase() + mode.slice(1) + " ▾";
  ED.dom.viewMenu.querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.view === mode));
  savePrefs();
}

// separate lane speeds: editor px/tick (zoom) and game view scroll
function setEditorSpeed(v) {
  if (!isFinite(v)) { ED.dom.inLaneSpeed.value = ED.edSpeed; return; }
  v = Math.max(0.1, Math.min(100, v));
  ED.edSpeed = v;
  ED.zoom = 2 * v;
  ED.dom.inLaneSpeed.value = Math.round(v * 100) / 100;
  savePrefs();
}
function setGameSpeed(v) {
  if (!isFinite(v)) { ED.dom.inGameSpeed.value = ED.hispeed; return; }
  v = Math.max(0.1, Math.min(100, v));
  ED.hispeed = v;
  ED.dom.inGameSpeed.value = Math.round(v * 100) / 100;
  savePrefs();
}

/* --------------------------- selection --------------------------- */

function sameSel(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === "bt" || a.type === "fx") return a.note === b.note;
  if (a.type === "laserseg") return a.seg === b.seg;
  if (a.type === "laserpoint") return a.seg === b.seg && a.pt === b.pt;
  return false;
}

// add=true (shift): toggle membership. add=false: replace selection,
// except clicking an already-selected object keeps the group (for dragging).
function setSel(sel, add = false) {
  if (!sel) {
    if (!add) { ED.selList = []; ED.sel = null; }
  } else if (add) {
    const i = ED.selList.findIndex(s => sameSel(s, sel));
    if (i >= 0) {
      ED.selList.splice(i, 1);
      ED.sel = ED.selList[ED.selList.length - 1] || null;
    } else {
      ED.selList.push(sel);
      ED.sel = sel;
    }
  } else {
    const i = ED.selList.findIndex(s => sameSel(s, sel));
    if (i >= 0) ED.sel = ED.selList[i];
    else { ED.selList = [sel]; ED.sel = sel; }
  }
  updateInspector();
}

// drop selection entries whose objects no longer exist in the chart
function pruneSel() {
  const c = ED.chart;
  ED.selList = ED.selList.filter(s => {
    if (s.type === "bt") return c.bt[s.lane].includes(s.note);
    if (s.type === "fx") return c.fx[s.lane].includes(s.note);
    if (s.type === "laserseg") return c.lasers[s.side].includes(s.seg);
    if (s.type === "laserpoint") return c.lasers[s.side].includes(s.seg) && s.pt < s.seg.points.length;
    return false;
  });
  if (ED.sel && !ED.selList.some(s => sameSel(s, ED.sel)))
    ED.sel = ED.selList[ED.selList.length - 1] || null;
}

function deleteSelection() {
  if (!ED.selList.length) return;
  pushUndo();
  // laser points per segment, highest index first so indices stay valid
  const bySeg = new Map();
  for (const s of ED.selList) {
    if (s.type !== "laserpoint") continue;
    if (!bySeg.has(s.seg)) bySeg.set(s.seg, { side: s.side, idxs: [] });
    bySeg.get(s.seg).idxs.push(s.pt);
  }
  for (const [seg, info] of bySeg) {
    info.idxs.sort((a, b) => b - a);
    for (const i of info.idxs) seg.points.splice(i, 1);
    if (seg.points.length < 2) removeSeg(info.side, seg);
  }
  for (const s of ED.selList)
    if (s.type !== "laserpoint") deleteObject(s);
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
  if (AudioEng.playing) FXDSP.apply(buildFxRegions(), pos);
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
  // laser slams always play; BT/FX ticks only when hitsounds are enabled
  while (schedPtr < hitEvents.length && hitEvents[schedPtr].ms <= horizon) {
    const ev = hitEvents[schedPtr++];
    if (ev.ms < pos - 30) continue;
    if (ev.type === "slam" || ED.opts.hitsounds)
      AudioEng.scheduleClick(ev.type, AudioEng.msToCtxTime(ev.ms));
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
  if (!AudioEng.buffer) { toast("Load a song first (drag & drop an audio file)"); return; }
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
      FXDSP.updateLaser(laserStateNow());
    }
  }
  Render.draw();
  if (ED.viewMode !== "editor") GameView.draw();
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

/* ---------------------------- bookmarks ---------------------------- */
// stored as "//bm:<name>" comment lines in chart.other — saved in the
// .ksh file, ignored by the game

const isBookmark = o => o.s.startsWith("//bm:");

function toggleBookmark() {
  const tick = Math.max(0, snapTick(ED.timing.msToTick(ED.curMs)));
  const existing = ED.chart.other.find(o => o.y === tick && isBookmark(o));
  pushUndo();
  if (existing) {
    ED.chart.other = ED.chart.other.filter(o => o !== existing);
    toast("Bookmark removed");
  } else {
    ED.chart.other.push({ y: tick, s: "//bm:" });
    ED.chart.other.sort((a, b) => a.y - b.y);
    toast("Bookmark added at " + tickLabel(tick) + " — rename it in the Events panel");
  }
  markEdit();
}

function jumpBookmark(dir) {
  const tick = ED.timing.msToTick(ED.curMs);
  const bms = ED.chart.other.filter(isBookmark);
  const target = dir > 0
    ? bms.find(o => o.y > tick + 1)
    : [...bms].reverse().find(o => o.y < tick - 1);
  if (target) seekToMs(ED.timing.tickToMs(target.y));
  else toast("No bookmark " + (dir > 0 ? "ahead" : "behind"));
}

/* ---------------- events panel (current measure) ---------------- */

// key -> [badge, explanation] for raw commands; also used by the help modal
const EVENT_INFO = {
  t: ["BPM", "Tempo change from this point on."],
  beat: ["Time sig", "Time signature — sets the measure length from this measure."],
  filtertype: ["Filter", "Filter sound applied to the song while a laser moves (peak / lpf1 / hpf1 / bitc or a #define_filter name)."],
  zoom_top: ["Cam pitch", "Camera: pitches the far end of the track up/down. Values interpolate between keyframes."],
  zoom_bottom: ["Cam zoom", "Camera: zooms toward (+) / away from (−) the track. Values interpolate between keyframes."],
  zoom_side: ["Cam shift", "Camera: shifts the track sideways. Values interpolate between keyframes."],
  tilt: ["Tilt", "Track roll. normal / bigger / biggest / zero set how strongly lasers tilt the track, keep_* holds the tilt; a number is manual roll (1 ≈ −10°) that interpolates to the next number."],
  stop: ["Stop", "Freezes track scrolling for N/192 of a measure while the music keeps playing."],
  center_split: ["Split", "Splits the track down the middle, pushing the halves apart."],
  lane_toggle: ["Lane hide", "Fades the track out/in over N/192 of a measure."],
  "fx-l_se": ["FX sample", "Custom hit sample for left FX chips."],
  "fx-r_se": ["FX sample", "Custom hit sample for right FX chips."],
};
const SPIN_LABEL = { "@(": "Spin ←", "@)": "Spin →", "@<": "Half spin ←", "@>": "Half spin →", "S<": "Swing ←", "S>": "Swing →" };

// apply(v) must validate before mutating and return false when invalid
const promptEdit = (label, cur, apply) => {
  const val = prompt(label, cur);
  if (val === null || val.trim() === "" || val.trim() === cur) return;
  pushUndo();
  if (apply(val.trim()) === false) { ED.undoStack.pop(); return; }
  markEdit();
};

// time-signature change from the measure containing `tick` — measure-aligned,
// keeping every later sig change on its measure index while the grid shifts
function applySigChange(tick, n, dd) {
  if (!(n >= 1) || n > 256 || !(dd >= 1) || (KSH.WHOLE_TICKS * n) % dd !== 0) {
    toast("Unsupported signature (denominator must divide 192·n)"); return false;
  }
  const m = KSH.measureAt(ED.measures, Math.max(0, tick));
  pushUndo();
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
  return true;
}

// apply one parsed command at `tick`; returns true when applied
function applyEventCommand(tick, key, val) {
  if (key === "t") {
    const v = parseFloat(val);
    if (!isFinite(v) || v <= 0) { toast("Invalid BPM"); return false; }
    pushUndo();
    ED.chart.bpms = ED.chart.bpms.filter(b => b.y !== tick || tick === 0);
    if (tick === 0) ED.chart.bpms[0].v = v;
    else { ED.chart.bpms.push({ y: tick, v }); ED.chart.bpms.sort((a, b) => a.y - b.y); }
    rebuildTiming(); syncInputsFromChart(); markEdit();
    return true;
  }
  if (key === "beat") {
    const mm = /^(\d+)\s*\/\s*(\d+)$/.exec(String(val).trim());
    if (!mm) { toast("Enter a signature like 7/8"); return false; }
    return applySigChange(tick, parseInt(mm[1]), parseInt(mm[2]));
  }
  if (key === "filtertype") {
    if (!val) { toast("Pick a filter type"); return false; }
    pushUndo();
    ED.chart.filters = ED.chart.filters.filter(f => f.y !== tick);
    ED.chart.filters.push({ y: tick, v: val });
    ED.chart.filters.sort((a, b) => a.y - b.y);
    markEdit();
    return true;
  }
  if (key === "fx-l" || key === "fx-r" || key.startsWith("laserrange")) {
    toast("Use the Inspector for that"); return false;
  }
  pushUndo();
  ED.chart.other.push({ y: tick, s: val === "" ? key : key + "=" + val });
  ED.chart.other.sort((a, b) => a.y - b.y);
  markEdit();
  return true;
}

/* ---------------- add-event dialog ---------------- */

// every body command the format knows; `row` picks the value control.
// FX effects, laser range and spins are Inspector-only; anything else
// goes through "Custom command…" and is kept verbatim.
const EV_KINDS = [
  { key: "t", label: "BPM change", row: "num", vlabel: "BPM", min: 0.001, step: "0.001",
    expl: "Tempo change from this point on.",
    init: t => { ED.dom.inEvNum.value = KSH.fmtNum(ED.timing.bpmAt(t)); } },
  { key: "beat", label: "Time signature", row: "sig",
    expl: "Sets the measure length, applied from the measure containing the cursor. The denominator must divide 192·n (4/4, 7/8, 5/16, …).",
    init: t => { const m = KSH.measureAt(ED.measures, t); ED.dom.inEvSigN.value = m.n; ED.dom.inEvSigD.value = m.d; } },
  { key: "filtertype", label: "Laser filter", row: "choice", vlabel: "Filter",
    expl: "Filter sound applied to the song while a laser moves: peak (wah), lpf1 (low-pass), hpf1 (high-pass), bitc (bitcrush), or a #define_filter name from the chart.",
    init: t => {
      fillSelect(ED.dom.selEvChoice, filterNameEntries());
      let cur = ED.chart.meta.filtertype || "peak";
      for (const f of ED.chart.filters) { if (f.y <= t) cur = f.v; else break; }
      setSelectValue(ED.dom.selEvChoice, cur);
    } },
  { key: "zoom_top", label: "Camera pitch (zoom_top)", row: "num", vlabel: "Amount", step: "1",
    expl: "Tips the far end of the track down (+) or up (−). The value interpolates linearly to the next zoom_top keyframe.",
    init: () => { ED.dom.inEvNum.value = 0; } },
  { key: "zoom_bottom", label: "Camera zoom (zoom_bottom)", row: "num", vlabel: "Amount", step: "1",
    expl: "Pulls the camera away from the track (−) or pushes it in (+). Interpolates to the next zoom_bottom keyframe.",
    init: () => { ED.dom.inEvNum.value = 0; } },
  { key: "zoom_side", label: "Camera shift (zoom_side)", row: "num", vlabel: "Amount", step: "1",
    expl: "Slides the track sideways. Interpolates to the next zoom_side keyframe.",
    init: () => { ED.dom.inEvNum.value = 0; } },
  { key: "tilt", label: "Tilt", row: "tilt", vlabel: "Roll",
    expl: "Track roll. normal / bigger / biggest / zero set how strongly the lasers tilt the track; keep_* holds the current tilt. Manual roll is a number (1 ≈ −10°) that interpolates to the next numeric tilt.",
    init: () => {
      fillSelect(ED.dom.selEvChoice, [
        ...["normal", "bigger", "biggest", "zero", "keep_normal", "keep_bigger", "keep_biggest"].map(k => [k, k]),
        ["__num", "manual roll (number)…"],
      ]);
      ED.dom.inEvNum.value = 1;
    } },
  { key: "stop", label: "Stop", row: "num", vlabel: "Length", min: 1, step: "6",
    expl: "Freezes track scrolling for N/192 of a measure (192 = one full 4/4 measure) while the music keeps playing.",
    init: () => { ED.dom.inEvNum.value = 192; } },
  { key: "center_split", label: "Center split", row: "num", vlabel: "Amount", step: "1",
    expl: "Splits the track down the middle and pushes the halves apart. Interpolates between keyframes; 0 closes it again.",
    init: () => { ED.dom.inEvNum.value = 100; } },
  { key: "lane_toggle", label: "Lane hide", row: "num", vlabel: "Length", min: 1, step: "6",
    expl: "Fades the track out (or back in) over N/192 of a measure.",
    init: () => { ED.dom.inEvNum.value = 48; } },
  { key: "fx-l_se", label: "FX chip sample (left)", row: "text", vlabel: "File",
    expl: "Custom hit sample for left FX chips — a sample file in the song folder (e.g. clap.wav).",
    init: () => { ED.dom.inEvText.value = ""; ED.dom.inEvText.placeholder = "clap.wav"; } },
  { key: "fx-r_se", label: "FX chip sample (right)", row: "text", vlabel: "File",
    expl: "Custom hit sample for right FX chips — a sample file in the song folder (e.g. clap.wav).",
    init: () => { ED.dom.inEvText.value = ""; ED.dom.inEvText.placeholder = "clap.wav"; } },
  { key: "bm", label: "Bookmark", row: "text", vlabel: "Name", optional: true,
    expl: "Editor bookmark at the cursor — jump between bookmarks with , and . (the B key toggles one directly). Saved as a //bm: comment in the file, ignored by the game.",
    init: () => { ED.dom.inEvText.value = ""; ED.dom.inEvText.placeholder = "(optional name)"; } },
  { key: "", label: "Custom command…", row: "text", vlabel: "Line",
    expl: "Any raw chart line (key=value). Known keys (t, beat, filtertype) are applied properly; unknown commands are kept in the file verbatim.",
    init: () => { ED.dom.inEvText.value = ""; ED.dom.inEvText.placeholder = "zoom_top=100"; } },
];

function fillSelect(sel, entries) {
  sel.innerHTML = "";
  for (const [v, label] of entries) {
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  }
}

let evTick = 0;

function openEventModal() {
  evTick = Math.max(0, snapTick(ED.timing.msToTick(ED.curMs)));
  ED.dom.evTitle.textContent = "Add event at " + tickLabel(evTick);
  updateEvControls(true);
  ED.dom.eventModal.showModal();
}

function updateEvControls(init) {
  const d = ED.dom;
  const kind = EV_KINDS[parseInt(d.selEvKind.value)];
  if (init && kind.init) kind.init(evTick);
  const num = kind.row === "num" || (kind.row === "tilt" && d.selEvChoice.value === "__num");
  d.evRowNum.style.display = num ? "" : "none";
  d.evRowChoice.style.display = kind.row === "choice" || kind.row === "tilt" ? "" : "none";
  d.evRowSig.style.display = kind.row === "sig" ? "" : "none";
  d.evRowText.style.display = kind.row === "text" ? "" : "none";
  const vlabel = kind.vlabel || "Value";
  d.evRowNum.firstElementChild.textContent = kind.row === "tilt" ? "Roll amount" : vlabel;
  d.evRowChoice.firstElementChild.textContent = vlabel;
  d.evRowText.firstElementChild.textContent = vlabel;
  if (kind.row === "num") d.inEvNum.step = kind.step || "any";
  d.evExplain.textContent = kind.expl;
}

function insertEventFromModal() {
  const d = ED.dom;
  const kind = EV_KINDS[parseInt(d.selEvKind.value)];
  let key = kind.key, val;
  if (kind.row === "num" || (kind.row === "tilt" && d.selEvChoice.value === "__num")) {
    val = d.inEvNum.value.trim();
    const nv = parseFloat(val);
    if (!isFinite(nv)) { toast("Enter a number"); return; }
    if (kind.min != null && nv < kind.min) { toast("Value must be at least " + kind.min); return; }
  } else if (kind.row === "choice" || kind.row === "tilt") {
    val = d.selEvChoice.value;
  } else if (kind.row === "sig") {
    val = parseInt(d.inEvSigN.value) + "/" + parseInt(d.inEvSigD.value);
  } else {
    val = d.inEvText.value.trim();
    if (!val && !kind.optional) { toast("Enter a value"); return; }
  }
  if (key === "bm") { // bookmark: //bm: comment line, one per tick
    pushUndo();
    ED.chart.other = ED.chart.other.filter(o => !(o.y === evTick && isBookmark(o)));
    ED.chart.other.push({ y: evTick, s: "//bm:" + val });
    ED.chart.other.sort((a, b) => a.y - b.y);
    markEdit();
    d.eventModal.close();
    toast("Bookmark at " + tickLabel(evTick) + " — jump with , and .");
    return;
  }
  if (!key) { // custom raw line: route known keys through their handlers
    if (/^[0-2]{4}\|/.test(val)) { toast("That is a note row, not a command"); return; }
    const eq = val.indexOf("=");
    key = eq > 0 ? val.slice(0, eq) : val;
    val = eq > 0 ? val.slice(eq + 1) : "";
  }
  if (applyEventCommand(evTick, key, val)) d.eventModal.close();
}

// floating tooltip for event rows — unlike native title bubbles it is
// unaffected by clicks and follows the cursor
function showEvTip(text, x, y) {
  const tip = ED.dom.evTip;
  tip.textContent = text;
  tip.style.display = "block";
  const r = tip.getBoundingClientRect();
  let tx = x - r.width - 14; // the list sits in the right sidebar: prefer left of the cursor
  if (tx < 4) tx = Math.min(x + 14, innerWidth - r.width - 4);
  tip.style.left = tx + "px";
  tip.style.top = Math.max(4, Math.min(y + 12, innerHeight - r.height - 4)) + "px";
}
function hideEvTip() {
  if (ED.dom.evTip) ED.dom.evTip.style.display = "none";
}

let evListKey = "";
function renderEventList(m) {
  const key = m.idx + "|" + ED.chartVersion;
  if (key === evListKey) return;
  evListKey = key;
  const el = ED.dom.eventList;
  el.innerHTML = "";
  hideEvTip(); // rows may vanish or change under a visible tooltip
  const inM = e => e.y >= m.y && e.y < m.y + m.ticks;
  const rows = [];
  for (const b of ED.chart.bpms) if (b.y > 0 && inM(b))
    rows.push({
      y: b.y, tag: "BPM", txt: KSH.fmtNum(b.v), expl: EVENT_INFO.t[1], raw: "t=" + KSH.fmtNum(b.v),
      del: () => { ED.chart.bpms = ED.chart.bpms.filter(x => x !== b); rebuildTiming(); syncInputsFromChart(); },
      edit: () => promptEdit("BPM at " + tickLabel(b.y) + ":", KSH.fmtNum(b.v), v => {
        const n = parseFloat(v);
        if (!isFinite(n) || n <= 0) { toast("Invalid BPM"); return false; }
        b.v = n; rebuildTiming(); syncInputsFromChart();
      }),
    });
  for (const s of ED.chart.sigs) if (s.y > 0 && inM(s))
    rows.push({
      y: s.y, tag: "Time sig", txt: `${s.n}/${s.d}`, expl: EVENT_INFO.beat[1], raw: `beat=${s.n}/${s.d}`,
      del: () => { ED.chart.sigs = ED.chart.sigs.filter(x => x !== s); rebuildTiming(); },
      edit: () => promptEdit("Time signature:", `${s.n}/${s.d}`, v => {
        const mm = /^(\d+)\s*\/\s*(\d+)$/.exec(v);
        if (!mm || (KSH.WHOLE_TICKS * +mm[1]) % +mm[2] !== 0) { toast("Invalid signature"); return false; }
        s.n = +mm[1]; s.d = +mm[2]; rebuildTiming();
      }),
    });
  for (const f of ED.chart.filters) if (inM(f))
    rows.push({
      y: f.y, tag: "Filter", txt: f.v, expl: EVENT_INFO.filtertype[1], raw: "filtertype=" + f.v,
      del: () => { ED.chart.filters = ED.chart.filters.filter(x => x !== f); },
      edit: () => promptEdit("Filter type (peak / lpf1 / hpf1 / bitc / custom):", f.v, v => { f.v = v; }),
    });
  for (const sp of ED.chart.spins) if (inM(sp)) {
    const sm = /^(@\(|@\)|@<|@>|S<|S>)\s*(\d*)/.exec(sp.s);
    const nice = sm ? `${SPIN_LABEL[sm[1]] || sm[1]} · ${sm[2] || "?"}t` : sp.s;
    rows.push({
      y: sp.y, tag: "Spin", txt: nice,
      expl: "Lane spin on a slam. @( @) full spin, @< @> half spin, S< S> swing; the number is the duration in 1/192s of a measure.",
      raw: sp.s,
      del: () => { ED.chart.spins = ED.chart.spins.filter(x => x !== sp); },
      edit: () => promptEdit("Spin (e.g. @(192, @>96, S<48):", sp.s, v => {
        if (!/^(@\(|@\)|@<|@>|S<|S>)\d+/.test(v)) { toast("Invalid spin — use @( @) @< @> S< S> + length"); return false; }
        sp.s = v;
      }),
    });
  }
  for (const o of ED.chart.other) if (inM(o)) {
    if (isBookmark(o)) {
      rows.push({
        y: o.y, tag: "Bookmark", txt: o.s.slice(5) || "(unnamed)",
        expl: "Editor bookmark — saved as a // comment in the file, ignored by the game. Toggle with B.",
        raw: o.s,
        del: () => { ED.chart.other = ED.chart.other.filter(x => x !== o); },
        edit: () => promptEdit("Bookmark name:", o.s.slice(5), v => { o.s = "//bm:" + v; }),
      });
      continue;
    }
    const eq = o.s.indexOf("=");
    const okey = eq > 0 ? o.s.slice(0, eq) : o.s;
    const oval = eq > 0 ? o.s.slice(eq + 1) : "";
    const info = EVENT_INFO[okey];
    rows.push({
      y: o.y, tag: info ? info[0] : okey, txt: info ? oval : (oval || o.s),
      expl: info ? info[1] : "Raw chart command (kept verbatim on save).",
      raw: o.s,
      del: () => { ED.chart.other = ED.chart.other.filter(x => x !== o); },
      edit: () => promptEdit("Command:", o.s, v => {
        if (/^[0-2]{4}\|/.test(v)) { toast("That is a note row, not a command"); return false; }
        o.s = v;
      }),
    });
  }
  rows.sort((a, b) => a.y - b.y);
  if (!rows.length) {
    el.className = "hint";
    el.textContent = "No events in this measure.";
    return;
  }
  el.className = "";
  for (const r of rows.slice(0, 24)) {
    const div = document.createElement("div");
    div.className = "evrow";
    // custom tooltip: native title bubbles hide on click until the pointer re-enters
    div.dataset.tip = r.expl + "\n\nRaw: " + r.raw;
    const tag = document.createElement("span");
    tag.className = "evtag";
    tag.textContent = r.tag;
    const span = document.createElement("span");
    span.className = "evtxt";
    span.textContent = tickLabel(r.y).replace(/^#\d+\./, "b") + " · " + r.txt;
    const be = document.createElement("button");
    be.textContent = "✎";
    be.title = "Edit this event";
    be.addEventListener("click", r.edit);
    const bx = document.createElement("button");
    bx.textContent = "×";
    bx.title = "Delete this event";
    bx.addEventListener("click", () => { pushUndo(); r.del(); markEdit(); });
    div.append(tag, span, be, bx);
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
  const multi = ED.selList.length > 1;
  d.inspMulti.style.display = multi ? "" : "none";
  d.inspNone.style.display = sel || multi ? "none" : "";
  d.inspNote.style.display = !multi && sel && (sel.type === "bt" || sel.type === "fx") ? "" : "none";
  d.inspLaser.style.display = !multi && sel && (sel.type === "laserseg" || sel.type === "laserpoint") ? "" : "none";
  if (multi) {
    const counts = {};
    for (const s of ED.selList) {
      const kind = s.type === "bt" ? (s.note.l > 0 ? "BT hold" : "BT chip")
        : s.type === "fx" ? (s.note.l > 0 ? "FX hold" : "FX chip")
        : s.type === "laserseg" ? "laser" : "laser point";
      counts[kind] = (counts[kind] || 0) + 1;
    }
    d.inspMultiInfo.textContent = ED.selList.length + " selected: " +
      Object.entries(counts).map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`).join(", ");
    d.splineBox.style.display = splineSelectable() ? "" : "none";
    // batch effect editing when every selected object is an FX hold
    const allFxHolds = ED.selList.every(s => s.type === "fx" && s.note.l > 0);
    d.fxEffectBox.style.display = allFxHolds ? "" : "none";
    if (allFxHolds && sel) {
      const [type, param] = (sel.note.fx || "").split(";");
      setSelectValue(d.selFxType, type || "");
      const def = FX_TYPES.find(t => t.name === type);
      const isCustom = !!type && !def;
      d.inFxParam.style.display = (def && def.param !== null) || isCustom ? "" : "none";
      d.inFxParam.value = param != null && param !== "" ? param : (def && def.param !== null ? def.param : "");
    }
    return;
  }
  d.fxEffectBox.style.display = "none";
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
  // applies to every selected FX hold (single selection is a list of one)
  const targets = ED.selList.filter(s => s.type === "fx" && s.note.l > 0).map(s => s.note);
  if (!targets.length) return;
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
  if (targets.every(n => str === (n.fx || ""))) return;
  pushUndo();
  for (const n of targets) n.fx = str;
  markEdit(); updateInspector();
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
  fill(d.selFilter, "(keep current)", filterNameEntries(defs));
}

// [value, label] pairs of every known filter name: built-ins, #define_filter
// lines and names already used in the chart
function filterNameEntries(defs = parseDefines(ED.chart)) {
  const names = new Map(FILTER_TYPES.map(n => [n, n]));
  for (const [n, def] of Object.entries(defs.filter)) names.set(n, `${n} (${def.type})`);
  for (const f of ED.chart.filters) if (f.v && !names.has(f.v)) names.set(f.v, f.v);
  return [...names.entries()];
}

function applyLaserProps() {
  const seg = ED.selSeg();
  if (!seg) return;
  pushUndo();
  setSegWide(seg, ED.dom.chkSegWide.checked ? 2 : 1); // keeps points visually in place
  const t0 = seg.points[0].y;
  const val = ED.dom.selFilter.value;
  ED.chart.filters = ED.chart.filters.filter(f => f.y !== t0);
  if (val) { ED.chart.filters.push({ y: t0, v: val }); ED.chart.filters.sort((a, b) => a.y - b.y); }
  markEdit(); updateInspector();
}

/* ------------------------- laser curving ------------------------- */

// minimum spacing between generated points: one tick above the slam threshold
const SPLINE_GAP = KSH.SLAM_TICKS + 1;

// selected laser points grouped by segment: Map<seg, Set<pt>> with only the
// segments that have 2+ selected points; null when the selection doesn't qualify
function splineGroups() {
  if (!ED.selList.length || !ED.selList.every(s => s.type === "laserpoint")) return null;
  const bySeg = new Map();
  for (const s of ED.selList) {
    if (!bySeg.has(s.seg)) bySeg.set(s.seg, new Set());
    bySeg.get(s.seg).add(s.pt);
  }
  for (const [seg, pts] of bySeg) if (pts.size < 2) bySeg.delete(seg);
  return bySeg.size ? bySeg : null;
}

function splineSelectable() { return !!splineGroups(); }

// replace one segment's laser between the selected knots with a monotone cubic
// spline (d3 curveMonotoneX tangents: rounded direction changes, no overshoot,
// so the curve can't hit the 0..1 clamp and produce corners). Density is the
// maximum that never creates a slam. Returns the new point count of the range.
function splineSeg(seg, idxs) {
  const knots = idxs.map(i => seg.points[i]);
  const n = knots.length;
  const h = [], sl = []; // span length + slope
  for (let i = 0; i + 1 < n; i++) {
    h[i] = Math.max(1, knots[i + 1].y - knots[i].y);
    sl[i] = (knots[i + 1].v - knots[i].v) / h[i];
  }
  const tan = new Array(n);
  for (let i = 1; i + 1 < n; i++) {
    const s0 = sl[i - 1], s1 = sl[i];
    const p = (s0 * h[i] + s1 * h[i - 1]) / (h[i - 1] + h[i]);
    tan[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  tan[0] = n > 2 ? (3 * sl[0] - tan[1]) / 2 : sl[0];
  tan[n - 1] = n > 2 ? (3 * sl[n - 2] - tan[n - 2]) / 2 : sl[n - 2];
  const out = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = knots[i], b = knots[i + 1];
    out.push({ y: a.y, v: a.v });
    const span = b.y - a.y;
    if (span <= KSH.SLAM_TICKS) continue; // slams between knots stay slams
    // as many points as fit with every gap >= SPLINE_GAP (spans of less than
    // 2*SPLINE_GAP ticks can't take a point without creating a slam)
    const nPts = Math.floor(span / SPLINE_GAP) - 1;
    if (nPts < 1) continue;
    const g = Math.floor(span / (nPts + 1));
    let r = span - g * (nPts + 1); // spread the remainder over the first gaps
    const bq = Math.round(Math.max(0, Math.min(1, b.v)) * 50) / 50;
    let y = a.y, lastV = a.v;
    for (let j = 0; j < nPts; j++) {
      y += g + (r-- > 0 ? 1 : 0);
      const t = (y - a.y) / span, t2 = t * t, t3 = t2 * t;
      let v = (2 * t3 - 3 * t2 + 1) * a.v + (t3 - 2 * t2 + t) * span * tan[i]
            + (-2 * t3 + 3 * t2) * b.v + (t3 - t2) * span * tan[i + 1];
      v = Math.round(Math.max(0, Math.min(1, v)) * 50) / 50;
      // spans are monotone: samples already at the target knot's grid value
      // would only flatten the approach — let the line run into the knot instead
      if (v !== lastV && v !== bq) { out.push({ y, v }); lastV = v; }
    }
  }
  out.push({ y: knots[n - 1].y, v: knots[n - 1].v });
  const start = idxs[0], count = idxs[idxs.length - 1] - idxs[0] + 1;
  const old = seg.points.slice(start, start + count);
  const changed = out.length !== old.length || out.some((p, i) => p.y !== old[i].y || p.v !== old[i].v);
  if (changed) seg.points.splice(start, count, ...out);
  return { changed, count: out.length };
}

// spline every laser that has 2+ selected points (one undo step for all)
function splineSelection() {
  const groups = splineGroups();
  if (!groups) { toast("Shift+click 2+ points of a laser first"); return; }
  pushUndo();
  let total = 0, changed = false;
  for (const [seg, ptSet] of groups) {
    const r = splineSeg(seg, [...ptSet].sort((a, b) => a - b));
    total += r.count;
    changed = changed || r.changed;
  }
  if (!changed) {
    // e.g. every span is under 2*SPLINE_GAP ticks: no curve point fits anywhere
    ED.undoStack.pop();
    toast(`Nothing to curve — the selected points are too close (a span needs ${2 * SPLINE_GAP}+ ticks to take a curve point without creating a slam)`);
    return; // keep the selection so it can be adjusted
  }
  setSel(null);
  markEdit();
  toast(groups.size > 1
    ? `Splined ${groups.size} lasers (${total} points total)`
    : `Spline through ${[...groups.values()][0].size} points (${total} points total)`);
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
  document.title = (ED.dirty ? "● " : "") + (m.title || "KSM Editor") + " – KSM Chart Editor";
}

function syncInputsFromChart() {
  // BPM/offset now live on the setup page; refresh it when visible
  if (!ED.dom.setupScreen || !setupOpen()) return;
  ED.dom.sBpm.value = KSH.fmtNum(ED.chart.bpms[0].v);
  ED.dom.sOffset.value = Math.round(parseFloat(ED.chart.meta.o) || 0);
}

function setChart(chart) {
  if (ED.playing) pausePlayback();
  ED.chart = chart;
  ED.undoStack = []; ED.redoStack = [];
  ED.sel = null; ED.selList = []; ED.laserEdit = null; ED.drag = null;
  ED.dirty = false; hitDirty = true;
  ED.curMs = 0;
  rebuildTiming();
  ED.chartVersion++;
  rebuildEffectOptions();
  GameView.resetSim();
  syncInputsFromChart(); updateTitle(); updateInspector();
}

// label/order a .ksh list entry from its difficulty + level
function setDiffLabel(f, difficulty, level) {
  f.diff = (difficulty || "?").trim() || "?";
  f.order = DIFFICULTIES.indexOf(f.diff);
  if (f.order < 0) f.order = 9;
  f.label = `${f.diff}${level ? " Lv" + String(level).trim() : ""} — ${f.name}`;
}

// refill the .ksh dropdown from ED.kshFiles + the "new file" action
function rebuildDiffOptions() {
  const sel = ED.dom.selDiff;
  sel.innerHTML = "";
  ED.kshFiles.forEach((f, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = f.label;
    sel.appendChild(o);
  });
  const o = document.createElement("option");
  o.value = "new"; o.textContent = "＋ New .ksh…";
  sel.appendChild(o);
}

async function openFolder() {
  if (!window.showDirectoryPicker) {
    toast("Folder access needs Chrome/Edge. Drag & drop the .ksh and audio files instead.");
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
    setDiffLabel(f, dm ? dm[1] : "?", lm ? lm[1] : "");
  }
  files.sort((a, b) => a.order - b.order);
  ED.kshFiles = files;
  rebuildDiffOptions();
  ED.dom.selDiff.style.display = "";
  await loadKshEntry(files[0]);
}

// "+ New .ksh…" picked in the dropdown: create a fresh difficulty in the folder
async function addKshToFolder() {
  const revert = () => {
    const i = ED.kshFiles.findIndex(x => x.handle === ED.kshHandle);
    ED.dom.selDiff.value = i >= 0 ? i : 0;
  };
  if (ED.dirty && !confirm("Discard unsaved changes?")) { revert(); return; }
  const freeDiff = DIFFICULTIES.find(x => !ED.kshFiles.some(f => f.diff === x)) || "light";
  let name = prompt("File name for the new .ksh:", freeDiff + ".ksh");
  if (name === null || !(name = name.trim())) { revert(); return; }
  if (!name.toLowerCase().endsWith(".ksh")) name += ".ksh";
  if (ED.kshFiles.some(f => f.name.toLowerCase() === name.toLowerCase())) {
    toast(`“${name}” already exists in this folder`); revert(); return;
  }
  // the new difficulty shares the song's metadata (incl. #define lines) and timing
  const src = ED.chart;
  const c = KSH.newChart();
  c.meta = Object.assign({}, src.meta);
  c.metaKeys = src.metaKeys.slice();
  c.meta.difficulty = freeDiff;
  c.meta.level = "1";
  c.bpms = structuredClone(src.bpms);
  c.sigs = structuredClone(src.sigs);
  let handle;
  try {
    handle = await ED.dirHandle.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(KSH.serialize(c));
    await w.close();
  } catch (e) { toast("Could not create " + name); revert(); return; }
  const f = { name, handle };
  setDiffLabel(f, c.meta.difficulty, c.meta.level);
  ED.kshFiles.push(f);
  ED.kshFiles.sort((a, b) => a.order - b.order);
  setChart(c);
  ED.kshHandle = handle; ED.kshName = name;
  rebuildDiffOptions();
  ED.dom.selDiff.value = ED.kshFiles.indexOf(f);
  toast("Created " + name);
  openSetup(false);
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
    } catch (e) { toast(`Audio “${m}” not found in folder — drag & drop the audio file`); }
  }
  updateTitle();
}

async function openKshFile(file) {
  if (ED.dirty && !confirm("Discard unsaved changes?")) return;
  const text = await file.text();
  setChart(KSH.parse(text));
  ED.kshHandle = null; ED.kshName = file.name;
  ED.dom.selDiff.style.display = "none";
  hideLaunch();
  const m = (ED.chart.meta.m || "").split(";")[0].trim();
  if (m && AudioEng.fileName !== m) toast(`Chart wants “${m}” — drag & drop it to load`);
  updateTitle();
}

async function loadAudioFile(file) {
  try {
    const ab = await file.arrayBuffer();
    const raw = new Uint8Array(ab.slice(0)); // decodeAudioData detaches ab
    await AudioEng.loadArrayBuffer(ab, file.name);
    ED.audioRaw = { name: file.name, data: raw }; // kept for "Save folder as .zip" without a folder
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
      refreshDiffLabel();
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

// export the chart as .kson (KSM v2): into the folder when one is open,
// otherwise as a download. The .ksh stays the file being edited.
async function saveKson() {
  finalizeLaser();
  const text = JSON.stringify(KSON.fromChart(ED.chart), null, 2);
  const name = (ED.kshName || (ED.chart.meta.title || "chart") + ".ksh").replace(/\.ksh$/i, "") + ".kson";
  if (ED.dirHandle) {
    try {
      const fh = await ED.dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text); await w.close();
      toast("Saved " + name);
      return;
    } catch (e) { /* fall through to download */ }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Downloaded " + name);
}

// keep the current entry's dropdown label in sync with the saved difficulty/level
function refreshDiffLabel() {
  const f = ED.kshFiles.find(x => x.handle === ED.kshHandle);
  if (!f) return;
  setDiffLabel(f, ED.chart.meta.difficulty, ED.chart.meta.level);
  ED.kshFiles.sort((a, b) => a.order - b.order);
  rebuildDiffOptions();
  ED.dom.selDiff.value = ED.kshFiles.indexOf(f);
}

async function collectFolderEntries(dir, prefix, out, skipName) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === "directory") await collectFolderEntries(h, prefix + name + "/", out, skipName);
    else if (prefix + name !== skipName)
      out.push({ name: prefix + name, data: new Uint8Array(await (await h.getFile()).arrayBuffer()) });
  }
}

// download the whole song folder (with the current chart freshly serialized)
// as a zip; without a folder, falls back to chart + loaded audio
async function saveZipArchive() {
  finalizeLaser();
  const text = KSH.serialize(ED.chart);
  const kshName = ED.kshName || ((ED.chart.meta.title || "chart") + ".ksh");
  const entries = [];
  try {
    if (ED.dirHandle) await collectFolderEntries(ED.dirHandle, "", entries, kshName);
    else if (ED.audioRaw) entries.push({ name: ED.audioRaw.name, data: ED.audioRaw.data });
  } catch (e) { toast("Could not read the folder — zip not saved"); return; }
  entries.push({ name: kshName, data: new TextEncoder().encode(text) });
  const zipName = ((ED.dirHandle && ED.dirHandle.name) || ED.chart.meta.title || "chart") + ".zip";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(ZIP.make(entries));
  a.download = zipName;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Downloaded ${zipName} (${entries.length} file${entries.length > 1 ? "s" : ""})`);
}

/* --------------------------- setup page --------------------------- */

let setupIsNew = false;

function setupOpen() { return ED.dom.setupScreen.style.display !== "none"; }
function prefsOpen() { return ED.dom.prefsScreen.style.display !== "none"; }

function openSetup(isNew = false) {
  setupIsNew = isNew;
  const d = ED.dom;
  const src = isNew ? KSH.newChart() : ED.chart;
  const m = src.meta;
  if (isNew && AudioEng.fileName) m.m = AudioEng.fileName;
  d.setupTitle.textContent = isNew ? "New chart" : "Song setup";
  d.btnSetupDone.textContent = isNew ? "Create" : "Done";
  d.mTitle.value = m.title || ""; d.mArtist.value = m.artist || "";
  d.mEffect.value = m.effect || ""; d.mJacket.value = m.jacket || "";
  d.mDifficulty.value = DIFFICULTIES.includes(m.difficulty) ? m.difficulty : "light";
  d.mLevel.value = m.level || "1"; d.mMvol.value = m.mvol || "75";
  d.mMusic.value = m.m || "";
  const po = Math.max(0, Math.round(parseFloat(m.po) || 0));
  d.mPo.value = po;
  d.mPreviewEnd.value = po + Math.max(0, Math.round(parseFloat(m.plength) || 15000));
  d.sBpm.value = KSH.fmtNum(src.bpms[0].v);
  d.sOffset.value = Math.round(parseFloat(m.o) || 0);
  tapReset();
  d.setupScreen.style.display = "";
}

function closeSetup() { ED.dom.setupScreen.style.display = "none"; }

function applySetup() {
  const d = ED.dom;
  const bpm = parseFloat(d.sBpm.value);
  if (!isFinite(bpm) || bpm <= 0) { toast("Invalid BPM"); return; }
  const off = Math.round(parseFloat(d.sOffset.value) || 0);
  let chart = ED.chart;
  if (setupIsNew) {
    if (ED.dirty && !confirm("Discard unsaved changes and create a new chart?")) return;
    chart = KSH.newChart();
  } else {
    pushUndo();
  }
  const m = chart.meta;
  m.title = d.mTitle.value; m.artist = d.mArtist.value;
  m.effect = d.mEffect.value; m.jacket = d.mJacket.value;
  m.difficulty = d.mDifficulty.value; m.level = d.mLevel.value;
  m.mvol = d.mMvol.value; m.m = d.mMusic.value;
  // the file stores a length; the UI edits start + end
  const po = Math.max(0, Math.round(parseFloat(d.mPo.value) || 0));
  const pEnd = Math.max(0, Math.round(parseFloat(d.mPreviewEnd.value) || 0));
  m.po = String(po);
  if (pEnd > po) m.plength = String(pEnd - po);
  else { m.plength = "15000"; toast("Preview end was not after the start — length set to 15 s"); }
  m.o = String(off);
  chart.bpms[0].v = bpm;
  if (setupIsNew) {
    setChart(chart);
    ED.kshHandle = null; ED.kshName = "";
    d.selDiff.style.display = "none";
  } else {
    rebuildTiming(); markEdit();
  }
  applyVolumes(); updateTitle();
  closeSetup();
}

/* --------------------------- BPM tapping --------------------------- */

const tap = { wall: [], audio: [], lastWall: 0 };

function tapReset() { tap.wall = []; tap.audio = []; tap.lastWall = 0; updateTapUI(); }

function tapNow() {
  const wall = performance.now();
  if (wall - tap.lastWall > 2000) { tap.wall = []; tap.audio = []; } // long pause = fresh run
  tap.lastWall = wall;
  tap.wall.push(wall);
  tap.audio.push(ED.playing ? AudioEng.positionMs() : null);
  updateTapUI();
}

// song-time taps when the song was playing (accurate at any playback speed)
function tapSeries() {
  return tap.audio.length && tap.audio.every(t => t !== null) ? tap.audio : tap.wall;
}

function tapBpmEstimate() {
  const t = tapSeries();
  if (t.length < 4) return null;
  // least-squares slope of tap time over tap index = beat period
  const n = t.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += t[i]; sxx += i * i; sxy += i * t[i]; }
  const period = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  if (!(period > 100 && period < 3000)) return null; // 20..600 BPM sanity
  return 60000 / period;
}

// prefer whole numbers when the raw estimate is close to one
function tapDisplayBpm(raw) {
  if (raw === null) return null;
  const r = Math.round(raw);
  return Math.abs(raw - r) < 0.3 ? r : Math.round(raw * 100) / 100;
}

// beat phase of the taps (circular mean), applied as the smallest
// correction to the reference offset so measure alignment is kept
function tapOffsetEstimate(bpm, ref) {
  const ts = tap.audio.filter(t => t !== null);
  if (!bpm || ts.length < 4) return null;
  const P = 60000 / bpm;
  let sx = 0, sy = 0;
  for (const t of ts) {
    const a = (((t % P) + P) % P) / P * 2 * Math.PI;
    sx += Math.cos(a); sy += Math.sin(a);
  }
  const phase = Math.atan2(sy, sx) / (2 * Math.PI) * P;
  const cur = isFinite(ref) ? ref : 0;
  let delta = (phase - cur) % P;
  if (delta > P / 2) delta -= P;
  if (delta < -P / 2) delta += P;
  return Math.round(cur + delta);
}

function updateTapUI() {
  const d = ED.dom;
  const raw = tapBpmEstimate();
  const bpm = tapDisplayBpm(raw);
  d.tapCount.textContent = tapSeries().length;
  d.tapBpm.textContent = bpm === null ? "—"
    : bpm + (Math.abs(raw - bpm) > 0.005 ? ` (raw ${raw.toFixed(2)})` : "");
  const off = tapOffsetEstimate(bpm, parseFloat(d.sOffset.value));
  d.tapOffset.textContent = off !== null ? off + " ms" : (bpm !== null && !ED.playing ? "tap while playing" : "—");
}

// write tap results into the setup form (applied on Done/Create)
function useTap(withOffset) {
  const bpm = tapDisplayBpm(tapBpmEstimate());
  if (bpm === null) { toast("Tap at least 4 beats first"); return; }
  ED.dom.sBpm.value = bpm;
  if (withOffset) {
    const off = tapOffsetEstimate(bpm, parseFloat(ED.dom.sOffset.value));
    if (off === null) { toast("Offset needs taps while the song plays"); return; }
    ED.dom.sOffset.value = off;
  }
  toast(`♩=${bpm}${withOffset ? " + offset" : ""} filled in — ${setupIsNew ? "Create" : "Done"} applies it`);
}

/* ------------------------- launch screen ------------------------- */

let launchNewPending = false;

function hideLaunch() {
  launchNewPending = false;
  if (ED.dom.launchScreen) ED.dom.launchScreen.style.display = "none";
}

/* ------------------------------ init ------------------------------ */

function $(id) { return document.getElementById(id); }

function init() {
  const d = ED.dom;
  for (const id of ["highway", "gameview", "highwayWrap", "inLaneSpeed", "inGameSpeed", "timeline", "btnPlay", "timeDisp", "beatDisp", "toast",
    "selSnap", "selRate", "inVolMusic", "inVolHit", "inVolMet", "selDiff",
    "chkMetronome", "chkHitsounds",
    "inspNone", "inspNote", "inspNoteInfo", "inspMulti", "inspMultiInfo", "fxEffectBox", "selFxType", "inFxParam",
    "inspLaser", "inspLaserInfo", "chkSegWide", "selFilter", "btnDelSel",
    "spinBox", "selSpin", "inSpinLen", "splineBox", "btnSpline", "eventList", "btnAddEvent", "evTip",
    "eventModal", "evTitle", "selEvKind", "evRowNum", "inEvNum", "evRowChoice", "selEvChoice",
    "evRowSig", "inEvSigN", "inEvSigD", "evRowText", "inEvText", "evExplain", "btnEvInsert", "btnEvCancel",
    "btnSave", "saveWrap", "saveMenu", "btnFileNew", "btnFileOpenFolder", "btnSaveKsh", "btnSaveKson", "btnSaveZip",
    "btnHelp", "btnView", "viewWrap", "viewMenu",
    "fileKsh", "fileAudio", "helpModal",
    "launchScreen", "btnLaunchFolder", "btnLaunchNew",
    "setupScreen", "setupTitle", "btnSetup", "btnSetupDone", "btnSetupCancel",
    "prefsScreen", "btnPrefs", "btnPrefsClose",
    "btnGenerate", "genModal", "genLevel", "genBpm", "genMeasures", "genGuidance",
    "genRange", "genBmRow", "genBmFrom", "genBmTo", "genMeasuresRow", "genAudioG", "btnGenCancel",
    "chkGenAudio", "genModelFile", "genStatus", "btnGenGo", "btnGenClose",
    "genS_notes", "genV_notes", "genS_peak", "genV_peak", "genS_tsumami", "genV_tsumami",
    "genS_tricky", "genV_tricky", "genS_hand-trip", "genV_hand-trip", "genS_one-hand", "genV_one-hand",
    "sBpm", "sOffset", "btnTapPad", "tapCount", "tapBpm", "tapOffset",
    "btnTapReset", "btnTapUseBpm", "btnTapUseBoth",
    "mTitle", "mArtist", "mEffect", "mJacket", "mDifficulty", "mLevel", "mMvol", "mMusic",
    "mPo", "mPreviewEnd", "btnPreviewCursor", "btnPreviewEndCursor"])
    d[id] = $(id);

  loadPrefs();
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
  d.selRate.value = AudioEng.rate;

  // reflect restored preferences in the UI
  d.inLaneSpeed.value = Math.round(ED.edSpeed * 100) / 100;
  d.inGameSpeed.value = Math.round(ED.hispeed * 100) / 100;
  d.inVolMusic.value = ED.volMusic;
  d.inVolHit.value = ED.volHit;
  d.inVolMet.value = ED.volMet;
  d.chkMetronome.checked = ED.opts.metronome;
  d.chkHitsounds.checked = ED.opts.hitsounds;
  setViewMode(ED.viewMode);
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

  // view modes + game view input
  d.inLaneSpeed.addEventListener("change", () => setEditorSpeed(parseFloat(d.inLaneSpeed.value)));
  d.inGameSpeed.addEventListener("change", () => setGameSpeed(parseFloat(d.inGameSpeed.value)));
  d.gameview.addEventListener("wheel", e => {
    e.preventDefault();
    if (e.ctrlKey) setGameSpeed(ED.hispeed * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    else seekBySnap(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // transport & options
  d.btnPlay.addEventListener("click", togglePlay);
  d.selRate.addEventListener("change", () => {
    AudioEng.setRate(parseFloat(d.selRate.value));
    if (ED.playing) { AudioEng.play(ED.curMs = AudioEng.positionMs()); resetSched(); }
    savePrefs();
  });
  d.inVolMusic.addEventListener("input", () => { ED.volMusic = parseFloat(d.inVolMusic.value); applyVolumes(); savePrefs(); });
  d.inVolHit.addEventListener("input", () => { ED.volHit = parseFloat(d.inVolHit.value); applyVolumes(); savePrefs(); });
  d.inVolMet.addEventListener("input", () => { ED.volMet = parseFloat(d.inVolMet.value); applyVolumes(); savePrefs(); });
  d.selSnap.addEventListener("change", () => { ED.snapDiv = parseInt(d.selSnap.value); savePrefs(); });
  d.chkMetronome.addEventListener("change", () => { ED.opts.metronome = d.chkMetronome.checked; if (ED.playing) resetSched(); savePrefs(); });
  d.chkHitsounds.addEventListener("change", () => { ED.opts.hitsounds = d.chkHitsounds.checked; savePrefs(); });

  // add-event dialog
  EV_KINDS.forEach((k, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = k.label;
    d.selEvKind.appendChild(o);
  });
  d.btnAddEvent.addEventListener("click", openEventModal);
  d.selEvKind.addEventListener("change", () => updateEvControls(true));
  d.selEvChoice.addEventListener("change", () => updateEvControls(false));
  d.btnEvInsert.addEventListener("click", insertEventFromModal);
  d.btnEvCancel.addEventListener("click", () => d.eventModal.close());
  d.eventModal.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); insertEventFromModal(); }
  });

  // event-row tooltips (the ✎/× buttons keep their own native titles)
  d.eventList.addEventListener("mousemove", e => {
    const row = e.target.closest(".evrow");
    if (row && row.dataset.tip && !e.target.closest("button"))
      showEvTip(row.dataset.tip, e.clientX, e.clientY);
    else hideEvTip();
  });
  d.eventList.addEventListener("mouseleave", hideEvTip);

  // inspector
  d.selFxType.addEventListener("change", applyFxEffect);
  d.inFxParam.addEventListener("change", applyFxEffect);
  d.chkSegWide.addEventListener("change", applyLaserProps);
  d.selFilter.addEventListener("change", applyLaserProps);
  d.selSpin.addEventListener("change", applySpin);
  d.inSpinLen.addEventListener("change", applySpin);
  d.btnSpline.addEventListener("click", splineSelection);
  d.btnDelSel.addEventListener("click", deleteSelection);

  // files (hidden inputs: used by the launch screen, tests and drag & drop fallback)
  d.fileKsh.addEventListener("change", () => { if (d.fileKsh.files[0]) openKshFile(d.fileKsh.files[0]); d.fileKsh.value = ""; });
  d.fileAudio.addEventListener("change", async () => {
    const file = d.fileAudio.files[0];
    d.fileAudio.value = "";
    if (!file) { launchNewPending = false; return; }
    await loadAudioFile(file);
    if (launchNewPending && AudioEng.buffer) {
      // launch-screen "New Chart": start a fresh chart on this audio
      const c = KSH.newChart();
      c.meta.m = AudioEng.fileName;
      setChart(c);
      ED.kshHandle = null; ED.kshName = "";
      d.selDiff.style.display = "none";
      hideLaunch();
      openSetup(false);
    }
    launchNewPending = false;
  });
  d.fileAudio.addEventListener("cancel", () => { launchNewPending = false; });

  // launch screen
  d.btnLaunchFolder.addEventListener("click", async () => {
    await openFolder();
    if (ED.kshFiles.length) hideLaunch();
  });
  d.btnLaunchNew.addEventListener("click", () => {
    launchNewPending = true;
    d.fileAudio.click();
  });
  // File and View dropdown menus
  const hideSaveMenu = () => { d.saveMenu.style.display = "none"; };
  const hideViewMenu = () => { d.viewMenu.style.display = "none"; };
  d.btnSave.addEventListener("click", e => {
    e.stopPropagation();
    hideViewMenu();
    d.saveMenu.style.display = d.saveMenu.style.display === "none" ? "" : "none";
  });
  d.btnView.addEventListener("click", e => {
    e.stopPropagation();
    hideSaveMenu();
    d.viewMenu.style.display = d.viewMenu.style.display === "none" ? "" : "none";
  });
  d.viewMenu.querySelectorAll("button").forEach(b =>
    b.addEventListener("click", () => { hideViewMenu(); setViewMode(b.dataset.view); }));
  d.btnFileNew.addEventListener("click", () => {
    hideSaveMenu();
    if (ED.dirty && !confirm("Discard unsaved changes and start a new chart?")) return;
    launchNewPending = true; // same flow as the launch screen: pick audio, then setup
    d.fileAudio.click();
  });
  d.btnFileOpenFolder.addEventListener("click", async () => {
    hideSaveMenu();
    await openFolder();
    if (ED.kshFiles.length) hideLaunch();
  });
  d.btnSaveKsh.addEventListener("click", () => { hideSaveMenu(); saveChart(); });
  d.btnSaveKson.addEventListener("click", () => { hideSaveMenu(); saveKson(); });
  d.btnSaveZip.addEventListener("click", () => { hideSaveMenu(); saveZipArchive(); });
  document.addEventListener("click", e => {
    if (!d.saveWrap.contains(e.target)) hideSaveMenu();
    if (!d.viewWrap.contains(e.target)) hideViewMenu();
  });
  d.selDiff.addEventListener("change", () => {
    if (d.selDiff.value === "new") addKshToFolder();
    else loadKshEntry(ED.kshFiles[parseInt(d.selDiff.value)]);
  });
  // preferences page (all controls in it apply live)
  d.btnPrefs.addEventListener("click", () => { d.prefsScreen.style.display = ""; });
  d.btnPrefsClose.addEventListener("click", () => { d.prefsScreen.style.display = "none"; });

  // clicking outside a modal closes it (mousedown, so releasing a drag that
  // started inside — e.g. on a slider — doesn't count as an outside click)
  const closeOnBackdrop = (el, close) =>
    el.addEventListener("mousedown", e => { if (e.target === el) close(); });
  closeOnBackdrop(d.setupScreen, closeSetup);
  closeOnBackdrop(d.prefsScreen, () => { d.prefsScreen.style.display = "none"; });
  for (const dlg of [d.eventModal, d.helpModal, d.genModal])
    dlg.addEventListener("mousedown", e => {
      const r = dlg.getBoundingClientRect(); // backdrop clicks land outside the rect
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        dlg.close();
    });
  GEN.init();
  // setup page (metadata + timing + tap tool)
  d.btnSetup.addEventListener("click", () => openSetup(false));
  d.btnSetupDone.addEventListener("click", applySetup);
  d.btnSetupCancel.addEventListener("click", closeSetup);
  // playback keeps running while setup is open, so grab the live position
  const setupCursorMs = () => Math.max(0, Math.round(ED.playing ? AudioEng.positionMs() : ED.curMs));
  d.btnPreviewCursor.addEventListener("click", () => {
    const ms = setupCursorMs();
    const oldLen = (parseFloat(d.mPreviewEnd.value) || 0) - (parseFloat(d.mPo.value) || 0);
    d.mPo.value = ms;
    d.mPreviewEnd.value = ms + (oldLen > 0 ? Math.round(oldLen) : 15000); // keep the length until an end is picked
    toast(`Preview start set to ${fmtTime(ms)} — Done applies it`);
  });
  d.btnPreviewEndCursor.addEventListener("click", () => {
    const ms = setupCursorMs();
    d.mPreviewEnd.value = ms;
    const po = parseFloat(d.mPo.value) || 0;
    toast(ms > po
      ? `Preview end set to ${fmtTime(ms)} (${fmtTime(ms - po)} long) — Done applies it`
      : "Preview end set — note: it is before the start");
  });
  d.btnTapPad.addEventListener("click", tapNow);
  d.btnTapReset.addEventListener("click", tapReset);
  d.btnTapUseBpm.addEventListener("click", () => useTap(false));
  d.btnTapUseBoth.addEventListener("click", () => useTap(true));
  d.sOffset.addEventListener("change", updateTapUI);
  d.btnHelp.addEventListener("click", () => {
    d.helpModal.showModal();
    d.helpModal.scrollTop = 0; // showModal focuses the Close button at the bottom, which scrolls the dialog
  });

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
  if (setupOpen()) {
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key.toLowerCase() === "t") { e.preventDefault(); tapNow(); }
    else if (e.key === "Escape") closeSetup();
    else if (e.key === "Enter") applySetup();
    return;
  }
  if (prefsOpen()) {
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "Escape" || e.key === "Enter") ED.dom.prefsScreen.style.display = "none";
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
    case "6": setTool("remove"); break;
    case "t": case "T":
      e.preventDefault();
      openSetup(false);
      break;
    case "b": case "B": e.preventDefault(); toggleBookmark(); break;
    case ".": e.preventDefault(); jumpBookmark(1); break;
    case ",": e.preventDefault(); jumpBookmark(-1); break;
    case "Tab": {
      e.preventDefault();
      const modes = ["editor", "split", "game"];
      setViewMode(modes[(modes.indexOf(ED.viewMode) + 1) % modes.length]);
      break;
    }
    case "Delete": case "Backspace": e.preventDefault(); deleteSelection(); break;
    case "Enter": if (ED.laserEdit) { e.preventDefault(); finalizeLaser(); } break;
    case "Escape":
      if (ED.laserEdit) finalizeLaser();
      else setSel(null);
      break;
  }
}

document.addEventListener("DOMContentLoaded", init);
