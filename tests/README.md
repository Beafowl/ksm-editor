# Tests

Run with Node from this folder. Chart/song paths point at the sibling
`Show/` and `internetyamero_qop/` folders in the parent directory —
adjust the constants at the top of each script if those move.

| Script | What it checks | Needs |
|---|---|---|
| `ksh_test.js` | Parse → serialize → parse round-trip of every reference chart is semantically lossless and byte-stable on the second pass. | node only |
| `e2e_test.js` | Full editor flow in a headless browser: load chart + audio, place/remove notes by mouse, FX hold drag + effect apply, laser drawing, undo to pristine, playback, timeline scrubbing. | `npm i puppeteer-core` + Chrome |
| `fx_check.js` | FX preview plan: #define resolution, effect region building, playback through an effected section. | puppeteer-core + Chrome |
| `feat_check.js` | Spin editing, +Sig, +Cmd, events panel, custom effect dropdowns. | puppeteer-core + Chrome |
| `gameview_check.js` | Game view screenshots at neutral / zoomed / mid-spin / split sections. | puppeteer-core + Chrome |
| `gv_play_check.js` | Playback through a spin in game view (roll-lerp simulation path). | puppeteer-core + Chrome |

The puppeteer scripts expect Chrome at
`C:\Program Files\Google\Chrome\Application\chrome.exe` — edit
`executablePath` if yours lives elsewhere.
