# Target system

Vision for this fork of the keymap editor. Living document — update when product intent changes. Decisions belong in [ADR](adr/).

## Product intent

A browser editor that shows what a key **actually produces**, not only what a ZMK `.keymap` line says.

Users combine:

1. **Firmware keymap** (ZMK layers, behaviors, hold-taps, etc.)
2. **Host input layouts** (e.g. Windows/Linux layouts for EN + RU and AltGr levels)

so each physical key can show a compact **composed legend** (host-resolved glyphs from the selected language columns + optional hold annotation), not a single-layer dump of the text file.

Editing should stay honest to ZMK: composed view is an **editor** over firmware bindings — a stack row opens KeyEditor for that layer — but you still change the ZMK binding, not the host glyph.

## UI language

The SPA chrome is **English only** for now (labels, buttons, hints, notices). Agents and contributors should not add new non-English UI strings; rename leftover tails when touching a screen. Glyphs on keycaps (including Cyrillic) are content, not chrome.

## Persistence (product)

Primary user workflows (aligned with upstream intent):

| Source | Role |
|--------|------|
| **Demo** | First-visit onboarding: bundled fixtures under `packages/keymap-core/fixtures/` (catalog in `fixtures/demo/`, Lark host maps in `fixtures/lark/`). Edits stay in the browser; there is no firmware write path. Loaded only via `apps/web/src/lib/demo/`. |
| **GitHub** | Load/save `zmk-config` via GitHub App + OAuth. `config/info.json` is optional — without it the board is a flat rectangle from the binding count (same idea as Clipboard); Commit still writes keymap (+ host snapshot), not layout. Host layouts ship in the same commit as `host_keymap/snapshot.json` ([ADR 0005](adr/0005-host-keymap-github-snapshot.md)); IndexedDB is draft/cache for that path. |
| **Clipboard** | Paste `.keymap` (info.json optional — otherwise a flat rectangular board); **Copy .keymap** puts spliced firmware text on the system clipboard (and in a dialog) for paste into the user’s repo. |
| **File System Access API** | Chromium: read/write local files without a Node file server (planned / restore) |

The Node API exists mainly for **GitHub secrets and commits**. It is not the long-term home for “open my firmware folder on disk.” Host layout **tables** for GitHub live in the repo snapshot; the API only forwards that file with the keymap commit.

### Dev-only local bridge

Sibling/`zmk-config` junction + `GET/POST /layout|/keymap` is a **development adapter** so we can iterate on a cloned firmware repo quickly. Do not grow product features that *require* this path. Prefer the same file contracts as GitHub (parse/generate/splice in `keymap-core`). Host layouts on the local adapter stay in the browser (IndexedDB); GitHub uses `host_keymap/snapshot.json` ([ADR 0005](adr/0005-host-keymap-github-snapshot.md)).

See [ADR 0001](adr/0001-persistence-github-first.md).

## Runtime shape

```
apps/web          Svelte 5 + Vite SPA — UI, pickers, composed key editor
apps/api          Thin Hono API — GitHub OAuth/App + optional dev-local I/O
packages/keymap-core   Pure TS — parse/generate/splice .keymap, host-layout registry, compose
```

- **Domain logic** lives in `keymap-core` and runs in the browser (and on the API only when needed for GitHub/dev I/O).
- **UI** does not own ZMK encode/decode.
- **API** does not own editor state or compose presentation.

## Key editor

Click a stacked keycap row. One dialog edits that layer’s ZMK binding:

