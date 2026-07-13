"use strict";
/* ============================================================
 * KSH chart format parser / serializer + timing helpers
 * Format reference: KShootMania .ksh (ver 160+)
 *
 * Internal chart model (all positions in ticks, 48 ticks = 1 beat,
 * 192 ticks = one 4/4 measure):
 * {
 *   meta:     { title, artist, t, m, o, ... }        header key->value (strings)
 *   metaKeys: [ ... ]                                header key order
 *   bpms:     [ {y, v} ]                             BPM changes, bpms[0].y === 0
 *   sigs:     [ {y, n, d} ]                          time signatures (at measure starts)
 *   bt:       [ lane0..lane3 ]  lane = [ {y, l} ]    l=0 chip, l>0 hold length
 *   fx:       [ side0, side1 ]  side = [ {y, l, fx} ]  fx = effect string ("" = none)
 *   lasers:   [ side0, side1 ]  side = [ {points:[{y, v}], wide} ]  v in 0..1, wide 1|2
 *   filters:  [ {y, v} ]                             filtertype= body events
 *   spins:    [ {y, s} ]                             lane spin suffixes (preserved verbatim)
 *   other:    [ {y, s} ]                             unrecognized body lines (preserved)
 * }
 * ============================================================ */

const KSH = (() => {

const LASER_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno"; // 51 chars, v = idx/50
const SLAM_TICKS = 6;      // gap <= 1/32 note => rendered/played as a slam
const WHOLE_TICKS = 192;   // ticks per whole note (4/4 measure)
const TICKS_PER_BEAT = 48;

// Legacy single-char FX hold codes (pre-1.60 charts)
const LEGACY_FX = {
  S:"Retrigger;8", V:"Retrigger;12", T:"Retrigger;16", W:"Retrigger;24", U:"Retrigger;32",
  G:"Gate;4", H:"Gate;8", K:"Gate;12", I:"Gate;16", L:"Gate;24", J:"Gate;32",
  F:"Flanger", P:"PitchShift;12", B:"BitCrusher;5", Q:"Phaser", X:"Wobble;12",
  A:"TapeStop", D:"SideChain"
};

const DEFAULT_META = [
  ["title",""],["artist",""],["effect",""],["jacket",""],["illustrator",""],
  ["difficulty","light"],["level","1"],["t","120"],["m",""],["mvol","75"],
  ["o","0"],["bg","desert"],["layer","arrow"],["po","0"],["plength","15000"],
  ["pfiltergain","50"],["filtertype","peak"],["chokkakuautovol","0"],["chokkakuvol","50"],
  ["ver","171"]
];

function newChart() {
  const meta = {}, metaKeys = [];
  for (const [k, v] of DEFAULT_META) { meta[k] = v; metaKeys.push(k); }
  return {
    meta, metaKeys,
    bpms: [{ y: 0, v: 120 }],
    sigs: [{ y: 0, n: 4, d: 4 }],
    bt: [[], [], [], []],
    fx: [[], []],
    lasers: [[], []],
    filters: [], spins: [], other: []
  };
}

const ROW_RE = /^[0-2]{4}\|[0-9A-Za-z]{2}\|[0-9A-Za-z\-:]{2}/;

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; }
function lcm(a, b) { return a / gcd(a, b) * b; }

function fmtNum(v) { return String(Math.round(v * 10000) / 10000); }

/* ---------------------------- parse ---------------------------- */

function parse(text) {
  const chart = newChart();
  chart.meta = {}; chart.metaKeys = [];
  chart.bpms = []; chart.sigs = [];

  const lines = text.split(/\r?\n/);
  let i = 0;

  // ---- header ----
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trim() === "--") { i++; break; }
    const eq = ln.indexOf("=");
    if (eq > 0) {
      const k = ln.slice(0, eq), v = ln.slice(eq + 1);
      if (!(k in chart.meta)) chart.metaKeys.push(k);
      chart.meta[k] = v;
    }
  }
  const headBpm = parseFloat(chart.meta.t);

  // ---- body ----
  let sig = { n: 4, d: 4 };
  let pendingSig = null;
  let tick = 0;

  const btAct = [null, null, null, null];   // {note, end}
  const fxAct = [null, null];
  const lsAct = [null, null];               // active laser segment
  const pendWide = [false, false];
  const curFx = ["", ""];

  while (i < lines.length) {
    // collect one measure
    const mLines = [];
    let sawEnd = false;
    for (; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (ln === "--") { i++; sawEnd = true; break; }
      if (ln === "") continue;
      mLines.push(ln);
    }
    if (!mLines.length) { if (!sawEnd) break; else continue; }

    // beat= before the first note row applies to THIS measure
    for (const ln of mLines) {
      if (ROW_RE.test(ln)) break;
      if (ln.startsWith("beat=")) {
        const p = ln.slice(5).split("/");
        pendingSig = { n: parseInt(p[0]) || 4, d: parseInt(p[1]) || 4 };
      }
    }
    if (pendingSig) {
      if (pendingSig.n !== sig.n || pendingSig.d !== sig.d || tick === 0) {
        sig = pendingSig;
        chart.sigs.push({ y: tick, n: sig.n, d: sig.d });
      }
      pendingSig = null;
    }
    if (tick === 0 && !chart.sigs.length) chart.sigs.push({ y: 0, n: 4, d: 4 });

    const mTicks = Math.round(WHOLE_TICKS * sig.n / sig.d);
    let rowCount = 0;
    for (const ln of mLines) if (ROW_RE.test(ln)) rowCount++;
    const step = rowCount ? mTicks / rowCount : mTicks;

    let r = 0;
    for (const ln of mLines) {
      const rowTick = tick + Math.round(r * step);
      const nextTick = tick + Math.round((r + 1) * step);

      if (ROW_RE.test(ln)) {
        const bt = ln.slice(0, 4), fx = ln.slice(5, 7), ls = ln.slice(8, 10), rest = ln.slice(10);

        for (let l = 0; l < 4; l++) {
          const c = bt[l];
          if (c === '2') {
            if (!btAct[l]) { const note = { y: rowTick, l: 0 }; chart.bt[l].push(note); btAct[l] = { note, end: nextTick }; }
            btAct[l].end = nextTick;
          } else {
            if (btAct[l]) { btAct[l].note.l = rowTick - btAct[l].note.y; btAct[l] = null; }
            if (c === '1') chart.bt[l].push({ y: rowTick, l: 0 });
          }
        }
        for (let s = 0; s < 2; s++) {
          const c = fx[s];
          if (c === '0' || c === '2') {
            if (fxAct[s]) { fxAct[s].note.l = rowTick - fxAct[s].note.y; fxAct[s] = null; }
            if (c === '2') chart.fx[s].push({ y: rowTick, l: 0, fx: "" });
          } else { // '1' or legacy letter => hold unit
            if (!fxAct[s]) {
              let eff = curFx[s];
              if (c !== '1' && LEGACY_FX[c]) eff = LEGACY_FX[c];
              const note = { y: rowTick, l: 0, fx: eff };
              chart.fx[s].push(note); fxAct[s] = { note, end: nextTick };
            }
            fxAct[s].end = nextTick;
          }
        }
        for (let s = 0; s < 2; s++) {
          const c = ls[s];
          if (c === '-') { lsAct[s] = null; }
          else if (c === ':') { /* interpolation, keep segment alive */ }
          else {
            const idx = LASER_CHARS.indexOf(c);
            if (idx >= 0) {
              if (!lsAct[s]) {
                lsAct[s] = { points: [], wide: pendWide[s] ? 2 : 1 };
                pendWide[s] = false;
                chart.lasers[s].push(lsAct[s]);
              }
              lsAct[s].points.push({ y: rowTick, v: idx / 50 });
            }
          }
        }
        if (rest) chart.spins.push({ y: rowTick, s: rest });
        r++;
      } else {
        const eq = ln.indexOf("=");
        if (eq > 0) {
          const k = ln.slice(0, eq), v = ln.slice(eq + 1);
          if (k === "t") { const b = parseFloat(v); if (isFinite(b) && b > 0) chart.bpms.push({ y: rowTick, v: b }); }
          else if (k === "beat") {
            if (r > 0) { const p = v.split("/"); pendingSig = { n: parseInt(p[0]) || 4, d: parseInt(p[1]) || 4 }; }
          }
          else if (k === "fx-l") curFx[0] = v;
          else if (k === "fx-r") curFx[1] = v;
          else if (k === "filtertype") chart.filters.push({ y: rowTick, v });
          else if (k === "laserrange_l") pendWide[0] = v.trim() === "2x";
          else if (k === "laserrange_r") pendWide[1] = v.trim() === "2x";
          else chart.other.push({ y: rowTick, s: ln });
        } else {
          chart.other.push({ y: rowTick, s: ln });
        }
      }
    }
    tick += mTicks;
  }

  // close dangling holds
  for (let l = 0; l < 4; l++) if (btAct[l]) btAct[l].note.l = btAct[l].end - btAct[l].note.y;
  for (let s = 0; s < 2; s++) if (fxAct[s]) fxAct[s].note.l = fxAct[s].end - fxAct[s].note.y;
  // drop degenerate laser segments
  for (let s = 0; s < 2; s++) chart.lasers[s] = chart.lasers[s].filter(g => g.points.length >= 2);

  if (!chart.bpms.length || chart.bpms[0].y > 0)
    chart.bpms.unshift({ y: 0, v: isFinite(headBpm) && headBpm > 0 ? headBpm : 120 });
  chart.bpms.sort((a, b) => a.y - b.y);
  // dedupe same-tick bpm entries (keep last)
  chart.bpms = chart.bpms.filter((b, idx, arr) => idx === arr.length - 1 || arr[idx + 1].y !== b.y);
  if (!chart.sigs.length) chart.sigs = [{ y: 0, n: 4, d: 4 }];
  sortChart(chart);
  return chart;
}

