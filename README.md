# KSM Chart Editor

A browser-based chart editor for **KShootMania / Unnamed SDVX Clone** (`.ksh` format),
with an osu!-style layout: scrolling gameplay highway, tool/inspector sidebar, and a
full-song timeline scrubber.

## Run it

Open `index.html` in **Chrome or Edge** (double-click works — no server or install needed).

## Load a song / chart

| Action | How |
|---|---|
| Open a whole song folder | **📂 Folder** — picks up all `.ksh` difficulties + the audio (`m=`) automatically; **Save** writes straight back to the folder. Chromium only. |
| Open a single chart | **Open .ksh** (then **🎵 Audio** to pick the song), or just drag & drop the files onto the window. |
| Start a new chart | **🎵 Audio** → **New** → fill in metadata → set **BPM** and **Offset** (ms position in the audio where beat 1 lands). |

## Editing

- **Tools** (keys `1`–`5`): Select · BT · FX · Laser L · Laser R.
- **BT / FX**: click a lane = chip, click-drag upward = hold, click an existing chip = remove.
- **Lasers**: every click adds a point; clicking the same row makes a **slam**;
  `Enter` / `Esc` / double-click finishes the laser; right-click removes the last point.
  “New lasers 2× wide” places `laserrange=2x` lasers.
- **Right-click** deletes whatever is under the cursor. **Select** tool drags notes,
  resizes holds (grab the tail), and moves laser points.
- **Effects**: select an **FX hold** → choose effect + parameter in the Inspector
  (`Retrigger;8`, `Gate;16`, `Flanger`, `BitCrusher;10`, …). Select a **laser** →
  toggle 2× wide and set the filter (`peak` / `lpf1` / `hpf1` / `bitc`).
- **+BPM** inserts a BPM change at the current position.
- `Ctrl+Z` / `Ctrl+Y` undo/redo · `Del` delete selection · `Ctrl+S` save.

## Navigation & playback

- `Space` play/pause · scroll wheel steps by the snap division (`Ctrl+wheel` zooms).
- `↑`/`↓` step by snap, `PgUp`/`PgDn` by measure, `Home`/`End` jump to start/last note.
- Click or drag the bottom timeline to jump anywhere; playback speed 25–100 %,
  optional hitsounds and metronome.

## Notes

- Charts round-trip safely: lane spins, `zoom_*`/`tilt`/`stop` lines and other
  unrecognized commands in existing charts are preserved on save.
- FX/laser effects are chart data — the editor shows them but does not render them audibly.
- Files: `ksh.js` (format + timing), `audio.js` (Web Audio engine), `render.js`
  (highway + timeline), `app.js` (editor logic/UI), `index.html`/`style.css` (shell).
