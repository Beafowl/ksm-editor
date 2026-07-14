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
  (`Retrigger;8`, `Gate;16`, `Flanger`, `BitCrusher;10`, …). Custom `#define_fx` /
  `#define_filter` effects from the chart appear in the dropdowns too. Select a
  **laser** → toggle 2× wide and set the filter (`peak` / `lpf1` / `hpf1` / `bitc`).
- **Spins**: select a **laser point** → add a lane spin / half-spin / swing with a
  length (put them on slams).
- **Timing & camera**: **+BPM** and **+Sig** insert tempo / time-signature changes at
  the cursor; **+Cmd** inserts raw commands (`zoom_top`, `zoom_bottom`, `zoom_side`,
  `tilt`, `stop`, …). The **Events** panel lists everything in the current measure
  with one-click delete.
- `Ctrl+Z` / `Ctrl+Y` undo/redo · `Del` delete selection · `Ctrl+S` save.

## Game view

**Tab** (or the Editor / Split / Game buttons in the top bar) switches to an in-game
style 3D preview of the track, modeled on Unnamed SDVX Clone's camera
(`Main/src/Camera.cpp`): `zoom_top` pitches, `zoom_bottom` zooms, `zoom_side`
shifts, `tilt` rolls (laser-driven, keyword and manual numeric), lane **spins /
half-spins / swings** animate with USC's exact easing, and `stop` freezes the
scroll. Scrubbing the timeline through a spin previews it frame by frame. The
**HiSpeed** slider (or `Ctrl+Scroll` on the game view) controls its scroll speed.
Split view keeps the 2D editor interactive next to the 3D preview.

## Navigation & playback

- `Space` play/pause · scroll wheel steps by the snap division (`Ctrl+wheel` changes
  lane speed).
- `↑`/`↓` step by snap, `PgUp`/`PgDn` by measure, `Home`/`End` jump to start/last note.
- Click or drag the bottom timeline to jump anywhere; playback speed 25–100 %.
- **FX preview** (toggle in the Playback panel) plays a real-time approximation of
  FX-hold effects (Retrigger, Gate, Wobble, Flanger, TapeStop, PitchShift, Echo,
  SideChain, BitCrusher, Phaser) and sweeps a filter with the lasers
  (`peak`/`lpf1`/`hpf1`). The in-game DSP will sound richer — treat it as a sketch.
- Song, hitsound and metronome volumes each have their own slider.

## Notes

- Charts round-trip safely: unrecognized commands in existing charts are preserved
  verbatim on save (verified against the bundled Show and INTERNET YAMERO charts).
- Files: `ksh.js` (format + timing), `audio.js` (Web Audio engine), `fxdsp.js`
  (FX/laser audio preview), `render.js` (highway + timeline), `gameview.js`
  (3D game-style preview), `app.js` (editor logic/UI), `index.html`/`style.css`
  (shell).
