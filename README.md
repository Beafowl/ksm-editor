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
  Placing or dragging a point **outside the track** automatically turns the laser
  into a 2× wide (`laserrange=2x`) one, keeping its points visually in place.
- **Curves**: select a laser point, pick a shape (smooth / ease in / ease out) in the
  Inspector and hit **Curve to next point** — the straight span is subdivided into an
  eased curve at the current snap resolution.
- **Right-click** deletes whatever is under the cursor. **Select** tool drags notes,
  resizes holds (grab the tail), and moves laser points. **Shift+click** builds a
  multi-selection: drag moves everything together, `Del` deletes all, and choosing
  an effect applies it to every selected FX hold.
- **Effects**: select an **FX hold** → choose effect + parameter in the Inspector
  (`Retrigger;8`, `Gate;16`, `Flanger`, `BitCrusher;10`, …). Custom `#define_fx` /
  `#define_filter` effects from the chart appear in the dropdowns too. Select a
  **laser** → toggle 2× wide and set the filter (`peak` / `lpf1` / `hpf1` / `bitc`).
- **Spins**: select a **laser point** → add a lane spin / half-spin / swing with a
  length (put them on slams).
- **Tap timing** (`T` or the Tap button, osu!-style): play the song and tap to the
  beat — BPM is fitted from your taps (works at slow playback speeds too) and the
  offset from their beat phase; apply either with one click.
- **Timing & camera**: **+BPM** and **+Sig** insert tempo / time-signature changes at
  the cursor; **+Cmd** / “+ Add event” insert commands (`zoom_top`, `zoom_bottom`,
  `zoom_side`, `tilt`, `stop`, …). The **Events** panel lists everything in the
  current measure with readable labels, tooltips explaining each command, and ✎ / ×
  to edit or delete. A full **Chart events reference** lives in the ? help dialog.
- `Ctrl+Z` / `Ctrl+Y` undo/redo · `Del` delete selection · `Ctrl+S` save.

## Game view

The editor opens in **Split** view — the 2D editor next to an in-game style 3D
preview. The **View** dropdown (or **Tab**) switches Editor / Split / Game. The
3D track is modeled on Unnamed SDVX Clone's camera
(`Main/src/Camera.cpp`): `zoom_top` pitches, `zoom_bottom` zooms, `zoom_side`
shifts, `tilt` rolls (laser-driven, keyword and manual numeric), lane **spins /
half-spins / swings** animate with USC's exact easing, and `stop` freezes the
scroll. Scrubbing the timeline through a spin previews it frame by frame. The
**Lane Speed** number applies to both the editor and the game view
(`Ctrl+Scroll` on either view adjusts it). Split view keeps the 2D editor
interactive next to the 3D preview.

## Navigation & playback

- `Space` play/pause · scroll wheel steps by the snap division (`Ctrl+wheel` changes
  lane speed).
- `↑`/`↓` step by snap, `PgUp`/`PgDn` by measure, `Home`/`End` jump to start/last note.
- Click or drag the bottom timeline to jump anywhere; playback speed 25–100 %.
- **FX preview** (toggle in the Playback panel) plays a real-time approximation of
  FX-hold effects (Retrigger, Gate, Wobble, Flanger, TapeStop, PitchShift, Echo,
  SideChain, BitCrusher, Phaser) and sweeps a filter with the lasers
  (`peak`/`lpf1`/`hpf1`). The in-game DSP will sound richer — treat it as a sketch.
- Hitsounds are the actual USC default-skin samples (clap / punchy clap for BT/FX,
  `laser_slam` for slams, `click-01/02` for the metronome), embedded in `sounds.js`
  (regenerate with `tests/make_sounds.js` if the USC folder moves).
- Song, hitsound and metronome volumes each have their own slider.
- Your settings (lane speed, snap, view mode, playback speed, volumes, toggles,
  wide-laser default) are saved locally and restored the next time the editor opens.

## Notes

- Charts round-trip safely: unrecognized commands in existing charts are preserved
  verbatim on save (verified against the bundled Show and INTERNET YAMERO charts).
- Files: `ksh.js` (format + timing), `audio.js` (Web Audio engine), `fxdsp.js`
  (FX/laser audio preview), `render.js` (highway + timeline), `gameview.js`
  (3D game-style preview), `app.js` (editor logic/UI), `index.html`/`style.css`
  (shell).
