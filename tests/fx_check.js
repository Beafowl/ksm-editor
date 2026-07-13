"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: "new",
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto("file:///c:/Users/Berkb/Desktop/Neuer%20Ordner/ksm-editor/index.html");
  await page.waitForFunction(() => typeof ED !== "undefined" && ED.chart);

  await (await page.$("#fileKsh")).uploadFile("c:/Users/Berkb/Desktop/Neuer Ordner/internetyamero_qop/mxm.ksh");
  await page.waitForFunction(() => ED.chart.meta.title.includes("INTERNET"));
  await (await page.$("#fileAudio")).uploadFile("c:/Users/Berkb/Desktop/Neuer Ordner/internetyamero_qop/m.ogg");
  await page.waitForFunction(() => AudioEng.buffer !== null, { timeout: 30000 });

  const info = await page.evaluate(() => {
    const defs = parseDefines(ED.chart);
    const regions = buildFxRegions();
    const byType = {};
    for (const r of regions) byType[r.type] = (byType[r.type] || 0) + 1;
    return {
      fxDefs: Object.keys(defs.fx),
      filterDefs: Object.keys(defs.filter),
      regions: regions.length,
      byType,
      sample: regions.slice(0, 3).map(r => `${r.type} ${Math.round(r.t0)}-${Math.round(r.t1)}ms I=${Math.round(r.I)}`),
    };
  });
  console.log("defines fx:", info.fxDefs.join(","));
  console.log("defines filter:", info.filterDefs.join(","));
  console.log("regions:", info.regions, JSON.stringify(info.byType));
  console.log("sample:", info.sample.join(" | "));

  // play through a section with FX holds and lasers, confirm laser follower runs
  const firstFx = await page.evaluate(() => {
    const r = buildFxRegions();
    return r.length ? r[0].t0 - 500 : 30000;
  });
  await page.evaluate(ms => { ED.curMs = ms; startPlayback(); }, firstFx);
  await new Promise(r => setTimeout(r, 1500));
  const state = await page.evaluate(() => ({
    playing: ED.playing,
    ms: Math.round(ED.curMs),
    laser: laserStateNow(),
  }));
  await page.evaluate(() => pausePlayback());
  console.log("playback through FX section:", JSON.stringify(state));
  await browser.close();
})().catch(e => { console.error("CRASH:", e); process.exit(1); });