- Behaviour chips, then the value list for the active slot. `code` is Keyboard/Keypad, `command` is that behaviour's commands (`&mkp`, `&msc`, `&mmv`, `&bt`, `&out`, …), `layer` and `mod` are the layer or modifier slot (`&mo`, `&mt`, `&lt`).
- Enter applies a complete binding. Esc cancels. An unfinished hold-tap stays open.
- Pointing behaviours remind that firmware needs `CONFIG_ZMK_POINTING=y`. The editor only adds `#include <dt-bindings/zmk/pointing.h>`.
- Hold-tap nodes are read into the keymap. Edit key changes tapping term and flavor for every key that uses `&mt` or `&lt`. The next row offers two presets: Homerow (`&hm`, modifier + key, with term, flavor, quick-tap, and prior-idle) and Autoshift (`&as`, one key — hold sends that key shifted, tap sends it — with a shared term). Apply adds its node when the keymap does not have it. Cancel leaves the hold-tap list unchanged. A hold-tap already in the file keeps its name and can still be assigned; there is no form to invent another behaviour. Save rewrites those timing lines and inserts missing preset nodes when `holdTaps` is set.
- **Recipes** (not a general macro editor): one built-in chip, `&rgblayer` (Layer + RGB). Apply writes `&rgblayer <layer> RGB_COLOR_HSB(h,s,b)` and ensures a fixed `zmk,behavior-macro-two-param` node under `behaviors` on Save when `rgbLayerRecipe` is set or a binding already uses `&rgblayer`. The dialog shows layer chips plus an HSB picker. Arbitrary ZMK macros stay in the `.keymap` text; the SPA does not invent or edit open-ended macro sequences.

## Unicode input

The `&uc` behavior has a dedicated [Unicode picker](unicode-picker.md) for
normal/Shift code points, curated upstream aliases, and runtime input-mode
switches. It requires `urob/zmk-unicode` and host input setup; Save adds the
module header but never changes `west.yml` or OS settings.

## Conditional layers

A then-layer is on only while every if-layer is active (Lower + Raise → Adjust). The rule lives on the layer strip, beside the layer it turns on: that row keeps an accent rail, and its name tooltip reads `When Lower and Raise are held, show Adjust`. Hovering it highlights the held layers in the table and the keys that activate them; hovering a held layer highlights the then-layer row. On a key that holds an if-layer (`&mo` or `&lt`), the then-layer row is struck through: that binding does not fire while the key stays down. `&to`, `&tog`, and `&sl` leave the key free and stay unmarked. Add and remove sit under Add Layer. Parse/splice live in `keymap-core` (`dts-conditional-layers`); Save rewrites the `conditional_layers { … }` block with the keymap contract ([ADR 0002](adr/0002-keymap-file-contract.md)). Deleting a layer renumbers the rules and drops one that loses its then-layer or no longer has two held layers. A then-layer numbered at or below a held layer stays valid and warns that the held layer can cover it.

## Encoders

The knob's press is a normal matrix key. Rotation is `sensor-bindings` on each layer: one binding per encoder, clockwise argument then counter-clockwise (`&inc_dec_kp C_VOL_UP C_VOL_DN`). When any layer has that property, a strip above the board shows that layer's turns. Hovering a legend row previews its layer; with no hover the strip shows the base layer. Click a direction to edit that turn in KeyEditor: CW and CCW are separate key slots, and hold-tap presets stay hidden. A new layer copies the previous layer's list so a board that requires the property on every layer still builds. Save writes the lists back when `sensorBindings` is set; a keymap that never had them is left alone. GPIO and shield discovery stay out of this pass.

## Combos

