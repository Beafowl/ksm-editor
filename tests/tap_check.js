"use strict";
// Setup-page tap tool: simulated beat-aligned taps must recover BPM + offset.
const puppeteer = require("puppeteer-core");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: "new",
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto("file:///c:/Users/Berkb/Desktop/Neuer%20Ordner/ksm-editor/index.html");
  await page.waitForFunction(() => typeof ED !== "undefined" && ED.chart);
  await (await page.$("#fileKsh")).uploadFile("c:/Users/Berkb/Desktop/Neuer Ordner/Show/Show.ksh");
  await page.waitForFunction(() => ED.chart.meta.title === "Show");
  await (await page.$("#fileAudio")).uploadFile("c:/Users/Berkb/Desktop/Neuer Ordner/Show/Show.ogg");
  await page.waitForFunction(() => AudioEng.buffer !== null, { timeout: 30000 });

  // sabotage current values so we can see the tool fix them
  await page.evaluate(() => {
    ED.chart.bpms[0].v = 100;
    ED.chart.meta.o = "0";
    rebuildTiming();
  });

  // open setup, play, "tap" on the true beats (132 BPM, offset -133)
  const result = await page.evaluate(async () => {
    ED.dom.btnSetup.click();
    ED.curMs = 5000;
    startPlayback();
    const P = 60000 / 132, off = -133;
    let k = Math.ceil((AudioEng.positionMs() + 300 - off) / P);
    for (let n = 0; n < 16; n++, k++) {
      const target = off + k * P;
      while (AudioEng.positionMs() < target) await new Promise(r => setTimeout(r, 2));
      ED.dom.btnTapPad.click();
    }
    const ui = {
      count: ED.dom.tapCount.textContent,
      bpm: ED.dom.tapBpm.textContent,
      offset: ED.dom.tapOffset.textContent,
    };
    ED.dom.btnTapUseBoth.click();     // fills the setup fields
    const fields = { bpm: ED.dom.sBpm.value, off: ED.dom.sOffset.value };
    ED.dom.btnSetupDone.click();      // applies to the chart
    pausePlayback();
    return {
      ui, fields,
      applied: { bpm: ED.chart.bpms[0].v, o: ED.chart.meta.o },
      setupClosed: ED.dom.setupScreen.style.display === "none",
    };
  });
  console.log("tap UI:", JSON.stringify(result.ui));
  console.log("fields:", JSON.stringify(result.fields), "applied:", JSON.stringify(result.applied), "closed:", result.setupClosed);
  const P = 60000 / 132;
  let offErr = (parseFloat(result.applied.o) - -133) % P;
  if (offErr > P / 2) offErr -= P; if (offErr < -P / 2) offErr += P;
  const ok = result.applied.bpm === 132 && Math.abs(offErr) < 25 && result.setupClosed;
  console.log(`bpm=${result.applied.bpm} (want 132), offset phase error=${offErr.toFixed(1)}ms (want <25)`, ok ? "OK" : "FAIL");
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error("CRASH:", e); process.exit(1); });