function sortChart(chart) {
  const byY = (a, b) => a.y - b.y;
  for (const lane of chart.bt) lane.sort(byY);
  for (const side of chart.fx) side.sort(byY);
  for (const side of chart.lasers) {
    for (const seg of side) seg.points.sort(byY);
    side.sort((a, b) => a.points[0].y - b.points[0].y);
  }
  chart.bpms.sort(byY); chart.sigs.sort(byY);
  chart.filters.sort(byY); chart.spins.sort(byY); chart.other.sort(byY);
}

/* -------------------------- serialize -------------------------- */

function endTick(chart) {
  let end = 0;
  for (const lane of chart.bt) for (const n of lane) end = Math.max(end, n.y + Math.max(n.l, 0));
  for (const side of chart.fx) for (const n of side) end = Math.max(end, n.y + Math.max(n.l, 0));
  for (const side of chart.lasers) for (const g of side) if (g.points.length) end = Math.max(end, g.points[g.points.length - 1].y);
  for (const e of chart.bpms) end = Math.max(end, e.y);
  for (const e of chart.filters) end = Math.max(end, e.y);
  for (const e of chart.spins) end = Math.max(end, e.y);
  for (const e of chart.other) end = Math.max(end, e.y);
  return end;
}

// List of measures covering [0, minTick]
function measureList(chart, minTick) {
  const out = [];
  const sigs = chart.sigs;
  let si = 0, start = 0, n = 4, d = 4, idx = 0;
  while (start <= minTick || out.length === 0) {
    while (si < sigs.length && sigs[si].y <= start) { n = sigs[si].n; d = sigs[si].d; si++; }
    const ticks = Math.round(WHOLE_TICKS * n / d);
    out.push({ y: start, ticks, n, d, idx });
    start += ticks; idx++;
    if (out.length > 100000) break; // safety
  }
  return out;
}