**Combos** is a board mode beside Scheme: pick `key-positions` on the matrix, edit the chord binding in KeyEditor, and set per-combo `timeout-ms`, `layers`, `slow-release`, and `require-prior-idle-ms`. Parse/splice live in `keymap-core` (`dts-combos`); Save rewrites the `combos { … }` block with the rest of the keymap contract ([ADR 0002](adr/0002-keymap-file-contract.md)). Outside edit mode the board shows gap beads for adjacent two-key chords (horizontal or vertical) and side anchor beads for non-adjacent pairs or three-or-more chords; beads sit on the layer strip they apply to, and hovering a bead peeks those keys. When combos outnumber the keys, a collapsible **chord dictionary** under the board is a typewriter index (`combo-dictionary-index` in core): hover a familiar key to peek the chord on the small board; a key with both a plain and an `LS()` / US-shift output splits top/bottom so each half peeks its own chord. Index halves paint `keycapFace` packs for that HID key (base+AltGr vs Shift+AltGr+Shift, second language on the accent color); hover also peeks the same read-only decode card as a composed row (click selects the combo; Alt+click is host). Non-shift wraps (`LA(TAB)`, `LC(DEL)`, …) stay on that key as compact mod chips (`⎇TAB`, `⌃⌦`) so they are not lost under the plain half. Click opens Combos and selects that combo without hiding the index — KeyEditor opens from Binding in the panel; Alt+click starts the same host-edit session as a composed row, armed on that half’s level. Outputs that are not a typing key sit in an Other row. On-board beads stay off while the dictionary is open. Editor hints prefer two to five keys, but a 1-key or 6+ combo that ZMK would compile does not trap Combos mode. Two 2+ key chords with the same key set on a shared layer still block exit (omitted `layers` counts as every layer). A shorter chord nested in a longer one stays valid. Empty new rows are dropped on exit. Deleting a layer renumbers each combo's `layers` filter the same way as conditional-layer rules; a combo whose filter listed only the deleted layer is dropped, not broadened to every remaining layer. `&mo`, `&lt`, `&to`, `&tog`, and `&sl` layer arguments on keys, combo bindings, and encoder turns shift with that delete; a ref to the deleted layer becomes `&trans`.

## Keycap / compose (target UX)

- **ZMK legends** (compact codes on a raw layer0 row, and inside KeyEditor): helpers in `packages/keymap-core` `compose.ts` (`layerLegendSymbol`, `keycapLegend`, `isHoldTapBehavior`, `isHoldTapBinding`). Binding tokens stay ZMK (`1`, `LCTRL`, `LC(DEL)`).
  - Layers: `L1` (index, not the layer name).
  - Left modifiers unmarked (`⌃ ⎇ ⌘ ⇧`); right side `R⌃` / `R⎇` / `R⌘` / `R⇧`. Alt is the ISO alternative-key symbol.
  - Compact chords drop parens: `LC(DEL)` → `⌃⌦`, `LS(CAPS)` → `⇧⇪`, and a short token `LA(F4)` → `⎇F4`, `LA(TAB)` → `⎇TAB`, `LA(ESC)` → `⎇ESC` (`F1`–`F12`).
  - Host-legend AltGr columns use the same mark: `R⎇` and `⇧R⎇`.
  - Mouse scroll keeps the family prefix: `SCRL⬆` `SCRL⬇` `SCRL⬅` `SCRL➡`. Pause/Break is `⏸`. Volume up / down / mute are `🔊` `🔉` `🔇`. Tooltip keeps the raw code.
  - Behaviour on the cap: hide `&kp`; hide the behaviour token when the hold-tap pill is shown (`&mt`, `&lt`, and a named hold-tap such as `&hm`); `&rgblayer` shows `Ln` plus a color swatch (`rgbLayerLegend`); `&none` / `&trans` / instant binds are the center legend; other behaviours stay a small corner mark.
  - Caps Lock `⇪`. Browser back/forward `←` / `→` (not cursor `⏴` `⏵`). Number-row `-` / `=` (not the words `MINUS` / `EQUAL`). Tooltip keeps the raw code.
  - Keypad (`KP_*`): same glyph as the number row (`7`), boxed. Operators `+ - / *`, plus `KP_ENTER` `⮐`, `KP_DOT` `.`, `KP_EQUAL` `=`. Color is only a light fill. Host composed stays the same glyph.
