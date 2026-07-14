"use strict";
/* ============================================================
 * Rendering: highway (main edit view) + bottom timeline scrubber.
 * Reads global editor state `ED` (app.js).
 * ============================================================ */

const Render = (() => {

const COL = {
  bg: "#0d0d14",
  gutter: "rgba(255,255,255,0.025)",
  track: "#15151f",
  laneSep: "#23232f",
  measure: "#5a5a78",
  beat: "#30303f",
  snap: "rgba(255,255,255,0.05)",
  judge: "#ff4d5e",
  btChip: "#f2f2f8",
  btChipEdge: "#8e8ea8",
  btHold: "rgba(228,228,255,0.30)",
  btHoldEdge: "rgba(228,228,255,0.75)",
  fxChip: "#e8821e",
  fxChipEdge: "#8f4c0e",
  fxHold: "rgba(255,140,40,0.26)",
  fxHoldEdge: "rgba(255,155,60,0.85)",
  fxLabel: "#ffb066",
  laserL: "#33ccff",
  laserR: "#ff4aa8",
  sel: "#ffe066",
  bpm: "#7fd67f",
  filter: "#b98fff",
  spin: "#ffd24a",
  text: "#9797b3",
};

function dpr() { return window.devicePixelRatio || 1; }

function sizeCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const d = dpr();
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}

function sizeCanvases() { sizeCanvas(ED.dom.highway); sizeCanvas(ED.dom.timeline); }

/* -------- geometry shared with input handling -------- */
function geom() {
  const cv = ED.dom.highway;
  const W = cv.width / dpr(), H = cv.height / dpr();
  const trackW = Math.min(Math.max(W * 0.34, 200), 420);
  const gutter = trackW / 2;
  const trackX = (W - trackW) / 2;
  const laneW = trackW / 4;
  const judgeY = H * 0.85;
  const ppt = ED.zoom;
  const curTick = ED.timing.msToTick(ED.curMs);
  const yOfTick = t => judgeY - (t - curTick) * ppt;
  const tickOfY = y => curTick + (judgeY - y) / ppt;
  const laserX = (v, wide) => trackX + (wide === 2 ? v * 2 - 0.5 : v) * trackW;
  const laneX = l => trackX + l * laneW;
  return { W, H, trackX, trackW, laneW, gutter, judgeY, ppt, curTick, yOfTick, tickOfY, laserX, laneX };
}

/* ------------------------ highway ------------------------ */

function drawHighway() {
  const cv = ED.dom.highway, ctx = cv.getContext("2d");
  const d = dpr();
  ctx.setTransform(d, 0, 0, d, 0, 0);
  const G = geom();
  const { W, H, trackX, trackW, laneW, gutter, judgeY, ppt, yOfTick } = G;
  ED.G = G;

  ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
  // wide-laser gutters + track
  ctx.fillStyle = COL.gutter;
  ctx.fillRect(trackX - gutter, 0, gutter, H);
  ctx.fillRect(trackX + trackW, 0, gutter, H);
  ctx.fillStyle = COL.track;
  ctx.fillRect(trackX, 0, trackW, H);
  ctx.strokeStyle = COL.laneSep; ctx.lineWidth = 1;
  for (let l = 0; l <= 4; l++) {
    const x = Math.round(trackX + l * laneW) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  const tMin = G.tickOfY(H) - 1, tMax = G.tickOfY(0) + 1;

  // ---- waveform strip (left of track) ----
  if (ED.opts.waveform && AudioEng.peaks) {
    const wfW = 60, wfX = trackX - gutter - wfW - 16;
    if (wfX > 2) {
      ctx.fillStyle = "rgba(96,140,200,0.05)";
      ctx.fillRect(wfX, 0, wfW, H);
      ctx.fillStyle = "rgba(110,160,220,0.55)";
      const dur = AudioEng.durationMs();
      for (let y = 0; y < H; y += 2) {
        const ms1 = ED.timing.tickToMs(G.tickOfY(y));
        const ms0 = ED.timing.tickToMs(G.tickOfY(y + 2));
        if (ms1 < 0 || ms0 > dur) continue;
        const p = AudioEng.rangePeak(ms0, ms1);
        if (p <= 0.001) continue;
        const w = Math.max(1, p * wfW);
        ctx.fillRect(wfX + (wfW - w) / 2, y, w, 2);
      }
    }
  }

  // ---- grid ----
  ctx.font = "11px 'Segoe UI', sans-serif";
  const snapStep = ED.snapTicks();
  for (const m of ED.measures) {
    if (m.y > tMax || m.y + m.ticks < tMin) continue;
    const beatTicks = KSH.WHOLE_TICKS / m.d;
    // snap grid
    if (snapStep * ppt >= 7) {
      ctx.strokeStyle = COL.snap; ctx.lineWidth = 1;
      for (let t = m.y + snapStep; t < m.y + m.ticks; t += snapStep) {
        if (t % beatTicks === 0 || t < tMin || t > tMax) continue;
        const y = Math.round(yOfTick(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(trackX, y); ctx.lineTo(trackX + trackW, y); ctx.stroke();
      }
    }
    // beats
    ctx.strokeStyle = COL.beat;
    for (let b = 1; b < m.n; b++) {
      const t = m.y + b * beatTicks;
      if (t < tMin || t > tMax) continue;
      const y = Math.round(yOfTick(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(trackX, y); ctx.lineTo(trackX + trackW, y); ctx.stroke();
    }
    // measure line + number
    if (m.y >= tMin && m.y <= tMax) {
      const y = Math.round(yOfTick(m.y)) + 0.5;
      ctx.strokeStyle = COL.measure;
      ctx.beginPath(); ctx.moveTo(trackX - gutter, y); ctx.lineTo(trackX + trackW + gutter, y); ctx.stroke();
      ctx.fillStyle = COL.text; ctx.textAlign = "right";
      ctx.fillText(String(m.idx + 1).padStart(3, "0"), trackX - gutter - 8, y + 4);
    }
  }

  // ---- FX notes (wide, under BT) ----
  for (let s = 0; s < 2; s++) {
    const x = trackX + s * 2 * laneW, w = 2 * laneW;
    for (const n of ED.chart.fx[s]) {
      if (n.y > tMax || n.y + Math.max(n.l, 0) < tMin) continue;
      if (n.l > 0) {
        const y1 = yOfTick(n.y), y0 = yOfTick(n.y + n.l);
        ctx.fillStyle = COL.fxHold; ctx.fillRect(x + 1, y0, w - 2, y1 - y0);
        ctx.strokeStyle = COL.fxHoldEdge; ctx.lineWidth = 1;
        ctx.strokeRect(x + 1.5, y0 + 0.5, w - 3, y1 - y0 - 1);
        if (n.fx) {
          ctx.fillStyle = COL.fxLabel; ctx.textAlign = "center";
          ctx.fillText(n.fx, x + w / 2, Math.min(y1 - 5, H - 4));
        }
      } else {
        const y = yOfTick(n.y);
        ctx.fillStyle = COL.fxChip; ctx.fillRect(x + 1, y - 4, w - 2, 8);
        ctx.strokeStyle = COL.fxChipEdge; ctx.strokeRect(x + 1.5, y - 3.5, w - 3, 7);
      }
    }
  }

  // ---- BT notes ----
  for (let l = 0; l < 4; l++) {
    const x = trackX + l * laneW;
    for (const n of ED.chart.bt[l]) {
      if (n.y > tMax || n.y + Math.max(n.l, 0) < tMin) continue;
      if (n.l > 0) {
        const y1 = yOfTick(n.y), y0 = yOfTick(n.y + n.l);
        ctx.fillStyle = COL.btHold; ctx.fillRect(x + 4, y0, laneW - 8, y1 - y0);
        ctx.strokeStyle = COL.btHoldEdge; ctx.lineWidth = 1;
        ctx.strokeRect(x + 4.5, y0 + 0.5, laneW - 9, y1 - y0 - 1);
      } else {
        const y = yOfTick(n.y);
        ctx.fillStyle = COL.btChip; ctx.fillRect(x + 2, y - 4, laneW - 4, 8);
        ctx.strokeStyle = COL.btChipEdge; ctx.strokeRect(x + 2.5, y - 3.5, laneW - 5, 7);
      }
    }
  }

  // ---- lasers ----
  const bandW = laneW * 0.5;
  for (let s = 0; s < 2; s++) {
    const col = s === 0 ? COL.laserL : COL.laserR;
    for (const seg of ED.chart.lasers[s]) {
      const pts = seg.points;
      if (!pts.length) continue;
      if (pts[0].y > tMax || pts[pts.length - 1].y < tMin) continue;
      const X = v => G.laserX(v, seg.wide);
      // start cap
      {
        const y = yOfTick(pts[0].y), x = X(pts[0].v);
        ctx.fillStyle = col; ctx.globalAlpha = 0.9;
        ctx.fillRect(x - bandW / 2, y, bandW, 5);
        ctx.globalAlpha = 1;
      }
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i], q = pts[i + 1];
        if (q.y < tMin || p.y > tMax) continue;
        const y1 = yOfTick(p.y), y2 = yOfTick(q.y);
        const x1 = X(p.v), x2 = X(q.v);
        ctx.fillStyle = col;
        if (q.y - p.y <= KSH.SLAM_TICKS) {
          // slam: horizontal block
          const h = Math.max(y1 - y2, 9);
          const xl = Math.min(x1, x2) - bandW / 2, xr = Math.max(x1, x2) + bandW / 2;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(xl, y1 - h, xr - xl, h);
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = 0.5;
          ctx.beginPath();
          ctx.moveTo(x1 - bandW / 2, y1); ctx.lineTo(x1 + bandW / 2, y1);
          ctx.lineTo(x2 + bandW / 2, y2); ctx.lineTo(x2 - bandW / 2, y2);
          ctx.closePath(); ctx.fill();
          ctx.globalAlpha = 0.95;
          ctx.strokeStyle = col; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      // point markers while editing
      const showPts = ED.tool === "select" ||
        (ED.tool === "laserL" && s === 0) || (ED.tool === "laserR" && s === 1);
      if (showPts) {
        for (const p of pts) {
          if (p.y < tMin || p.y > tMax) continue;
          drawDiamond(ctx, X(p.v), yOfTick(p.y), 5, "#ffffff", col);
        }
      }
      // wide badge
      if (seg.wide === 2 && pts[0].y >= tMin && pts[0].y <= tMax) {
        ctx.fillStyle = col; ctx.textAlign = "center";
        ctx.fillText("2x", X(pts[0].v), yOfTick(pts[0].y) + 16);
      }
    }
  }

  // ---- event labels (right side) ----
  ctx.textAlign = "left";
  const labX = trackX + trackW + gutter + 8;
  for (const b of ED.chart.bpms) {
    if (b.y < tMin || b.y > tMax) continue;
    const y = yOfTick(b.y);
    ctx.fillStyle = COL.bpm;
    ctx.fillText("♩=" + KSH.fmtNum(b.v), labX, y + 4);
    ctx.fillRect(trackX + trackW, y - 1, gutter, 2);
  }
  for (const f of ED.chart.filters) {
    if (f.y < tMin || f.y > tMax) continue;
    const y = yOfTick(f.y);
    ctx.fillStyle = COL.filter;
    ctx.fillText(f.v, labX, y + 14);
    ctx.fillRect(trackX + trackW, y - 1, gutter / 2, 2);
  }
  for (const sp of ED.chart.spins) {
    if (sp.y < tMin || sp.y > tMax) continue;
    ctx.fillStyle = COL.spin;
    ctx.fillText("spin " + sp.s, labX, yOfTick(sp.y) - 6);
  }
  // camera / stop / other raw commands (grouped per tick, max 3 shown)
  {
    ctx.fillStyle = "rgba(150,150,175,0.75)";
    let i = 0;
    const others = ED.chart.other;
    while (i < others.length) {
      const y0 = others[i].y;
      let j = i;
      while (j < others.length && others[j].y === y0) j++;
      if (y0 >= tMin && y0 <= tMax) {
        const y = yOfTick(y0);
        const n = Math.min(3, j - i);
        for (let k = 0; k < n; k++)
          ctx.fillText(others[i + k].s + (k === n - 1 && j - i > n ? `  (+${j - i - n})` : ""),
            labX, y + 24 + k * 11);
      }
      i = j;
    }
  }

  // ---- selection highlight ----
  drawSelection(ctx, G);

  // ---- hover ghost ----
  drawHover(ctx, G);

  // ---- past dim ----
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, judgeY, W, H - judgeY);

  // ---- judgment line ----
  ctx.strokeStyle = COL.judge; ctx.lineWidth = 2;
  ctx.shadowColor = COL.judge; ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(trackX - gutter - 4, judgeY); ctx.lineTo(trackX + trackW + gutter + 4, judgeY);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = COL.judge;
  ctx.beginPath();
  ctx.moveTo(trackX - gutter - 14, judgeY - 6); ctx.lineTo(trackX - gutter - 4, judgeY);
  ctx.lineTo(trackX - gutter - 14, judgeY + 6); ctx.closePath(); ctx.fill();
}

function drawDiamond(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
}

function drawSelection(ctx, G) {
  const sel = ED.sel;
  if (!sel) return;
  const { trackX, laneW, yOfTick } = G;
  ctx.strokeStyle = COL.sel; ctx.lineWidth = 2;
  if (sel.type === "bt" || sel.type === "fx") {
    const n = ED.selNote();
    if (!n) return;
    const wide = sel.type === "fx";
    const x = wide ? trackX + sel.lane * 2 * laneW : trackX + sel.lane * laneW;
    const w = wide ? 2 * laneW : laneW;
    if (n.l > 0) ctx.strokeRect(x, yOfTick(n.y + n.l) - 1, w, yOfTick(n.y) - yOfTick(n.y + n.l) + 2);
    else ctx.strokeRect(x, yOfTick(n.y) - 6, w, 12);
  } else if (sel.type === "laserseg" || sel.type === "laserpoint") {
    const seg = ED.selSeg();
    if (!seg) return;
    const X = v => G.laserX(v, seg.wide);
    ctx.strokeStyle = COL.sel; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < seg.points.length; i++) {
      const p = seg.points[i];
      if (i === 0) ctx.moveTo(X(p.v), yOfTick(p.y)); else ctx.lineTo(X(p.v), yOfTick(p.y));
    }
    ctx.stroke();
    for (let i = 0; i < seg.points.length; i++) {
      const p = seg.points[i];
      const active = sel.type === "laserpoint" && i === sel.pt;
      drawDiamond(ctx, X(p.v), yOfTick(p.y), active ? 7 : 5, active ? COL.sel : "#fff", COL.sel);
    }
  }
}

function drawHover(ctx, G) {
  const h = ED.hover;
  if (!h || ED.playing) return;
  const { trackX, laneW, yOfTick } = G;
  ctx.globalAlpha = 0.35;
  if (h.kind === "bt") {
    const x = trackX + h.lane * laneW;
    ctx.fillStyle = COL.btChip;
    ctx.fillRect(x + 2, yOfTick(h.tick) - 4, laneW - 4, 8);
  } else if (h.kind === "fx") {
    const x = trackX + h.side * 2 * laneW;
    ctx.fillStyle = COL.fxChip;
    ctx.fillRect(x + 1, yOfTick(h.tick) - 4, 2 * laneW - 2, 8);
  } else if (h.kind === "laser") {
    const col = h.side === 0 ? COL.laserL : COL.laserR;
    const wide = ED.laserEdit ? ED.laserEdit.seg.wide : (ED.laserWideDefault ? 2 : 1);
    const x = G.laserX(h.v, wide), y = yOfTick(h.tick);
    ctx.globalAlpha = 0.8;
    if (ED.laserEdit && ED.laserEdit.seg.points.length) {
      const pts = ED.laserEdit.seg.points;
      const lp = pts[pts.length - 1];
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(G.laserX(lp.v, ED.laserEdit.seg.wide), yOfTick(lp.y));
      ctx.lineTo(x, y); ctx.stroke();
      ctx.setLineDash([]);
    }
    drawDiamond(ctx, x, y, 6, "rgba(255,255,255,0.7)", col);
  }
  ctx.globalAlpha = 1;
}

/* ------------------------ timeline ------------------------ */

let tlCache = null, tlKey = "";

function drawTimeline() {
  const cv = ED.dom.timeline, ctx = cv.getContext("2d");
  const d = dpr();
  ctx.setTransform(d, 0, 0, d, 0, 0);
  const W = cv.width / d, H = cv.height / d;
  const dom0 = ED.domainStartMs(), dom1 = ED.domainEndMs();
  const span = Math.max(1, dom1 - dom0);
  const xOfMs = ms => (ms - dom0) / span * W;

  const key = [ED.chartVersion, W, H, Math.round(dom0), Math.round(dom1), AudioEng.fileName].join("|");
  if (key !== tlKey) {
    tlKey = key;
    tlCache = document.createElement("canvas");
    tlCache.width = Math.round(W * d); tlCache.height = Math.round(H * d);
    const c = tlCache.getContext("2d");
    c.setTransform(d, 0, 0, d, 0, 0);
    c.fillStyle = "#10101a"; c.fillRect(0, 0, W, H);
    // waveform
    if (AudioEng.peaks) {
      c.fillStyle = "rgba(110,160,220,0.5)";
      const wfH = H - 16;
      for (let x = 0; x < W; x++) {
        const p = AudioEng.rangePeak(dom0 + x / W * span, dom0 + (x + 1) / W * span);
        if (p <= 0.002) continue;
        const bh = Math.max(1, p * wfH);
        c.fillRect(x, 8 + (wfH - bh) / 2, 1, bh);
      }
    }
    // note density strips
    const dot = (ms, y, col) => { c.fillStyle = col; c.fillRect(xOfMs(ms) - 1, y, 2, 3); };
    for (const lane of ED.chart.bt) for (const n of lane) dot(ED.timing.tickToMs(n.y), H - 12, "rgba(240,240,250,0.8)");
    for (const side of ED.chart.fx) for (const n of side) dot(ED.timing.tickToMs(n.y), H - 8, "rgba(232,130,30,0.9)");
    for (let s = 0; s < 2; s++)
      for (const seg of ED.chart.lasers[s]) {
        const m0 = ED.timing.tickToMs(seg.points[0].y);
        const m1 = ED.timing.tickToMs(seg.points[seg.points.length - 1].y);
        c.fillStyle = s === 0 ? "rgba(51,204,255,0.8)" : "rgba(255,74,168,0.8)";
        c.fillRect(xOfMs(m0), H - 4, Math.max(2, xOfMs(m1) - xOfMs(m0)), 3);
      }
  }
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(tlCache, 0, 0, W, H);

  // cursor
  const cx = xOfMs(ED.curMs);
  ctx.strokeStyle = COL.judge; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  ctx.fillStyle = COL.judge;
  ctx.beginPath(); ctx.moveTo(cx - 5, 0); ctx.lineTo(cx + 5, 0); ctx.lineTo(cx, 6); ctx.closePath(); ctx.fill();
}

function draw() {
  sizeCanvases();
  if (ED.dom.highway.clientWidth > 0) drawHighway();
  drawTimeline();
}

return { draw, geom, sizeCanvases, COL };
})();
