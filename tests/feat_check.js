"use strict";
const puppeteer = require("puppeteer-core");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: "new",
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  page.on("console", m => { if (m.type() === "error") console.log("CONSOLE:", m.text()); });
  await page.goto("file:///c:/Users/Berkb/Desktop/Neuer%20Ordner/ksm-editor/index.html");
  await page.waitForFunction(() => typeof ED !== "undefined" && ED.chart);

  await (await page.$("#fileKsh")).uploadFile("c:/Users/Berkb/Desktop/Neuer Ordner/internetyamero_qop/mxm.ksh");
  await page.waitForFunction(() => ED.chart.meta.title.includes("INTERNET"));

  // 1. custom effect/filter names in dropdowns
  const dd = await page.evaluate(() => ({
    fx: [...ED.dom.selFxType.options].map(o => o.value),
    filter: [...ED.dom.selFilter.options].map(o => o.value),
  }));
  console.log("fx dropdown has custom names:", ["ret", "wb", "sc2", "f3"].every(n => dd.fx.includes(n)) ? "OK" : "FAIL", `(${dd.fx.length} entries)`);
  console.log("filter dropdown has customs:", ["ga", "re", "sc", "ts"].every(n => dd.filter.includes(n)) ? "OK" : "FAIL", dd.filter.join(","));

  // 2. events panel shows zoom/tilt lines of measure 2
  await page.evaluate(() => { ED.curMs = ED.timing.tickToMs(200); });
  await new Promise(r => setTimeout(r, 200));
  const evCount = await page.evaluate(() => ED.dom.eventList.querySelectorAll(".evrow").length);
  console.log("events panel rows in measure 2:", evCount, evCount > 0 ? "OK" : "FAIL");

  // 3. spin editing on a laser point
  const spin = await page.evaluate(() => {
    const seg = ED.chart.lasers[0].find(s => s.points.length >= 2);
    setSel({ type: "laserpoint", side: 0, seg, pt: 0 });
    ED.dom.selSpin.value = "@(";
    ED.dom.inSpinLen.value = 96;
    ED.dom.selSpin.dispatchEvent(new Event("change"));
    const y = seg.points[0].y;
    const sp = ED.chart.spins.find(s => s.y === y);
    return { added: sp ? sp.s : null, boxShown: ED.dom.spinBox.style.display !== "none" };
  });
  console.log("spin applied:", JSON.stringify(spin), spin.added === "@(96" && spin.boxShown ? "OK" : "FAIL");

  // 4. +Sig with prompt override
  const sig = await page.evaluate(() => {
    window.prompt = () => "7/8";
    ED.curMs = ED.timing.tickToMs(KSH.measureAt(ED.measures, 0).ticks * 3); // measure 4
    ED.dom.btnInsSig.click();
    return ED.chart.sigs.map(s => `${s.y}:${s.n}/${s.d}`).slice(0, 3);
  });
  console.log("+Sig 7/8 at measure 4:", JSON.stringify(sig), sig.some(s => s.endsWith("7/8")) ? "OK" : "FAIL");
  await page.evaluate(() => undo()); // revert sig for clean serialize compare

  // 5. +Cmd insertion
  const cmd = await page.evaluate(() => {
    window.prompt = () => "zoom_top=42";
    ED.curMs = 0;
    ED.dom.btnInsCmd.click();
    return ED.chart.other.filter(o => o.s === "zoom_top=42").length;
  });
  console.log("+Cmd zoom_top=42 inserted:", cmd === 1 ? "OK" : "FAIL");

  // 6. spin + cmd survive serialize round-trip
  const rt = await page.evaluate(() => {
    const c2 = KSH.parse(KSH.serialize(ED.chart));
    return {
      spin: c2.spins.some(s => s.s === "@(96"),
      cmd: c2.other.some(o => o.s === "zoom_top=42"),
      spins1: ED.chart.spins.length, spins2: c2.spins.length,
      other1: ED.chart.other.length, other2: c2.other.length,
    };
  });
  console.log("round-trip:", JSON.stringify(rt), rt.spin && rt.cmd && rt.spins1 === rt.spins2 && rt.other1 === rt.other2 ? "OK" : "FAIL");

  await browser.close();
})().catch(e => { console.error("CRASH:", e); process.exit(1); });
