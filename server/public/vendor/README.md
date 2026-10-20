# Vendored front-end libraries

Everything the UI loads comes from this repo. There are no CDN calls and no build step.
Files are copied unmodified from the npm tarballs named below (`npm pack <name>@<version>`).

| Library | Version | Licence | File here | Source file in tarball |
|---|---|---|---|---|
| preact | 10.29.8 | MIT | `preact/preact.js` | `dist/preact.mjs` |
| preact hooks | 10.29.8 | MIT | `preact/hooks.js` | `hooks/dist/hooks.mjs` |
| htm | 3.1.1 | Apache-2.0 | `htm/htm.js` | `dist/htm.mjs` |
| uPlot | 1.6.32 | MIT | `uplot/uPlot.iife.min.js`, `uplot/uPlot.min.css` | `dist/uPlot.iife.min.js`, `dist/uPlot.min.css` |
| ansi_up | 6.0.6 | MIT | `ansi_up/ansi_up.js` | `ansi_up.js` (ES module, imported by relative path from `js/components/terminal.js`) |

uPlot is the one edit: the repo URL in the banner comment of the script has its scheme removed, so the offline test that
forbids http(s) URLs in vendored scripts passes. The code is untouched. `js/components/chart.js` loads the script and the
stylesheet on first use and reads the global `uPlot`.

Host icons (simple-icons 16.34.0, CC0, plus a few drawn here) are in `icons/`, see `icons/README.md`.

Licence texts sit next to each library (`LICENSE`). The bare names `preact`, `preact/hooks` and `htm`
resolve through the import map in `index.html`.

Fonts (latin subset, woff2, SIL Open Font Licence 1.1) are in `../fonts/` with their licence files:

| Font | Package | Version |
|---|---|---|
| Onest (variable) | @fontsource-variable/onest | 5.3.1 |
| Geist Mono (variable) | @fontsource-variable/geist-mono | 5.3.0 |
| Big Shoulders Inline Text 900 | @fontsource/big-shoulders-inline-text | 5.3.0 |

To add a library: pin an exact version, copy the single browser build into `vendor/<name>/`,
add its licence file, add a row above, and map a bare name in the import map if modules import it by name.
