# Vendored front-end libraries

Everything the UI loads comes from this repo. There are no CDN calls and no build step.
Files are copied unmodified from the npm tarballs named below (`npm pack <name>@<version>`).

| Library | Version | Licence | File here | Source file in tarball |
|---|---|---|---|---|
| preact | 10.29.8 | MIT | `preact/preact.js` | `dist/preact.mjs` |
| preact hooks | 10.29.8 | MIT | `preact/hooks.js` | `hooks/dist/hooks.mjs` |
| htm | 3.1.1 | Apache-2.0 | `htm/htm.js` | `dist/htm.mjs` |

Licence texts sit next to each library (`LICENSE`). The bare names `preact`, `preact/hooks` and `htm`
resolve through the import map in `index.html`.

Fonts (latin subset, woff2, SIL Open Font Licence 1.1) are in `../fonts/` with their licence files:

| Font | Package | Version |
|---|---|---|
| Onest (variable) | @fontsource-variable/onest | 5.3.1 |
| Geist Mono (variable) | @fontsource-variable/geist-mono | 5.3.0 |
| Big Shoulders Inline Text 900 | @fontsource/big-shoulders-inline-text | 5.3.0 |

## Planned (not added yet)

| Library | Purpose | Added by |
|---|---|---|
| ansi_up | Colour job output (ANSI escapes) in the job drawer and log views | job drawer item |
| uPlot | Metrics charts on the host Metrics tab | metrics item |

To add a library: pin an exact version, copy the single browser build into `vendor/<name>/`,
add its licence file, add a row above, and map a bare name in the import map if modules import it by name.
