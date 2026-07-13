"use strict";
// Round-trip test: parse -> serialize -> parse, compare semantic content.
const fs = require("fs");
const path = require("path");
const KSH = require("c:/Users/Berkb/Desktop/Neuer Ordner/ksm-editor/ksh.js");

const dirs = [
  "c:/Users/Berkb/Desktop/Neuer Ordner/Show",
  "c:/Users/Berkb/Desktop/Neuer Ordner/internetyamero_qop",
];
const files = dirs.flatMap(dir =>
  fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".ksh")).map(f => path.join(dir, f)));

function summarize(c) {
  return {
    bt: c.bt.map(l => l.map(n => `${n.y}:${n.l}`).join(",")),
    fx: c.fx.map(l => l.map(n => `${n.y}:${n.l}:${n.fx || ""}`).join(",")),
    lasers: c.lasers.map(sd => sd.map(g => `w${g.wide}[` + g.points.map(p => `${p.y}@${Math.round(p.v * 50)}`).join(" ") + "]").join("|")),
    bpms: c.bpms.map(b => `${b.y}:${b.v}`).join(","),
    sigs: c.sigs.map(s => `${s.y}:${s.n}/${s.d}`).join(","),
    filters: c.filters.map(f => `${f.y}:${f.v}`).join(","),
    spins: c.spins.map(s => `${s.y}:${s.s}`).join(","),
    other: c.other.map(o => `${o.y}:${o.s}`).join(","),
  };
}

function counts(c) {
  return {
    btChips: c.bt.flat().filter(n => n.l === 0).length,
    btHolds: c.bt.flat().filter(n => n.l > 0).length,
    fxChips: c.fx.flat().filter(n => n.l === 0).length,
    fxHolds: c.fx.flat().filter(n => n.l > 0).length,
    laserSegs: c.lasers.flat().length,
    laserPts: c.lasers.flat().reduce((a, g) => a + g.points.length, 0),
    fxWithEffect: c.fx.flat().filter(n => n.fx).length,
    wideSegs: c.lasers.flat().filter(g => g.wide === 2).length,
  };
}

let fail = 0;
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const c1 = KSH.parse(text);
  const out = KSH.serialize(c1);
  const c2 = KSH.parse(out);
  const s1 = JSON.stringify(summarize(c1));
  const s2 = JSON.stringify(summarize(c2));
  const ok = s1 === s2;
  console.log(`${ok ? "PASS" : "FAIL"}  ${path.basename(path.dirname(f))}/${path.basename(f)}`);
  console.log("   ", JSON.stringify(counts(c1)));
  if (!ok) {
    fail++;
    const a = summarize(c1), b = summarize(c2);
    for (const k of Object.keys(a)) {
      const av = JSON.stringify(a[k]), bv = JSON.stringify(b[k]);
      if (av !== bv) {
        // find first diff position
        let i = 0;
        while (i < Math.min(av.length, bv.length) && av[i] === bv[i]) i++;
        console.log(`    DIFF ${k}:`);
        console.log(`      A ...${av.slice(Math.max(0, i - 60), i + 120)}`);
        console.log(`      B ...${bv.slice(Math.max(0, i - 60), i + 120)}`);
      }
    }
  }
  // second-generation stability: serialize(c2) must equal serialize(c1)
  const out2 = KSH.serialize(c2);
  if (out2 !== out) { console.log("    UNSTABLE second serialization!"); fail++; }
}
// timing sanity on one chart
const c = KSH.parse(fs.readFileSync(path.join(dirs[0], "Show.ksh"), "utf8"));
const t = KSH.buildTiming(c);
console.log("timing: o=", c.meta.o, " tick0->", t.tickToMs(0), "ms; tick192->", t.tickToMs(192).toFixed(2),
  "ms; roundtrip msToTick(tickToMs(960))=", t.msToTick(t.tickToMs(960)).toFixed(3));
process.exit(fail ? 1 : 0);
