# <img alt="Keymap Editor Icon" height="24px" src="./apps/web/public/editor-icon.png" /> Keymap Editor

**Try it:** [zmk-keymap-editor.com](https://zmk-keymap-editor.com/)

Browser editor for [ZMK](https://zmk.dev/) keymaps that shows what a key **actually types** on the host — not only the firmware binding line.

This fork ([katafoxi/keymap-editor-extended](https://github.com/katafoxi/keymap-editor-extended)) builds on [nickcoutsos/keymap-editor](https://github.com/nickcoutsos/keymap-editor). Upstream hosted app: [keymap-editor](https://nickcoutsos.github.io/keymap-editor/). Upstream discussion: [Talk to me!](https://github.com/nickcoutsos/keymap-editor/discussions).

## What this fork adds

You combine:

1. **Firmware** — ZMK layers, hold-taps, behaviours (`&kp`, `&mt`, `&lt`, …), combos, conditional layers, encoders
2. **Host layouts** — OS language tables (EN, RU, UK, DE, …) with AltGr levels

so each keycap can show composed legends (e.g. `qQ` + `йЙ`) while you still edit the ZMK binding. Host glyphs are editable with **Alt+click** on a composed row; plain click opens the ZMK key editor.

Monorepo: Svelte 5 + Vite (`apps/web`), thin Hono API (`apps/api`), shared domain in `packages/keymap-core`.

## Screenshots

### Demo — real board layout

First visit opens **Demo · Corne**. The [Demo catalog](packages/keymap-core/fixtures/demo/catalog.json) also includes Glove80, Kyria, Sofle, Lily58, Sweep, Planck, nice!60, Kabarga, Lark, PNCATEHO, and more. A short spotlight tour covers click / Alt+click, layers, and bringing your own keymap. If the browser prefers Russian, Ukrainian, or German, that language is added as a second host column. Edits stay in the browser until you use **Clipboard**, **GitHub**, or **Local**. Replay the tour anytime with **Tour** in the top-right corner.

![Demo board with composed legends (Lark example with EN + RU)](docs/screenshots/demo-lark.png)

### Clipboard — `.keymap` only

Paste a ZMK `.keymap` without `info.json` (Clipboard), or open a GitHub `zmk-config` that lacks a layout file: the app draws a **flat rectangular** board from the binding count so you can still edit. GitHub and Local also accept `config/<keymap-name>.json` when `config/info.json` is absent. Clipboard **Copy .keymap** / GitHub **Commit** update the keymap; add a layout file when you want the real geometry.

![Clipboard mode with inferred rectangular layout](docs/screenshots/clipboard-inferred.png)

### Scheme — matrix row/col

**Scheme** overlays matrix coordinates and row/column guides on the physical layout (useful when wiring or checking `info.json`).

![Scheme mode on Lily58](docs/screenshots/scheme-lily58.png)

### Host edit — Alt+click

Hover peeks at host levels; **Alt+click** locks an edit session (Accept / Cancel). System layouts fork to a user copy on first change; Linux (xkb) and Windows (`.klc`) install live in the Host lane.

![Host symbol catalog and decode edit for EN + RU](docs/screenshots/host-edit.png)

### Several national layouts

Legend strip: show/hide languages and pick system or user profiles. **Stack** and **Differences** sit on the assembly line (left of remembered chips), not in the Host lane. Up to two languages on the keycap; more columns in the table.

![Legend strip with multiple languages and layers](docs/screenshots/host-legend-languages.png)

## Keymap sources

| Source | Role |
|--------|------|
| **Demo** | Bundled fixtures for first visit (default Corne). No firmware write. Short coach tour; optional second host language from the browser locale. |
| **Clipboard** | Paste `.keymap` (`info.json` optional). **Copy .keymap** → system clipboard + preview dialog. |
| **GitHub** | Load/commit `zmk-config` via GitHub App + OAuth. `config/info.json` is optional; a matching `config/<keymap-name>.json` is also accepted (flat rectangular board otherwise). Host layouts share the commit as `host_keymap/snapshot.json` (+ Linux/Windows install files). **Latest** firmware artifact chip when available. |
| **Local** | Dev adapter to a sibling `zmk-config` (junction). Not the long-term product path. |

Product persistence is **GitHub-first**; Local is for iterating against a cloned firmware tree; Clipboard is browser-only paste/export. Save/load rules: [ADR 0001](docs/adr/0001-persistence-github-first.md), [ADR 0002](docs/adr/0002-keymap-file-contract.md), host snapshot [ADR 0005](docs/adr/0005-host-keymap-github-snapshot.md).

## Editor highlights

- One **KeyEditor**: behaviour chips, then the value grid (keys, layers, mods, mouse/BT commands). Enter applies; Esc cancels. Hold-tap timing for `&mt` and `&lt`, plus Homerow (`&hm`) and Autoshift (`&as`); Apply adds a missing preset and Save rewrites those nodes ([ADR 0002](docs/adr/0002-keymap-file-contract.md)).
- **Recipes**: built-in `&rgblayer` (layer + RGB color) from Presets — board shows `Ln` plus a color swatch; Save splices a fixed macro node when needed.
- Compact ZMK legends (`L1`, `⌃`, hold-tap pills) in `keymap-core`.
- Visual **Combos**: list + board key-positions, binding via KeyEditor, timeout / layers / slow-release / prior-idle props; gap beads for adjacent pairs, anchor beads for non-adjacent/multi-key chords. Dense chord boards get a typewriter **combo dictionary** under the board (hover peeks, click selects).
- **Encoders**: per-layer `sensor-bindings` (clockwise / counter-clockwise) shown above the board, following the legend-row hover. A new layer copies the previous list. The knob press stays a normal key.
- **Conditional layers** on the layer strip: the shown layer keeps an accent rail, and hovering it highlights the keys that hold those layers.
- Undo / redo, **Draft** / Ready status, Discard draft.
- Host lane: Ready / Changed / Saved, Linux and Windows install dialogs, assemblies (remembered legend sets). On GitHub, Commit/Load round-trip the host snapshot with ZMK.
- Light / dark theme (default dark).
- Lane labels: **ZMK** = what the firmware sends; **Host** = what the OS types.

## Not in this tree (yet)

Upstream or planned: browser **File System Access**, visual **macro** / custom **behavior** editors (beyond fixed recipes such as `&rgblayer`), auto-generated layouts from ZMK DTS. See [upstream README](https://github.com/nickcoutsos/keymap-editor/blob/master/README.md) for the classic feature list.

Vision and contracts: [docs/TARGET_SYSTEM.md](docs/TARGET_SYSTEM.md).

## Run locally

```bash
pnpm install
pnpm dev
```

UI: `http://127.0.0.1:5173` · API: `http://127.0.0.1:8080`.

Full setup (env, Local junction, GitHub App): [running-locally.md](running-locally.md).

## Hosted app

Production SPA + API (same origin): **[zmk-keymap-editor.com](https://zmk-keymap-editor.com/)**

Deploy: [docs/deploy-vps.md](docs/deploy-vps.md) (Docker + Caddy on a VPS).

## Docs

| Doc | Content |
|-----|---------|
| [running-locally.md](running-locally.md) | Install, Demo, Clipboard, Local, GitHub, tests |
| [docs/deploy-vps.md](docs/deploy-vps.md) | Production deploy on a VPS + domain |
| [docs/TARGET_SYSTEM.md](docs/TARGET_SYSTEM.md) | Product vision |
| [docs/adr/](docs/adr/README.md) | Architecture decisions |
| [AGENTS.md](AGENTS.md) | Notes for coding agents |

## Tests

```bash
pnpm test          # Vitest: keymap-core, api, web
pnpm test:e2e      # Playwright smoke (separate)
```

## License

MIT. The ZMK keycode list is taken from the ZMK documentation, also MIT.
