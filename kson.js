"use strict";
/* ============================================================
 * KSH chart model -> KSON (kson spec 0.8.0, the KSM v2 format).
 * Pulses: kson uses 240/beat, the editor model 48 ticks/beat (×5).
 * Anything without a clean kson mapping is preserved in
 * compat.ksh_unknown instead of being dropped.
 * ============================================================ */

const KSON = (() => {

const P = t => t * 5; // ticks -> pulses

const DIFF_IDX = { light: 0, challenge: 1, extended: 2, infinite: 3 };

// meta keys the converter consumes; the rest go to compat.ksh_unknown.meta
const META_KNOWN = new Set([
  "title", "artist", "effect", "jacket", "illustrator", "difficulty", "level",
  "t", "m", "mvol", "o", "po", "plength", "total", "ver", "information", "icon", "to",
]);

// ksh built-in fx -> [kson audio effect name, params from the ";N" argument]
const FX_MAP = {
  Retrigger:  p => ["retrigger", p ? { wave_length: "1/" + p } : null],
  Gate:       p => ["gate", p ? { wave_length: "1/" + p } : null],
  Flanger:    () => ["flanger", null],
  PitchShift: p => ["pitch_shift", p ? { pitch: String(p) } : null],
  BitCrusher: p => ["bitcrusher", p ? { reduction: p + "samples" } : null],
  Phaser:     () => ["phaser", null],
  Wobble:     p => ["wobble", p ? { wave_length: "1/" + p } : null],
  TapeStop:   () => ["tapestop", null],
  Echo:       p => ["echo", p ? { wave_length: "1/" + p } : null],
  SideChain:  () => ["sidechain", null],
};

// ksh camera commands -> camera.cam.body graphs (kson value = ksh value / 100)
const CAM_KEYS = { zoom_bottom: "zoom", zoom_side: "shift_x", zoom_top: "rotation_x" };

function num(v, dflt = 0) { const n = parseFloat(v); return isFinite(n) ? n : dflt; }

function fromChart(chart) {
  const m = chart.meta;

  // ---- meta ----
  const bpms = chart.bpms;
  const vs = bpms.map(b => b.v);
  const mn = Math.min(...vs), mx = Math.max(...vs);
  const meta = {
    title: m.title || "",
    artist: m.artist || "",
    chart_author: m.effect || "",
    jacket_filename: m.jacket || "",
    jacket_author: m.illustrator || "",
    difficulty: DIFF_IDX[m.difficulty] != null ? DIFF_IDX[m.difficulty] : 0,
    level: Math.max(1, Math.min(20, Math.round(num(m.level, 1)))),
    disp_bpm: mn === mx ? KSH.fmtNum(mn) : KSH.fmtNum(mn) + "-" + KSH.fmtNum(mx),
  };
  if (m.to) meta.std_bpm = num(m.to);
  if (m.icon) meta.icon_filename = m.icon;
  if (m.information) meta.information = m.information;

  // ---- beat ----
  const timeSig = [];
  let idx = 0, prevY = 0, prevLen = KSH.WHOLE_TICKS;
  for (const s of chart.sigs) {
    idx += Math.round((s.y - prevY) / prevLen);
    timeSig.push({ idx, v: { n: s.n, d: s.d } });
    prevY = s.y;
    prevLen = Math.round(KSH.WHOLE_TICKS * s.n / s.d);
  }
  const beat = {
    bpm: bpms.map(b => ({ y: P(b.y), v: b.v })),
    time_sig: timeSig,
  };

  // ---- notes & lasers ----
  const note = {
    bt: chart.bt.map(lane => lane.map(n => n.l > 0 ? { y: P(n.y), l: P(n.l) } : { y: P(n.y) })),
    fx: chart.fx.map(side => side.map(n => n.l > 0 ? { y: P(n.y), l: P(n.l) } : { y: P(n.y) })),
    laser: chart.lasers.map(side => side.map(seg => {
      const y0 = seg.points[0].y;
      const v = [];
      const pts = seg.points;
      const isSlam = (a, b) => b && b.y - a.y <= KSH.SLAM_TICKS && b.v !== a.v;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[i + 1];
        if (isSlam(p, q)) {
          v.push({ ry: P(p.y - y0), v: p.v, vf: q.v }); // ksh slam pair -> instant slam
          if (!isSlam(q, pts[i + 2])) i++; // consume q unless it starts a chained slam
        } else {
          v.push({ ry: P(p.y - y0), v: p.v });
        }
      }
      const sec = { y: P(y0), v };
      if (seg.wide === 2) sec.w = 2;
      return sec;
    })),
  };

  // ---- audio (bgm, preview, fx long-note effects) ----
  const audio = {
    bgm: {
      filename: (m.m || "").split(";")[0].trim(),
      vol: num(m.mvol, 75) / 100,
      offset: Math.round(num(m.o)),
      preview: {
        offset: Math.max(0, Math.round(num(m.po))),
        duration: Math.max(0, Math.round(num(m.plength, 15000))),
      },
    },
  };
  const longEvent = {};
  chart.fx.forEach((side, si) => {
    for (const n of side) {
      if (!(n.l > 0) || !n.fx) continue;
      const [name, param] = n.fx.split(";");
      const [kname, kparams] = FX_MAP[name] ? FX_MAP[name](param) : [name, null];
      if (!longEvent[kname]) longEvent[kname] = [[], []];
      const ev = { y: P(n.y) };
      if (kparams) ev.v = kparams;
      longEvent[kname][si].push(ev);
    }
  });
  if (Object.keys(longEvent).length) audio.audio_effect = { fx: { long_event: longEvent } };

  // ---- camera, editor comments, compat leftovers ----
  const camBody = { zoom: [], shift_x: [], rotation_x: [] };
  const comments = [];
  const unkOption = {}, unkLine = [];
  const addOption = (key, y, v) => {
    if (!unkOption[key]) unkOption[key] = [];
    unkOption[key].push({ y: P(y), v: String(v) });
  };
  for (const o of chart.other) {
    if (o.s.startsWith("//")) { comments.push({ y: P(o.y), v: o.s.slice(2) }); continue; }
    const eq = o.s.indexOf("=");
    const key = eq > 0 ? o.s.slice(0, eq) : "";
    const val = eq > 0 ? o.s.slice(eq + 1) : "";
    if (CAM_KEYS[key] && isFinite(parseFloat(val)))
      camBody[CAM_KEYS[key]].push({ y: P(o.y), v: parseFloat(val) / 100 });
    else if (key) addOption(key, o.y, val);
    else unkLine.push({ y: P(o.y), v: o.s });
  }
  for (const f of chart.filters) addOption("filtertype", f.y, f.v);
  for (const sp of chart.spins) unkLine.push({ y: P(sp.y), v: sp.s });

  // ---- assemble ----
  const kson = { version: "0.8.0", meta, beat };
  const total = Math.round(num(m.total));
  if (total > 0) kson.gauge = { total };
  kson.note = note;
  kson.audio = audio;
  for (const k of Object.keys(camBody)) if (!camBody[k].length) delete camBody[k];
  if (Object.keys(camBody).length) kson.camera = { cam: { body: camBody } };
  if (comments.length) kson.editor = { comment: comments };
  const unkMeta = {};
  for (const k of chart.metaKeys) if (!META_KNOWN.has(k)) unkMeta[k] = m[k] != null ? m[k] : "";
  const compat = {};
  if (Object.keys(unkMeta).length) compat.meta = unkMeta;
  if (Object.keys(unkOption).length) compat.option = unkOption;
  if (unkLine.length) compat.line = unkLine;
  if (Object.keys(compat).length) kson.compat = { ksh_unknown: compat };
  return kson;
}

return { fromChart };
})();

if (typeof module !== "undefined" && module.exports) module.exports = KSON;
