"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");

const EDITOR = "c:/Users/Berkb/Desktop/Neuer Ordner/ksm-editor/index.html";
const SHOW = "c:/Users/Berkb/Desktop/Neuer Ordner/Show";
const OUT = __dirname;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: "new",
    args: ["--autoplay-policy=no-user-gesture-required", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));

  await page.goto("file:///" + EDITOR.replace(/ /g, "%20"));
  await page.waitForFunction(() => typeof ED !== "undefined" && ED.chart && ED.timing);
  console.log("page loaded, ED initialized");

  // ---- load chart via file input ----
  const kshInput = await page.$("#fileKsh");
  await kshInput.uploadFile(path.join(SHOW, "Show(exh).ksh"));
  await page.waitForFunction(() => ED.chart.meta.title === "Show");
  const stats = await page.evaluate(() => ({
    title: ED.chart.meta.title,
    bpm: ED.chart.bpms[0].v,
    o: ED.chart.meta.o,
    bt: ED.chart.bt.flat().length,
    fx: ED.chart.fx.flat().length,
    lasers: ED.chart.lasers.flat().length,
  }));
  console.log("chart loaded:", JSON.stringify(stats));

  // ---- load audio via file input ----
  const audioInput = await page.$("#fileAudio");
  await audioInput.uploadFile(path.join(SHOW, "Show.ogg"));
  await page.waitForFunction(() => AudioEng.buffer !== null, { timeout: 30000 });
  const dur = await page.evaluate(() => AudioEng.durationMs());
  console.log("audio decoded:", Math.round(dur), "ms");

  // ---- jump to a busy section and screenshot ----
  await page.evaluate(() => { ED.curMs = 68000; });
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(OUT, "shot_loaded.png") });

  // ---- place a BT chip via real mouse events ----
  const before = await page.evaluate(() => ED.chart.bt.flat().length);
  await page.evaluate(() => setTool("bt"));
  const pos = await page.evaluate(() => {
    const G = Render.geom();
    const r = ED.dom.highway.getBoundingClientRect();
    return { x: r.left + G.trackX + G.laneW * 1.5, y: r.top + G.judgeY - 80 };
  });
  await page.mouse.click(pos.x, pos.y);
  const after = await page.evaluate(() => ED.chart.bt.flat().length);
  console.log("BT place via mouse:", before, "->", after, after === before + 1 ? "OK" : "FAIL");

  // click same spot again -> toggle remove
  await page.mouse.click(pos.x, pos.y);
  const after2 = await page.evaluate(() => ED.chart.bt.flat().length);
  console.log("BT toggle-remove:", after, "->", after2, after2 === before ? "OK" : "FAIL");

  // ---- place an FX hold via drag ----
  const fxBefore = await page.evaluate(() => ED.chart.fx.flat().filter(n => n.l > 0).length);
  await page.evaluate(() => setTool("fx"));
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.move(pos.x, pos.y - 120, { steps: 5 });
  await page.mouse.up();
  const fxHold = await page.evaluate(() => {
    const holds = ED.chart.fx.flat().filter(n => n.l > 0);
    return { count: holds.length, sel: ED.sel && ED.sel.type };
  });
  console.log("FX hold drag:", fxBefore, "->", fxHold.count, "sel:", fxHold.sel,
    fxHold.count === fxBefore + 1 && fxHold.sel === "fx" ? "OK" : "FAIL");

  // apply an effect through the inspector
  await page.select("#selFxType", "Retrigger");
  const eff = await page.evaluate(() => ED.selNote() && ED.selNote().fx);
  console.log("effect applied:", JSON.stringify(eff), eff === "Retrigger;8" ? "OK" : "FAIL");

  // ---- draw a laser: 3 clicks + Enter ----
  const lsBeforeYs = await page.evaluate(() => ED.chart.lasers[0].map(s => s.points[0].y));
  await page.evaluate(() => setTool("laserL"));
  await page.mouse.click(pos.x - 60, pos.y - 10);
  await page.mouse.click(pos.x + 40, pos.y - 90);
  await page.mouse.click(pos.x + 90, pos.y - 160);
  await page.keyboard.press("Enter");
  const lsAfter = await page.evaluate(before => {
    const segs = ED.chart.lasers[0];
    const news = segs.filter(s => !before.includes(s.points[0].y));
    return { newSegs: news.length, pts: news.length ? news[0].points.length : 0, editing: !!ED.laserEdit };
  }, lsBeforeYs);
  console.log("laser drawn:", JSON.stringify(lsAfter),
    lsAfter.newSegs === 1 && lsAfter.pts === 3 && !lsAfter.editing ? "OK" : "FAIL");
  await page.screenshot({ path: path.join(OUT, "shot_edited.png") });

  // ---- undo everything back to the pristine chart ----
  for (let i = 0; i < 5; i++) {
    await page.keyboard.down("Control");
    await page.keyboard.press("z");
    await page.keyboard.up("Control");
  }
  const undone = await page.evaluate(() => ({
    bt: ED.chart.bt.flat().length,
    fx: ED.chart.fx.flat().length,
    lasers: ED.chart.lasers.flat().length,
    undoLeft: ED.undoStack.length,
  }));
  const undoOk = undone.bt === stats.bt && undone.fx === stats.fx && undone.lasers === stats.lasers && undone.undoLeft === 0;
  console.log("after undo x5:", JSON.stringify(undone), undoOk ? "OK (pristine)" : "FAIL");

  // ---- serialize round trip inside the app ----
  const rt = await page.evaluate(() => {
    const text = KSH.serialize(ED.chart);
    const c2 = KSH.parse(text);
    return {
      len: text.length,
      bt1: ED.chart.bt.flat().length, bt2: c2.bt.flat().length,
      fx1: ED.chart.fx.flat().length, fx2: c2.fx.flat().length,
    };
  });
  console.log("in-app serialize:", JSON.stringify(rt),
    rt.bt1 === rt.bt2 && rt.fx1 === rt.fx2 ? "OK" : "FAIL");

  // ---- playback ----
  await page.evaluate(() => { ED.curMs = 60000; startPlayback(); });
  await new Promise(r => setTimeout(r, 700));
  const played = await page.evaluate(() => ({ playing: ED.playing, ms: ED.curMs }));
  await page.evaluate(() => pausePlayback());
  console.log("playback:", JSON.stringify(played),
    played.playing && played.ms > 60050 ? "OK" : "FAIL (headless audio may be limited)");

  // ---- timeline scrub ----
  const tlpos = await page.evaluate(() => {
    const r = ED.dom.timeline.getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height / 2, w: r.width };
  });
  await page.mouse.click(tlpos.x, tlpos.y);
  const seekMs = await page.evaluate(() => ED.curMs);
  console.log("timeline scrub to 50%:", Math.round(seekMs), "ms",
    Math.abs(seekMs - (await page.evaluate(() => (ED.domainStartMs() + ED.domainEndMs()) / 2))) < 2000 ? "OK" : "FAIL");

  await page.screenshot({ path: path.join(OUT, "shot_final.png") });

  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no console/page errors");
  await browser.close();
})().catch(e => { console.error("TEST CRASH:", e); process.exit(1); });