function measureAt(measures, tick) {
  let lo = 0, hi = measures.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measures[mid].y <= tick) lo = mid; else hi = mid - 1;
  }
  return measures[lo];
}

function serialize(chart) {
  sortChart(chart);
  const lines = [];

  // header (update t)
  const meta = Object.assign({}, chart.meta);
  if (chart.bpms.length === 1) meta.t = fmtNum(chart.bpms[0].v);
  else {
    const vs = chart.bpms.map(b => b.v);
    const mn = Math.min(...vs), mx = Math.max(...vs);
    meta.t = mn === mx ? fmtNum(mn) : fmtNum(mn) + "-" + fmtNum(mx);
  }
  const keys = chart.metaKeys.slice();
  for (const k of Object.keys(meta)) if (!keys.includes(k)) keys.push(k);
  for (const k of keys) lines.push(k + "=" + (meta[k] != null ? meta[k] : ""));
  lines.push("--");

  const end = Math.max(endTick(chart), 1);
  const measures = measureList(chart, end);
  const bodyBpms = chart.bpms.length > 1 ? chart.bpms : []; // single bpm lives in header only

  // consecutive same-side laser segment pairs: a '-' row must exist between them,
  // otherwise the two segments merge into one when the file is read back
  const segGaps = [];
  for (let s = 0; s < 2; s++) {
    const segs = chart.lasers[s];
    for (let k = 0; k + 1 < segs.length; k++) {
      const a = segs[k].points[segs[k].points.length - 1].y;
      const b = segs[k + 1].points[0].y;
      if (b > a) segGaps.push({ a, b });
    }
  }

  // fx effect emission state (persists across holds, "" = none)
  const lastFx = ["", ""];
  // laser point lookup maps
  const ptMaps = [new Map(), new Map()];
  for (let s = 0; s < 2; s++)
    for (const seg of chart.lasers[s])
      for (const p of seg.points) ptMaps[s].set(p.y, p.v);

  let lastSigKey = "";
  for (const m of measures) {
    const mEnd = m.y + m.ticks;

    // events that must land on the row grid of this measure
    const offs = [];
    const addOff = t => { if (t >= m.y && t < mEnd) offs.push(t - m.y); };
    for (const lane of chart.bt) for (const nt of lane) {
      addOff(nt.y);
      if (nt.l > 0) { const e = nt.y + nt.l; if (e > m.y && e < mEnd) offs.push(e - m.y); }
    }
    for (const side of chart.fx) for (const nt of side) {
      addOff(nt.y);
      if (nt.l > 0) { const e = nt.y + nt.l; if (e > m.y && e < mEnd) offs.push(e - m.y); }
    }
    for (const side of chart.lasers) for (const seg of side) {
      for (const p of seg.points) addOff(p.y);
      // segment end: the row AFTER the last point must exist to terminate with '-'
    }
    for (const e of bodyBpms) addOff(e.y);
    for (const e of chart.filters) addOff(e.y);
    for (const e of chart.spins) addOff(e.y);
    for (const e of chart.other) addOff(e.y);

    let g = m.ticks;
    for (const o of offs) if (o > 0) g = gcd(g, o);
    let rows = m.ticks / g;
    rows = lcm(rows, Math.min(m.n, m.ticks)); // at least one row per beat
    let stepT = m.ticks / rows;

    // refine resolution until every laser-segment gap touching this measure has a '-' row
    const gapOk = (a, b, st) => {
      const q = m.y + (Math.floor((a - m.y) / st) + 1) * st; // first row strictly after a
      if (q >= b || q > mEnd) return false;
      if (q === mEnd && b <= mEnd) return false; // mEnd is next measure's row 0
      return true;
    };
    for (;;) {
      let bad = false;
      for (const p of segGaps)
        if (p.a < mEnd && p.b > m.y && !gapOk(p.a, p.b, stepT)) {
          // gap might already be satisfied by a row of the NEXT measure (a >= mEnd - would
          // have been filtered) or the row at m.y for pairs starting earlier - gapOk covers both
          bad = true; break;
        }
      if (!bad || stepT === 1) break;
      stepT = stepT % 2 === 0 ? stepT / 2 : 1;
      rows = m.ticks / stepT;
    }

    // pre-filter notes touching this measure
    const btM = chart.bt.map(lane => lane.filter(nt => nt.y < mEnd && nt.y + Math.max(nt.l, 0) >= m.y));
    const fxM = chart.fx.map(side => side.filter(nt => nt.y < mEnd && nt.y + Math.max(nt.l, 0) >= m.y));
    const lsM = chart.lasers.map(side => side.filter(seg =>
      seg.points[0].y <= mEnd && seg.points[seg.points.length - 1].y >= m.y));

    const sigKey = m.n + "/" + m.d;
    for (let r = 0; r < rows; r++) {
      const rowTick = m.y + Math.round(r * stepT);

      // ---- option lines before this row ----
      if (r === 0 && sigKey !== lastSigKey) { lines.push("beat=" + sigKey); lastSigKey = sigKey; }
      for (const e of bodyBpms) if (e.y === rowTick) lines.push("t=" + fmtNum(e.v));
      for (const e of chart.filters) if (e.y === rowTick) lines.push("filtertype=" + e.v);
      for (let s = 0; s < 2; s++) {
        for (const nt of fxM[s]) if (nt.y === rowTick && nt.l > 0) {
          const eff = nt.fx || "";
          if (eff !== lastFx[s]) { lines.push((s === 0 ? "fx-l=" : "fx-r=") + eff); lastFx[s] = eff; }
        }
        for (const seg of lsM[s]) if (seg.points[0].y === rowTick && seg.wide === 2)
          lines.push((s === 0 ? "laserrange_l=" : "laserrange_r=") + "2x");
      }
      for (const e of chart.other) if (e.y === rowTick) lines.push(e.s);

      // ---- note row ----
      let row = "";
      for (let l = 0; l < 4; l++) {
        let c = '0';
        for (const nt of btM[l]) {
          if (nt.l > 0 && rowTick >= nt.y && rowTick < nt.y + nt.l) { c = '2'; break; }
          if (nt.l === 0 && nt.y === rowTick) { c = '1'; break; }
        }
        row += c;
      }
      row += "|";
      for (let s = 0; s < 2; s++) {
        let c = '0';
        for (const nt of fxM[s]) {
          if (nt.l > 0 && rowTick >= nt.y && rowTick < nt.y + nt.l) { c = '1'; break; }
          if (nt.l === 0 && nt.y === rowTick) { c = '2'; break; }
        }
        row += c;
      }
      row += "|";
      for (let s = 0; s < 2; s++) {
        let c = '-';
        for (const seg of lsM[s]) {
          const first = seg.points[0].y, last = seg.points[seg.points.length - 1].y;
          if (rowTick >= first && rowTick <= last) {
            const v = ptMaps[s].get(rowTick);
            // only chars belonging to THIS segment
            let isPt = false;
            if (v !== undefined) for (const p of seg.points) if (p.y === rowTick) { isPt = true; break; }
            c = isPt ? LASER_CHARS[Math.max(0, Math.min(50, Math.round(ptMaps[s].get(rowTick) * 50)))] : ':';
            break;
          }
        }
        row += c;
      }
      for (const e of chart.spins) if (e.y === rowTick) row += e.s;
      lines.push(row);
    }
    lines.push("--");
  }
  return lines.join("\r\n") + "\r\n";
}