- **Composed view**: an N-column `ComposedLegend` in core (visible extras; a hidden base column is kept so the firmware alphabet remains when its glyphs are off the key). The keycap draws at most two languages (`onKeycap`): any pair, so Russian and Ukrainian can sit together while English stays the hidden reference. The table and decode card share the same `hostLevels` / `resolveHostColumns` path. Hold badges come from the binding (`holdRef`), not from the letter.
- **Keycap face contract** (one fill path — agents must not reinvent this):
  - **Core** `keycapFace(legend)` / `formatKeycapFace` is the only board content API. No `keycapColumns`, no AltGr-pair helper for the board. For each on-keycap language (≤2), emit **exactly four** levels: base → shift → AltGr → AltGr+Shift. Empty or AltGr-toggle-off → `ˬ` (`empty: true`). Do not collapse shared letter pairs, do not drop an on-keycap language, never `/`. Attach `hold` when present (`⧗R⎇`, …) after the packs. Compact form: `bBˬˬиИˬˬ` or `bBˬˬиИˬˬ ⧗R⎇`.
  - **UI** (`KeyCap.svelte`): paint that face and **scale-to-fit** if the layer row is too narrow. Show `ˬ` only while the layer slot is hovered/focused (placeholders still reserve width). No second packing step in Svelte.
  - **Decode**: same `ˬ` for empty editable levels. **Table**: blank cells when an AltGr column toggle is off (face still keeps the four slots).
- Host glyphs are editable from an **Alt+click** host-edit session on the decode card (see below). A fuller standalone host-layout editor remains future work. An xkb section writer round-trips layouts for Linux paste/download; the Host chrome lane also writes a `.klc` file for MSKLC (one language per file, plus a combined English file with that language on Caps Lock only when a **Cyrillic** language is on the board — `windowsCapsPairingRecommended`: ru, uk, bg). Dense Latin layouts and Greek stay separate `.klc` files and Win+Space.

## Host layouts

Core domain code (compose, host-layout registry) does **not** know any concrete keyboard. Built-in host data is OS language tables (`HOST_LANGUAGES`: en, ru, uk, de, fr, pl, es, it, pt, br, cs, da, sv, hu, tr, ro, fi, no, el, bg) plus vendored xkb modules. Named boards appear only as fixtures (`packages/keymap-core/fixtures/lark/`, `fixtures/demo/`) and the Demo catalog loader — see [running-locally.md](../running-locally.md) and [AGENTS.md](../AGENTS.md).

