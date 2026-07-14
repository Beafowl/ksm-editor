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
  await page.setViewport({ width: 1500, height: 950 });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("file:///c:/Users/Berkb/Desktop/Neuer%20Ordner/ksm-editor/index.html");
  await page.waitForFunction(() => typeof ED !== "undefined" && ED.chart);
  await (await page.$("#fileKsh")).uploadFile("c:/Users/Berkb/Desktop/Neuer Ordner/internetyamero_qop/mxm.ksh");
  await page.waitForFunction(() => ED.chart.meta.title.includes("INTERNET"));
  await (await page.$("#fileAudio")).uploadFile("c:/Users/Berkb/Desktop/Neuer Ordner/internetyamero_qop/m.ogg");
  await page.waitForFunction(() => AudioEng.buffer !== null, { timeout: 30000 });

  // play through the first spin in game view for 3 seconds
  await page.evaluate(() => {
    setViewMode("game");
    ED.curMs = ED.timing.tickToMs(ED.chart.spins[0].y) - 1200;
    startPlayback();
  });
  await new Promise(r => setTimeout(r, 3000));
  const state = await page.evaluate(() => ({ playing: ED.playing, ms: Math.round(ED.curMs) }));
  await page.screenshot({ path: path.join(__dirname, "gv_playing.png") });
  await page.evaluate(() => pausePlayback());
  console.log("playback in game view:", JSON.stringify(state), state.playing ? "OK" : "FAIL");
  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no errors");
  await browser.close();
})().catch(e => { console.error("CRASH:", e); process.exit(1); });
