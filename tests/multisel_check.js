"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: "new",
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  page.on("console", m => { if (m.type() === "error") console.log("CONSOLE:", m.text()); });
  await page.goto("file:///c:/Users/Berkb/Desktop/Neuer%20Ordner/ksm-editor/index.html");
  await page.waitForFunction(() => typeof ED !== "undefined" && ED.chart);

  await (await page.$("#fileKsh")).uploadFile("c:/Users/Berkb/Desktop/Neuer Ordner/Show/Show(exh).ksh");
  await page.waitForFunction(() => ED.chart.meta.title === "Show");
  await page.evaluate(() => { ED.curMs = 68000; setTool("select"); });
  await new Promise(r => setTimeout(r, 200));

  // find screen positions of three BT chips near the cursor
  const spots = await page.evaluate(() => {
    const G = Render.geom();
    const r = ED.dom.highway.getBoundingClientRect();
    const cur = ED.timing.msToTick(ED.curMs);
    const out = [];
    for (let l = 0; l < 4 && out.length < 3; l++)
      for (const n of ED.chart.bt[l]) {
        if (n.l === 0 && n.y > cur && n.y < cur + 500) {
          const y = G.yOfTick(n.y);
          if (y > 40 && y < r.height - 40) { out.push({ x: r.left + G.laneX(l) + G.laneW / 2, y: r.top + y }); break; }
        }
      }
    return out;
  });
  console.log("chip spots found:", spots.length);

  // shift+click three chips
  await page.mouse.click(spots[0].x, spots[0].y);
  await page.keyboard.down("Shift");
  await page.mouse.click(spots[1].x, spots[1].y);
  await page.mouse.click(spots[2].x, spots[2].y);
  await page.keyboard.up("Shift");
  let st = await page.evaluate(() => ({ n: ED.selList.length, info: ED.dom.inspMultiInfo.textContent }));
  console.log("multi-select:", JSON.stringify(st), st.n === 3 ? "OK" : "FAIL");

  // shift+click the second chip again -> deselect it
  await page.keyboard.down("Shift");
  await page.mouse.click(spots[1].x, spots[1].y);
  await page.keyboard.up("Shift");
  st = await page.evaluate(() => ({ n: ED.selList.length }));
  console.log("shift-toggle off:", JSON.stringify(st), st.n === 2 ? "OK" : "FAIL");

  // group drag: grab first selected chip, move up one beat
  const before = await page.evaluate(() => ED.selList.map(s => s.note.y));
  await page.mouse.move(spots[0].x, spots[0].y);
  await page.mouse.down();
  await page.mouse.move(spots[0].x, spots[0].y - 96, { steps: 4 }); // 96px = 48t at zoom 2
  await page.mouse.up();
  const after = await page.evaluate(() => ED.selList.map(s => s.note.y));
  const deltas = after.map((y, i) => y - before[i]);
  console.log("group drag deltas:", JSON.stringify(deltas),
    deltas.length === 2 && deltas[0] === deltas[1] && deltas[0] > 0 ? "OK" : "FAIL");

  // group delete
  const total0 = await page.evaluate(() => ED.chart.bt.flat().length);
  await page.keyboard.press("Delete");
  const total1 = await page.evaluate(() => ED.chart.bt.flat().length);
  console.log("group delete:", total0, "->", total1, total1 === total0 - 2 ? "OK" : "FAIL");

  // batch FX effect: select two FX holds programmatically
  const fxBatch = await page.evaluate(() => {
    const holds = [];
    for (let s = 0; s < 2; s++)
      for (const n of ED.chart.fx[s]) if (n.l > 0 && holds.length < 2) holds.push({ type: "fx", lane: s, note: n });
    ED.selList = holds; ED.sel = holds[1]; updateInspector();
    ED.dom.selFxType.value = "Gate";
    ED.dom.selFxType.dispatchEvent(new Event("change"));
    return holds.map(h => h.note.fx);
  });
  console.log("batch effect:", JSON.stringify(fxBatch),
    fxBatch.every(f => f === "Gate;16") ? "OK" : "FAIL");

  // event edit via prompt: change a BPM... use a zoom event instead (chart has none) -> use spins chart
  await page.evaluate(() => undo()); // revert batch effect for cleanliness

  // events panel: friendly rows + edit button on mxm
  await page.evaluate(() => { ED.dirty = false; });
  await (await page.$("#fileKsh")).uploadFile("c:/Users/Berkb/Desktop/Neuer Ordner/internetyamero_qop/mxm.ksh");
  await page.waitForFunction(() => ED.chart.meta.title.includes("INTERNET"));
  await page.evaluate(() => { ED.curMs = ED.timing.tickToMs(200); });
  await new Promise(r => setTimeout(r, 250));
  const rows = await page.evaluate(() =>
    [...ED.dom.eventList.querySelectorAll(".evrow")].slice(0, 5).map(r => r.textContent.trim()));
  console.log("friendly rows:", JSON.stringify(rows, null, 0));

  // edit first zoom event via prompt override
  const edited = await page.evaluate(() => {
    window.prompt = () => "zoom_top=99";
    const row = [...ED.dom.eventList.querySelectorAll(".evrow")]
      .find(r => r.querySelector(".evtag").textContent === "Cam pitch");
    row.querySelectorAll("button")[0].click(); // edit
    return ED.chart.other.some(o => o.s === "zoom_top=99");
  });
  console.log("event edit:", edited ? "OK" : "FAIL");

  await page.screenshot({ path: path.join(__dirname, "sidebar_new.png") });
  await browser.close();
})().catch(e => { console.error("CRASH:", e); process.exit(1); });