/* ---------------------------- timing ---------------------------- */

function buildTiming(chart) {
  const o = parseFloat(chart.meta.o) || 0;
  const segs = [];
  let ms = o, lastY = 0, lastB = chart.bpms[0].v;
  for (const b of chart.bpms) {
    ms += (b.y - lastY) * (60000 / (lastB * TICKS_PER_BEAT));
    segs.push({ y: b.y, ms, bpm: b.v });
    lastY = b.y; lastB = b.v;
  }
  function segForTick(t) {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].y <= t) lo = mid; else hi = mid - 1; }
    return segs[lo];
  }
  function segForMs(v) {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].ms <= v) lo = mid; else hi = mid - 1; }
    return segs[lo];
  }
  return {
    segs,
    tickToMs(t) { const s = segForTick(t); return s.ms + (t - s.y) * (60000 / (s.bpm * TICKS_PER_BEAT)); },
    msToTick(v) { const s = segForMs(v); return s.y + (v - s.ms) / (60000 / (s.bpm * TICKS_PER_BEAT)); },
    bpmAt(t) { return segForTick(t).bpm; }
  };
}

return {
  LASER_CHARS, SLAM_TICKS, WHOLE_TICKS, TICKS_PER_BEAT,
  newChart, parse, serialize, buildTiming, endTick, measureList, measureAt, gcd, fmtNum
};
})();

if (typeof module !== "undefined" && module.exports) module.exports = KSH;