- **Registry.** `hostLayout(id)` / `hostLayoutMeta(id)` resolve both builtins and layouts registered at runtime. Builtin xkb sections parse on first use. `registerHostLayout` / `unregisterHostLayout` make an imported or copied layout available to the keycap, table, decode card, and profile menu the same way as a system id.
- **Storage in the layout.** Each `HostLayout` stores four **keysyms** per key and derives glyphs. `'NoSymbol'` is explicit. Non-character bases (`dead_*`, `Multi_key`) stay in the table; composition filters them.
- **Legend view.** `HostLegendView = { columns, open, keycap? }`. `columns[0]` is the base language. Each `HostColumn` is `{ language, layoutId, visible, altGr, altGrShift }`. The default is primary system English only (`system-us`, `us(basic)`, AltGr on, `open: null`). That column is the firmware key-code alphabet: ZMK sends US positions, and it is not a language picker. Every other catalog language, including Russian, is a host language the user chooses for that keyboard. `open` is the national language paired with English for the combined Windows file. Differences mode compares the two languages on `keycap` (Win AltGr marks only when English and `open` are both drawn). `keycap` is which languages are drawn on the key, at most two, and it does not have to include English. Older saves omit `keycap`; those still draw the visible base plus `open`. The eye hides a language's glyphs. Hiding English leaves the column in place. Showing a national language while English is hidden and one other national is already drawn puts both on the key; while English is drawn, showing another national replaces the previous one. The choice is stored in IndexedDB under the same identity as an unpublished draft (source, repository, branch, keyboard name). On GitHub, Commit also writes it into `host_keymap/snapshot.json` with the referenced user layout tables ([ADR 0005](adr/0005-host-keymap-github-snapshot.md)); a load with that file wins over IndexedDB. A browser-wide legend left by the old English+Russian default is ignored; any other saved browser-wide view is adopted by the first keymap opened and then removed, so the next keyboard starts from English again.
- **Assemblies.** Up to three remembered legend views per keyboard (`assemblies:` in the same IndexedDB settings store). Each one stores that keyboard's `columns`, `open`, and `keycap`. It does not copy layout tables, so an edit to a layout shows up in every assembly that points at it. The chip shows a flag and the short layout name for each column. Its accessible name joins those names (`System + typewriter`) and qualifies a repeated name with the language. **Remember** keeps the live set. Choosing a chip shows that set again.
- **Layer view.** Firmware-layer visibility is a separate `LayerView = { shown, layer0Raw }` on the editor (`editor.layerView`). It is not part of the host-legend view. Hover a layer row in the host-legend strip, or a stacked layer row on the board, to set `legendHover` and highlight bindings that activate that layer (`&mo` / `&to` / `&lt` / …).
- **Edit from the decode card.** Hover a composed keycap row for a **read-only** peek (levels table + ZMK hint; for layer / hold-tap / sticky behaviours a short `behaviorPeekNote` one-liner in core; no edit/revert; `pointer-events: none`). An unpublished binding adds a first line, `Was …`, and leaves the ZMK, Windows, and Linux identifiers on the next line. **Alt+click** the row starts a host-edit session only when the tap is a host-character key (`hostKeyByZmk`): the card locks (one active decode owner), shows Accept / Cancel (Enter / Escape), and opens the persistent symbol catalog (Ω). Level cells arm the catalog; glyph picks **write immediately**; Accept/Cancel only end the session (no draft rollback). Plain click on the row still opens `KeyEditor` for the ZMK binding. The first edit of a system layout forks a user copy (`user:<uuid>`, origin `{ from: 'copy', layoutId }`), switches that language column to the copy, and leaves the system table unchanged; the card keeps the primary system row for comparison and diffs. Further edits update the user layout in place; the board repaints immediately and the change persists in IndexedDB with the legend view. Details: [ADR 0004](adr/0004-host-edit-and-os-deliverables.md).
- **Chrome lanes.** Header splits **ZMK** (Source, then a short **Draft** or dot for **Up to date**, undo/redo, Discard beside Draft, then Write files / Commit and on GitHub a neutral **Latest** firmware chip that fills when an artifact can be downloaded; spare width stays after that cluster) from **Host** (shown once a keymap is loaded; Ready / Changed / Saved for host deliverables, then Linux and Windows). A light/dark **theme** toggle sits in the header chrome and persists in `localStorage` (default dark). Tour replay for Demo sits with the theme control. An unpublished binding washes that layer’s row until publish. Layer add, rename, and remove stay Draft without a per-key mark. Undo/redo walk **ZMK draft** history only (not host-layout table edits via Alt+click, and not scheme-mode `promoteAbsentKey` layout mutations). Discard draft restores the last loaded keymap and the board layout baseline (so promoted absent slots return). On the assembly line, left of the remembered chips, **Stack** and **Differences** are labeled mode buttons in one row (aria: Stack languages / Highlight symbol differences). Beside them, **Colors** washes firmware layers on the keycap and in the table, and **Scheme** shows the full matrix with row/col rails (including absent slots); both are board disclosures, not legend modes. Default board view hides only `absent` slots. Stack stays pale until three host columns exist. Highlight symbol differences (on when two languages are on the key) marks non-letter drift on those keycap languages: mild `position` for national ornament, stronger `basic` for typewriter punctuation (`BASIC_ALIGN_GLYPHS`) including per-key gaps that Linux split cannot share, and, when English and `open` share the key, `Win AltGr` for combined-file clashes. Samples sit on the keyboard stage, just above the board, while it is on. The far right of the legend strip lists basic letters, digits, and punctuation missing from a changed host layout; a keypad binding counts as present, and system columns stay quiet. The host symbol catalog (Ω) sits at the end of the language header row. Linux / Windows open install dialogs: copy/download xkb sections with path hints (English → prefer `symbols/au`; Russian → prefer `legacy` in `symbols/ru`; note `sudo` for system files); Windows links MSKLC and downloads one UTF-16 `.klc` per changed language, and, when a Cyrillic language is on the board (`windowsCapsPairingRecommended`: ru, uk, bg), one English `.klc` with that language on Caps Lock and that language’s AltGr (`hostLayoutsToCapsKlc`). Dense Latin layouts (fr, de, es, pl, …) and Greek get separate files only — the dialog tells the user to switch with Win+Space. The writer is shared (`hostLayoutToKlc`). A new language needs a `WINDOWS_LOCALES` entry; letter virtual keys and ordinary Caps Lock are inferred. Dead-key tables are shared. Contract: [ADR 0004](adr/0004-host-edit-and-os-deliverables.md).
- **Profile = layout.** One id space: catalog ids (`system-us`, `system-ru-legacy`, …) and user layouts `user:<uuid>`. A profile menu entry is a layout. Copies (including the decode-card fork) materialize the source table; xkb import (`Import xkb…`) registers a user layout with origin `{ from: 'xkb', fileName, section }` and assigns it to that language column. `.klc` import (`Import klc…`) does the same with origin `{ from: 'klc', fileName, role }`. A one-language file fills the column that imported it. A Caps Lock alphabet fills the base language and that second language, and AltGr stays on the second language. Browser IndexedDB stores user layouts once, and stores each keyboard's legend view (`columns`, `open`, `keycap`) separately. Profile **Export xkb** remains an advanced section dump; product install UX is the Host lane.
- **Keyboard-repo host files.** GitHub Commit/Load use `host_keymap/snapshot.json` for the live legend view and referenced user layout tables ([ADR 0005](adr/0005-host-keymap-github-snapshot.md)). The same Commit also writes generated `host_keymap/linux/*.xkb` and `host_keymap/windows/*.klc` install sources for download after an OS reinstall. IndexedDB remains the SoT for Demo and the draft/cache mirror after a GitHub load. Remembered assemblies stay browser-only for now.
- **Vendored xkb ships eagerly.** All `system-*-symbols.ts` blobs sit in the web entry chunk (`host-languages.ts` and `host-layout-catalog.ts` import them statically). The default view needs only `us`; other languages load from the same tables when chosen. After Demo fixtures moved to `import()`, a production build (2026-10) is about **1.49 MB min / ~343 KB gzip** for `index-*.js`, plus small per-demo chunks (~3–10 KB each). `host-symbols.json` and `zmk-keycodes.json` stay in that entry. An older split experiment saved only −25.8 KB gzip when the app was smaller, and it is all-or-nothing: Rollup follows the static catalog imports, so a dynamic import in `host-layout-import.ts` alone is defeated. Doing it properly means an async preload in front of the synchronous `hostLayout()` used during render, whose failure mode is a silently blank legend. **Do not make the host registry async for this.** Deferred; **revisit lazy language tables only with an explicit async catalog API before the next large language wave.**

## Keymap file contract

Accepted in [ADR 0002](adr/0002-keymap-file-contract.md):

- Preserve user `.keymap` preamble on Save via **template** or **in-place bindings splice** (else default template + warning).
- DTS import expands `#define` aliases in bindings (`VU` → `C_VOL_UP`); Save writes expanded tokens; UI shows `macros_expanded` (no reverse-sub yet).
- `keymap.json` is the editor interchange format and becomes the preferred reload source after Save.

## Out of scope (for now)

- Full DTS AST rewriter
- Collaborating multiplayer editing
- Building firmware in-app
- Growing a general-purpose local filesystem server

## Related docs

- [symbol-differences.md](symbol-differences.md) — Differences mode intent (keycap pair, basic vs ornament, Linux split)
- [running-locally.md](../running-locally.md) — how to run the monorepo, and how to run `pnpm test` / `pnpm test:e2e`
- [AGENTS.md](../AGENTS.md) — short guidance for coding agents
- [adr/](adr/) — architecture decision records
