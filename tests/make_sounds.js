"use strict";
// Convert USC default-skin sounds into a compact base64 JS module for the editor.
// Downmix to mono, trim silence, cap length, re-encode as 16-bit WAV.
const fs = require("fs");
const path = require("path");

const SRC = "c:/Users/Berkb/Desktop/Neuer Ordner/unnamed-sdvx-clone/bin/skins/Default/audio";
const OUT = "c:/Users/Berkb/Desktop/Neuer Ordner/ksm-editor/sounds.js";

const MAP = {
  bt: "clap.wav",
  fx: "clap_punchy.wav",
  slam: "laser_slam.wav",
  methi: "click-01.wav",
  metlo: "click-02.wav",
};

function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("not a wav");
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    else if (id === "data") data = buf.slice(pos + 8, pos + 8 + size);
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("missing chunks");
  if (fmt.bits !== 16) throw new Error("expected 16-bit, got " + fmt.bits);
  return { fmt, data };
}

function convert(file, maxSec) {
  const { fmt, data } = parseWav(fs.readFileSync(path.join(SRC, file)));
  const frames = data.length / 2 / fmt.channels;
  // downmix
  let mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = s / fmt.channels / 32768;
  }
  // trim silence
  let peak = 0;
  for (const v of mono) peak = Math.max(peak, Math.abs(v));
  const thr = peak * 0.004;
  let s0 = 0, s1 = mono.length - 1;
  while (s0 < s1 && Math.abs(mono[s0]) < thr) s0++;
  while (s1 > s0 && Math.abs(mono[s1]) < thr) s1--;
  s0 = Math.max(0, s0 - Math.round(fmt.rate * 0.003));
  s1 = Math.min(mono.length - 1, s1 + Math.round(fmt.rate * 0.01));
  mono = mono.slice(s0, s1 + 1);
  // cap length with fade-out
  const maxLen = Math.round(fmt.rate * maxSec);
  if (mono.length > maxLen) {
    mono = mono.slice(0, maxLen);
    const fade = Math.round(fmt.rate * 0.05);
    for (let i = 0; i < fade; i++) mono[mono.length - fade + i] *= 1 - i / fade;
  }
  // normalize to -1 dBFS-ish
  const g = peak > 0 ? 0.89 / peak : 1;
  // encode wav
  const out = Buffer.alloc(44 + mono.length * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + mono.length * 2, 4); out.write("WAVE", 8);
  out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(fmt.rate, 24); out.writeUInt32LE(fmt.rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(mono.length * 2, 40);
  for (let i = 0; i < mono.length; i++)
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mono[i] * g * 32767))), 44 + i * 2);
  return out;
}

let js = `"use strict";
/* USC default-skin sounds (unnamed-sdvx-clone, MIT license), converted to
 * mono 16-bit WAV and embedded as base64 so they load from file:// URLs.
 * bt/fx = clap / clap_punchy, slam = laser_slam, methi/metlo = click-01/02. */
const GAME_SOUNDS = {
`;
for (const [key, file] of Object.entries(MAP)) {
  const wav = convert(file, key === "slam" ? 1.2 : 0.8);
  js += `  ${key}: "${wav.toString("base64")}",\n`;
  console.log(`${key} <- ${file}: ${wav.length} bytes (${Math.round(wav.length / 44100 / 2 * 1000)}ms)`);
}
js += "};\n";
fs.writeFileSync(OUT, js);
console.log("wrote", OUT, Math.round(js.length / 1024) + "KB");
