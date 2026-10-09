# ADR 0002: Keymap file contract — save paths, JSON priority, `#define` macros

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

The original editor’s everyday path is **`keymap.json`** (plus layout from `info.json`). This fork also loads and saves raw ZMK **`.keymap`** so boards like LARK (preamble `#define` / `#include`, custom `&mt` / `&lt` blocks) stay usable.

Without a fixed contract, Save can silently overwrite a hand-maintained `.keymap` with the default “THIS FILE WAS GENERATED” template, or Local, GitHub, and Clipboard can disagree on load. Implementing parse/splice once in `keymap-core` is required by [ADR 0001](0001-persistence-github-first.md).

“Macros” here means **C-style `#define` aliases** in `.keymap` text (e.g. `#define VU C_VOL_UP`), not ZMK `&macro` behaviors in the editor UI.

## Decision

### Save — `buildKeymapCode` order

| Priority | Condition | Mode | Effect on `.keymap` |
|----------|-----------|------|---------------------|
| 1 | `*.keymap.template` present | `template` | Full generate from template (`{{rendered_layers}}`, etc.) |
| 2 | Else existing `.keymap` text (`originalSource`) | `splice` | Replace only `bindings = <...>` inside `keymap { compatible = "zmk,keymap"; ... }`. Preamble, includes, and behavior nodes outside those bindings stay. |
| 3 | Else neither | `default_template` | Default generated template + warning `generated_default_template` |

- Layer length must equal layout key count before write (fail; do not truncate).
- Splice must not treat combo/other `bindings =` outside the ZMK keymap block as layers.
- Existing layer **node ids** are kept by index; UI `layer_names` do not rename DTS nodes. New layers use `layer_N`.
- When `conditionalLayers` is present, every save path rewrites the root `conditional_layers` node from that list. An empty list removes the node. When the field is absent, an existing node is left unchanged.
- When `holdTaps` is present, every save path rewrites hold-tap timing from that list and inserts missing nodes. When the field is absent, existing hold-tap nodes are left unchanged.
- When `sensorBindings` is present, every save path rewrites each layer's `sensor-bindings` from that list. An empty inner list removes the property on that layer. When the field is absent, existing sensor lines are left unchanged.
- When `&uc` is used, every save path ensures `#include <behaviors/unicode.dtsi>` exists. Splice adds only a missing header before the first DTS node, retaining preceding preprocessor setup and existing header spelling. The module manifest and host setup remain user-managed; see [Unicode picker](../unicode-picker.md).

Local, GitHub, and Clipboard adapters all call the same `buildKeymapCode` helper.

### Load priority

1. Prefer `keymap.json` when it exists and `layers` are non-empty and valid.
2. Otherwise read raw `.keymap` → `parseDtsKeymap` (then the usual parse/encode path).
3. Never treat `*.keymap.template` as the keymap file to overwrite as “the” source keymap.

After the first successful Save, `keymap.json` is written and becomes the primary reload source (bindings may already be expanded — see below).

### `#define` macros — lossy accept

1. On DTS import, simple `#define NAME replacement` aliases used in bindings are **expanded** (`VU` → `C_VOL_UP`, `BT1` → `BT_SEL 1`).
2. On Save (splice or generate), **bindings** are written with expanded tokens, not the short alias.
3. `#define` lines in the preamble may remain after splice but can become unused (“orphaned”).
4. Emit warning `macros_expanded` when defines were used in bindings. Surface warnings in the UI.
5. **No reverse substitution** in this decision (writing `VU` back from `C_VOL_UP` is a future feature if needed).

This does not remove the original editor’s `keymap.json` workflow; it documents the cost of the DTS import/save extension.

### Interchange

- `keymap.json` remains the editor interchange format (aligned with upstream).
- Product GitHub path, the Clipboard **Copy .keymap** path, and the dev-local bridge share this contract via core.

## Consequences

### Positive

- LARK-style preambles survive Save path 2.
- Local, GitHub, and Clipboard stay on one implementation.
- Users and agents get an explicit warning instead of silent `#define` drift.
- Classic JSON-only boards behave like the original editor.

### Negative / trade-offs

- Round-trip of alias names in bindings is lossy until reverse-sub exists.
- After Save, reload from `keymap.json` shows expanded codes even if the `.keymap` preamble still lists `#define`.
- Path 1 (template) fully controls the file; path 3 is a last resort and must stay noisy (warning).
- Splice does not sync `{{behaviour_includes}}`. Besides layer binding interiors, it rewrites `combos` and `conditional_layers` when those fields are set. When `holdTaps` is set, it also rewrites tapping term, flavor, quick-tap, and prior-idle inside existing hold-tap nodes and `&code { … }` timing blocks, inserts missing nodes, and drops a timing block the list no longer has. When `holdTaps` is absent, those nodes stay untouched. When `sensorBindings` is set, it rewrites each layer's `sensor-bindings` (an empty list drops the property). When the field is absent, those lines stay.

## References

- Implementation: `packages/keymap-core` (`buildKeymapCode`, `dts-splice`, `dts-conditional-layers`, `dts-sensors`, `parseDtsKeymap`)
- Adapters: `apps/api` local + GitHub save/load; Clipboard export in `apps/web/src/lib/clipboard/`
- Operator notes: [running-locally.md](../../running-locally.md)
- Vision: [TARGET_SYSTEM.md](../TARGET_SYSTEM.md)
- Persistence boundary: [ADR 0001](0001-persistence-github-first.md)
