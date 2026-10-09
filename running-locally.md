# Running Locally

This tool helps edit keymap files in repositories already cloned onto your computer.

## Setup

1. Clone this repo and open the new directory in a terminal.
2. Copy `.env.template` to `.env`. Defaults are enough for local editing (GitHub optional). Copy `apps/web/.env.development.example` to `apps/web/.env.development`. That file is gitignored; do not commit it.
3. Point `zmk-config` at a firmware repo with `config/info.json` (and ideally `config/keymap.json`). For this project the LARK board works well:

```bash
# Windows (junction; no admin required)
cmd //c "mklink /J zmk-config C:\path\to\your\zmk-config"

# or Git Bash / Unix
ln -s ../your-zmk-config zmk-config
```

**Load:** Local mode prefers `config/keymap.json` when it exists and its `layers` are non-empty and valid. Otherwise it reads the raw `.keymap` (so a missing file, empty `layers`, or `layers: [[]]` all fall back). After the first **Write files**, `keymap.json` is written and becomes the primary source on the next load (with expanded binds). `*.keymap.template` is never treated as the keymap file to overwrite. GitHub also loads/saves `host_keymap/snapshot.json` with the keymap ([ADR 0005](docs/adr/0005-host-keymap-github-snapshot.md)); the local adapter does not write host files yet.
4. Install [pnpm](https://pnpm.io/) (Node 20+), then run:

```bash
pnpm install
pnpm dev
```

5. Open `http://127.0.0.1:5173` (Vite UI). The API listens on `http://127.0.0.1:8080`. A clean browser profile opens **Demo** (boards from `packages/keymap-core/fixtures/demo/catalog.json`). Source **Clipboard** pastes a `.keymap` (optional `info.json`) with no disk write — use **Copy .keymap** to put spliced firmware text back on the clipboard. Source **Local** appears only when both `ENABLE_LOCAL` flags below are set.

### Local source (`ENABLE_LOCAL`)

For Source **Local** (`/layout`, `/keymap` sibling bridge):

- Set `ENABLE_LOCAL=true` in the repo root `.env`
- Set `VITE_ENABLE_LOCAL=true` in `apps/web/.env.development` (create it from the example; it is not in git)

Both must be true; the API gates the routes, and the SPA hides Local unless the Vite flag is set. Default in `.env.template` is `ENABLE_LOCAL=false`.

`ZMK_CONFIG_PATH` overrides the config directory (default `<repo>/zmk-config`). Leave it unset for normal dev. The browser smoke sets it to a temp fixture copy.

### GitHub auth

- Enable GitHub with `ENABLE_GITHUB=true` and the GitHub App fields in `.env` (including `GITHUB_APP_PRIVATE_KEY`). In `apps/web/.env.development`, set `VITE_ENABLE_GITHUB=true` and `VITE_GITHUB_APP_NAME` to the same slug as `GITHUB_APP_NAME`.
- Login uses an HttpOnly session cookie (`sid`). The browser never gets a GitHub OAuth access token, and there is no `?token=` on the redirect after OAuth. Sessions live in memory in the API process (24h sliding TTL): restarting the API, or running more than one process without sticky routing, signs everyone out. OAuth `state` is an HMAC-signed cookie, not a capped server map. GitHub routes are rate-limited per IP (the TCP socket address). Set `TRUST_PROXY=true` only when a reverse proxy sets `X-Forwarded-For` / `X-Real-IP`; those headers are ignored unless that flag is on.
- Opening a repository needs a user `config/*.keymap`. `config/info.json` is optional: when it is absent, the GitHub and Local loaders also accept a matching `config/<keymap-name>.json` physical-layout file; `info` and `keymap` are reserved stems, so use `config/info.json` for those keymap names. Otherwise the SPA draws a flat rectangular board from the binding count (same as Clipboard). Bindings come from `config/keymap.json` when that file has non-empty valid layers, and from the `.keymap` otherwise. `*.keymap.template` is read only when committing. Commit does not create layout files.
- The ZMK lane shows **Latest** for that branch’s Actions firmware build. The chip stays neutral until a firmware artifact can be downloaded. A successful run with an artifact downloads the zip through the API. A failed, cancelled, or artifact-less run opens the Actions page.
- In dev, `GITHUB_OAUTH_CALLBACK_URL` must be the **Vite** origin (e.g. `http://127.0.0.1:5173/github/authorize`), not `:8080`, so `Set-Cookie` attaches via the Vite proxy. Production uses same-origin `{APP_BASE_URL}/github/authorize`.
- Decision record: [docs/adr/0003-github-auth-server-session.md](docs/adr/0003-github-auth-server-session.md).

Set `PORT` if the API port must change. Set `HOST` to override the bind address (default `127.0.0.1` locally, `0.0.0.0` when `NODE_ENV=production`). Set `APP_BASE_URL` to the browser-facing app origin (`http://127.0.0.1:5173` in this repo’s default). `ENABLE_DEV_SERVER=true` skips the “web dist not found” warning when the API does not serve `apps/web/dist` (normal for `pnpm dev`, where Vite hosts the SPA).

## Using the editor

On first visit **Demo · Corne** loads with a short spotlight coach tour (replay anytime with **Tour**). Pick another layout card from the Demo catalog (splits, unibody ortholinears, chord boards, and more). Demo edits stay in the browser; there is no Write files path until you switch to Local or GitHub. Source **Clipboard** also stays in the browser: paste a `.keymap` (and optionally `info.json`); without layout the board is a flat rectangle from the binding count; **Copy .keymap** splices into the pasted source (or the default template) and shows the result for paste into your firmware repo. With Source **Local** (both `ENABLE_LOCAL` flags on), the sibling `zmk-config` keyboard loads automatically. Click a key to open the editor: pick a behaviour, then a value. Enter applies a complete binding; Esc cancels.

The board shows the host composed stack: click a keycap row to edit that layer’s ZMK binding; **Alt+click** starts a host-edit session (glyph catalog) when the key is a host character key. Hover is a read-only peek. If that row has an unpublished binding, the card’s first line is what it was (`Was …`). The header **ZMK** lane publishes the keymap; a dirty keymap says **Draft**, and the changed layer row stays washed until Write files or Commit. **Discard draft** restores the last loaded keymap, including edits Undo can no longer reach. The **Host** lane opens Linux/Windows install dialogs when a user layout is active. On the assembly line, left of the remembered chips, **Stack** stays pale until a third host language is open, and **Differences** marks ornament drift, serious typewriter-basic gaps (including per-key / Linux-split cases), and (when English and the install pair share the key) an AltGr cell the combined Windows file cannot keep. Beside those modes, **Colors** washes firmware layers and **Scheme** shows the full matrix with row/col rails (default view hides only `absent` slots). The far right of the legend strip lists basic letters and marks missing from a changed host layout. A keypad binding counts as present. Add, rename, and delete layers from the host-legend table. Each language column picks a host **layout** (a system catalog id such as `system-us` / `system-ru`, or a user layout `user:<uuid>`). Copy, **Import xkb…**, and **Import klc…** create user layouts; they persist in IndexedDB with the whole legend view. A one-language `.klc` fills that column. A file with another alphabet on Caps Lock fills the base language and that language. Above the legend table, **Remember** keeps up to three column sets for this keyboard; choosing one shows that set again, and the layouts stay shared.

In a **clean browser profile** the legend is system English only (`system-us`), except the **Demo Lark** card, which seeds English (`en2`) and Russian (`ru2`) from `packages/keymap-core/fixtures/lark/host/` into IndexedDB on open. Add a language from the legend table; that choice is saved for this keymap and is not written into the firmware repo. Domain code does not bake a keyboard-specific host map; Demo and Local/GitHub import stay the loaders. To import LARK host glyphs manually on Local or GitHub:

1. Open a language column’s profile control and choose **Import xkb…**.
2. Pick `packages/keymap-core/fixtures/lark/host/au` (section `basic`, display name `en2`) for English and/or `packages/keymap-core/fixtures/lark/host/ru` (section `legacy`, display name `ru2`) for Russian — or paste the file text. Those files have no extension (xkb symbols convention); the file picker lists all files.
3. The column switches to the imported user layout. Reload the page: the layout stays (IDB v3).

Includes inside those files resolve against vendored system modules (`us(basic)`, and so on).

Click **Write files** to write `keymap.json` and update the `.keymap` in `zmk-config`. On GitHub the same action is **Commit to GitHub**. With Source **Clipboard**, **Copy .keymap** uses the same splice order but returns text to the system clipboard (and a preview dialog) instead of writing disk. The write path depends on what is already on disk:

1. If `config/*.keymap.template` exists, that template fully controls the written `.keymap` (`{{rendered_layers}}` / `{{behaviour_includes}}`).
2. Otherwise, if a `.keymap` already exists, Write files splices bindings only inside `keymap { compatible = "zmk,keymap"; }`. `#define`, `#include`, and `&mt` / `&lt` blocks outside those bindings stay.
3. If there is no template and no original `.keymap` text, Write files uses the default generated template and the API returns a warning (not the LARK path).

Import from `.keymap` expands simple `#define` aliases (`VU` → `C_VOL_UP`, `BT1` → `BT_SEL 1`). After Write files, bindings are the expanded tokens, so `#define` lines can be left unused; the editor warns when that happens (no reverse substitution). Decision record: [docs/adr/0002-keymap-file-contract.md](docs/adr/0002-keymap-file-contract.md).

Do not commit a Write files result into the LARK firmware repo (`zmk-keyboard-lark`) without reviewing `git diff` on the `.keymap` (and `keymap.json` if it appears).

## Tests

```bash
pnpm test
pnpm test:coverage
pnpm exec playwright install chromium   # once, for the smoke only
pnpm test:e2e
```

`pnpm test` is Vitest: `packages/keymap-core`, `apps/api`, and `apps/web`. It does not start a server.

`pnpm test:coverage` is the same Vitest run with a v8 summary (no thresholds, not in CI).

`pnpm test:e2e` is Playwright (Chromium only). `globalSetup` copies `packages/keymap-core/fixtures/lark` into a temp directory and starts the API and Vite on free ports (preferring 18080 and 15173). Specs open Source **Local** from the source menu, splice a binding with **Write files** while keeping the `.keymap` preamble, edit a composed layer-2 row, restore an IndexedDB draft after reload (dismiss confirm), and Alt+click a keycap to change a host glyph. They do not use ports 5173 or 8080 and do not write the repo `zmk-config`.

Optional overrides, defaults unchanged when unset:

- `ZMK_CONFIG_PATH` — API config directory
- `API_PROXY` — Vite proxy target (default `http://127.0.0.1:8080`)
- `VITE_PORT` — Vite port; when set, that port is strict
