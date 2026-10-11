import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildKeymapCode,
  diffKeymaps,
  getBehaviorCatalog,
  getBehaviourParams,
  autoshiftBindingParams,
  encodeKeyBinding,
  ensureHoldTapPreset,
  holdTapTimingNote,
  isPrimaryKeymapJson,
  mergeHoldTapCatalog,
  parseDtsHoldTaps,
  parseDtsKeymap,
  replaceHoldTapTiming,
  spliceHoldTapsIntoDts,
  parseKeyBinding,
  parseKeymap,
  resolveBinding
} from './index.js'
import type { LayoutKey } from './types.js'

const NAMED = `/ {
    behaviors {
        hm: homerow_mods {
            compatible = "zmk,behavior-hold-tap";
            label = "HOMEROW_MODS";
            #binding-cells = <2>;
            tapping-term-ms = <280>;
            quick-tap-ms = <0>;
            flavor = "tap-preferred";
            bindings = <&kp>, <&kp>;
        };
    };

    keymap {
        compatible = "zmk,keymap";

        default_layer {
            bindings = <
&hm LCTRL A &kp B
            >;
        };
    };
};
`

const TINY: LayoutKey[] = [
  { x: 0, y: 0, row: 0, col: 0 },
  { x: 1, y: 0, row: 0, col: 1 }
]

describe('parseDtsHoldTaps', () => {
  it('reads a named hold-tap and keeps its arguments on the binding', () => {
    const raw = parseDtsKeymap(NAMED)
    expect(raw.holdTaps).toEqual([
      {
        code: '&hm',
        nodeName: 'homerow_mods',
        tappingTermMs: 280,
        quickTapMs: 0,
        flavor: 'tap-preferred',
        bindings: ['&kp', '&kp'],
        params: ['code', 'code']
      }
    ])

    const parsed = parseKeymap(raw)
    const catalog = mergeHoldTapCatalog(getBehaviorCatalog(), parsed.holdTaps)
    const hm = catalog.byCode['&hm']
    expect(hm?.params).toEqual(['mod', 'code'])
    expect(hm?.name).toBe('Homerow')
    expect(hm?.description).toBe('Homerow, 280 ms, tap preferred, quick-tap 0 ms')

    const binding = parsed.layers[0][0]
    expect(getBehaviourParams(binding.params, hm).length).toBe(2)
    expect(resolveBinding(binding)).toEqual({
      tap: 'A',
      hold: { kind: 'mod', code: 'LCTRL' }
    })
    expect(resolveBinding(parseKeyBinding('&hm 1 TAB'))).toEqual({
      tap: 'TAB',
      hold: { kind: 'layer', layer: 1 }
    })
  })

  it('ignores a commented-out term and a commented compatible', () => {
    const source = `
      /* compatible = "zmk,behavior-hold-tap"; tapping-term-ms = <999>; */
      hm: hm {
          compatible = "zmk,behavior-hold-tap";
          // tapping-term-ms = <999>;
          tapping-term-ms = <200>;
          bindings = <&kp>, <&kp>;
      };
    `
    expect(parseDtsHoldTaps(source)).toEqual([
      {
        code: '&hm',
        nodeName: 'hm',
        tappingTermMs: 200,
        bindings: ['&kp', '&kp'],
        params: ['code', 'code']
      }
    ])
  })

  it('ignores braces inside hold-tap comments when matching the node', () => {
    const source = `
      hm: hm {
          compatible = "zmk,behavior-hold-tap";
          // { decoy
          /* } */
          tapping-term-ms = <200>;
          flavor = "balanced";
          bindings = <&kp>, <&kp>;
      };
    `
    expect(parseDtsHoldTaps(source)).toEqual([
      {
        code: '&hm',
        nodeName: 'hm',
        tappingTermMs: 200,
        flavor: 'balanced',
        bindings: ['&kp', '&kp'],
        params: ['code', 'code']
      }
    ])
  })

  it('reads &mt and &lt timing blocks from the LARK keymap', () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/lark/lark.keymap'),
      'utf8'
    )
    const holdTaps = parseDtsHoldTaps(source)
    expect(holdTaps).toEqual([
      { code: '&mt', override: true, flavor: 'tap-preferred', tappingTermMs: 300 },
      { code: '&lt', override: true, flavor: 'balanced', tappingTermMs: 150 }
    ])
    const catalog = mergeHoldTapCatalog(getBehaviorCatalog(), holdTaps)
    expect(catalog.byCode['&mt']?.description).toBe('Mod Tap, 300 ms, tap preferred')
    expect(catalog.byCode['&mt']?.params).toEqual(['mod', 'code'])
    expect(catalog.list.some(behavior => behavior.code === '&hm')).toBe(false)
    expect(holdTapTimingNote(catalog.byCode['&lt'])).toBe('150 ms, balanced')
    expect(getBehaviorCatalog().byCode['&mt']?.description).toBeUndefined()
  })

  it('round-trips hold-taps through keymap.json and leaves the nodes in the file', () => {
    const parsed = parseKeymap(parseDtsKeymap(NAMED))
    const built = buildKeymapCode(TINY, parsed, { originalSource: NAMED })
    expect(built.code).toContain('compatible = "zmk,behavior-hold-tap"')
    expect(built.code).toContain('tapping-term-ms = <280>')
    expect(built.code).toContain('&hm LCTRL A')

    const json = JSON.parse(built.json) as { layers: string[][]; holdTaps?: unknown }
    expect(isPrimaryKeymapJson(json)).toBe(true)
    const again = parseKeymap(json)
    expect(again.holdTaps).toEqual(parsed.holdTaps)
    expect(again.layers[0][0]).toMatchObject({
      value: '&hm',
      params: [{ value: 'LCTRL' }, { value: 'A' }]
    })
  })

  it('rejects &hm in keymap.json when the hold-tap list is missing', () => {
    expect(isPrimaryKeymapJson({ layers: [['&hm LCTRL A']] })).toBe(false)
    expect(isPrimaryKeymapJson({ layers: [['&hm LCTRL A']], holdTaps: [] })).toBe(false)
    expect(
      isPrimaryKeymapJson({
        layers: [['&hm LCTRL A']],
        holdTaps: [{ code: '&hm', override: true }]
      })
    ).toBe(false)
    expect(
      isPrimaryKeymapJson({
        layers: [['&kp A']],
        combos: [{ id: 'c', keyPositions: [0], binding: '&as LS(Q) Q' }]
      })
    ).toBe(false)
  })

  it('accepts a preset hold-tap once holdTaps names the node', () => {
    expect(
      isPrimaryKeymapJson({
        layers: [['&hm LCTRL A']],
        holdTaps: [{ code: '&hm', tappingTermMs: 280 }]
      })
    ).toBe(true)
    expect(
      isPrimaryKeymapJson({
        layers: [['&as LS(Q) Q']],
        holdTaps: [{ code: '&as' }]
      })
    ).toBe(true)
    expect(isPrimaryKeymapJson({ layers: [['&mt LCTRL A']] })).toBe(true)
  })

  it('keeps an empty holdTaps array so a later load does not guess', () => {
    expect(parseKeymap({ layers: [['&kp A']], holdTaps: [] }).holdTaps).toEqual([])
  })

  it('rewrites an &mt term in place and keeps the rest of the node', () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/lark/lark.keymap'),
      'utf8'
    )
    const next = replaceHoldTapTiming(parseDtsHoldTaps(source), '&mt', {
      tappingTermMs: 280,
      flavor: 'tap-preferred'
    })
    const spliced = spliceHoldTapsIntoDts(source, next)
    expect(spliced).toContain('#define VU          C_VOL_UP')
    expect(spliced).toContain('tapping-term-ms = <280>')
    expect(spliced).toContain('tapping-term-ms = <150>')
    expect(spliced).not.toContain('tapping-term-ms = <300>')
    expect(parseDtsHoldTaps(spliced)).toEqual(next)
  })

  it('inserts a named hold-tap without dropping an existing label property', () => {
    const parsed = parseKeymap(parseDtsKeymap(NAMED))
    const changed = replaceHoldTapTiming(parsed.holdTaps, '&hm', {
      tappingTermMs: 100,
      flavor: 'balanced'
    })
    const spliced = spliceHoldTapsIntoDts(NAMED, changed)
    expect(spliced).toContain('label = "HOMEROW_MODS"')
    expect(spliced).toContain('quick-tap-ms = <0>')
    expect(spliced).toContain('tapping-term-ms = <100>')
    expect(spliced).toContain('flavor = "balanced"')
    expect(parseDtsHoldTaps(spliced)[0]).toMatchObject({
      code: '&hm',
      tappingTermMs: 100,
      flavor: 'balanced',
      quickTapMs: 0
    })
  })

  it('inserts a new named hold-tap into an existing behaviors block', () => {
    const next = ensureHoldTapPreset(parseDtsHoldTaps(NAMED), '&as')
    const spliced = spliceHoldTapsIntoDts(NAMED, next)
    expect(spliced).toContain('label = "HOMEROW_MODS"')
    expect(spliced).toContain('as: as {')
    expect(spliced.indexOf('as: as {')).toBeGreaterThan(spliced.indexOf('behaviors {'))
    expect(spliced.indexOf('as: as {')).toBeLessThan(spliced.indexOf('keymap {'))
    expect(parseDtsHoldTaps(spliced).map(node => node.code)).toEqual(['&hm', '&as'])
  })

  it('creates behaviors inside a root that had none and reparses the same ZmkHoldTap', () => {
    const source = `/ {
    keymap {
        compatible = "zmk,keymap";
        default_layer {
            bindings = <&kp A>;
        };
    };
};
`
    const node = {
      code: '&hm',
      nodeName: 'hm',
      tappingTermMs: 200,
      flavor: 'tap-preferred',
      bindings: ['&kp', '&kp'],
      params: ['code', 'code']
    }
    const spliced = spliceHoldTapsIntoDts(source, [node])
    expect(spliced.indexOf('behaviors {')).toBeGreaterThan(spliced.indexOf('/ {'))
    expect(spliced.indexOf('behaviors {')).toBeLessThan(spliced.indexOf('keymap {'))
    expect(spliced).toContain('hm: hm {')
    expect(spliced).toContain('compatible = "zmk,behavior-hold-tap"')
    expect(parseDtsHoldTaps(spliced)).toEqual([node])
  })

  it('inserts a new &mt override before the root and leaves an existing override byte-identical', () => {
    const ltBlock = `&lt {
    flavor = "balanced";
    tapping-term-ms = <150>;
};`
    const source = `${ltBlock}

/ {
    keymap {
        compatible = "zmk,keymap";
        default_layer {
            bindings = <&kp A>;
        };
    };
};
`
    const next = [
      { code: '&lt', override: true as const, flavor: 'balanced', tappingTermMs: 150 },
      { code: '&mt', override: true as const, tappingTermMs: 300 }
    ]
    const spliced = spliceHoldTapsIntoDts(source, next)
    const rootAt = spliced.indexOf('/ {')
    expect(rootAt).toBeGreaterThan(0)
    const beforeRoot = spliced.slice(0, rootAt)
    expect(beforeRoot).toContain('&mt {')
    expect(beforeRoot).toContain('tapping-term-ms = <300>')
    expect(spliced).toContain(ltBlock)
    expect(parseDtsHoldTaps(spliced)).toEqual(next)
  })

  it('deletes only the quick-tap-ms line and keeps neighbors and indent', () => {
    const source = `hm: hm {
    compatible = "zmk,behavior-hold-tap";
    tapping-term-ms = <280>;
    quick-tap-ms = <175>;
    flavor = "balanced";
    bindings = <&kp>, <&kp>;
};
`
    const spliced = spliceHoldTapsIntoDts(source, [
      {
        code: '&hm',
        nodeName: 'hm',
        tappingTermMs: 280,
        flavor: 'balanced',
        bindings: ['&kp', '&kp'],
        params: ['code', 'code']
      }
    ])
    expect(spliced).not.toContain('quick-tap-ms')
    expect(spliced).toContain('    tapping-term-ms = <280>;\n    flavor = "balanced";')
    expect(spliced).toContain('    bindings = <&kp>, <&kp>;')
  })

  it('deletes a last-line quick-tap-ms and keeps the closing brace indent', () => {
    const source = `hm: hm {
    compatible = "zmk,behavior-hold-tap";
    tapping-term-ms = <280>;
    quick-tap-ms = <175>;
};
`
    const spliced = spliceHoldTapsIntoDts(source, [
      {
        code: '&hm',
        nodeName: 'hm',
        tappingTermMs: 280,
        bindings: ['&kp', '&kp'],
        params: ['code', 'code']
      }
    ])
    expect(spliced).not.toContain('quick-tap-ms')
    expect(spliced).toContain('    tapping-term-ms = <280>;\n};')
  })

  it('leaves tapping-term-ms = <TT> byte-identical until the user sets 200', () => {
    const source = `#define TT 280

hm: hm {
    compatible = "zmk,behavior-hold-tap";
    #binding-cells = <2>;
    tapping-term-ms = <TT>;
    flavor = "balanced";
    bindings = <&kp>, <&kp>;
};
`
    const noEdit = spliceHoldTapsIntoDts(source, [
      {
        code: '&hm',
        nodeName: 'hm',
        flavor: 'balanced',
        bindings: ['&kp', '&kp'],
        params: ['code', 'code']
      }
    ])
    expect(noEdit).toBe(source)

    const edited = spliceHoldTapsIntoDts(source, [
      {
        code: '&hm',
        nodeName: 'hm',
        tappingTermMs: 200,
        flavor: 'balanced',
        bindings: ['&kp', '&kp'],
        params: ['code', 'code']
      }
    ])
    expect(edited).toContain('tapping-term-ms = <200>;')
    expect(edited).not.toContain('tapping-term-ms = <TT>;')
    expect(edited).toContain('#define TT 280')
    expect(edited).toContain('flavor = "balanced";')
  })

  it('inserts named and override hold-taps with CRLF when the source uses CRLF', () => {
    const source =
      `/ {\r\n    keymap {\r\n        compatible = "zmk,keymap";\r\n        default_layer {\r\n            bindings = <&kp A>;\r\n        };\r\n    };\r\n};\r\n`
    const named = {
      code: '&hm',
      nodeName: 'hm',
      tappingTermMs: 200,
      flavor: 'tap-preferred',
      bindings: ['&kp', '&kp'],
      params: ['code', 'code']
    }
    const override = { code: '&mt', override: true as const, tappingTermMs: 300 }
    const spliced = spliceHoldTapsIntoDts(source, [named, override])
    expect(spliced).toContain('hm: hm {')
    expect(spliced).toContain('&mt {\r\n    tapping-term-ms = <300>;\r\n};\r\n')
    expect(spliced).toContain('\r\n    behaviors {\r\n')
    expect(spliced.replace(/\r\n/g, '')).not.toContain('\n')
    expect(parseDtsHoldTaps(spliced)).toEqual([named, override])
  })

  it('drops a cleared &mt block and reports the behavior as dirty', () => {
    const source = `&mt {\n    flavor = "tap-preferred";\n    tapping-term-ms = <300>;\n};\n\n/ {\n    keymap {\n        compatible = "zmk,keymap";\n        default_layer {\n            bindings = <&kp A>;\n        };\n    };\n};\n`
    const cleared = replaceHoldTapTiming(parseDtsHoldTaps(source), '&mt', {
      tappingTermMs: undefined,
      flavor: undefined
    })
    expect(cleared).toEqual([])
    const spliced = spliceHoldTapsIntoDts(source, cleared)
    expect(spliced).not.toContain('&mt {')
    expect(spliced).toContain('compatible = "zmk,keymap"')
    const before = parseKeymap(parseDtsKeymap(source))
    const after = { ...before, holdTaps: cleared }
    expect(diffKeymaps(before, after).some(change => change.type === 'hold_tap')).toBe(true)
  })

  it('adds homerow and autoshift once, with their default timing', () => {
    const homerow = ensureHoldTapPreset(undefined, '&hm')
    expect(homerow).toEqual([
      {
        code: '&hm',
        nodeName: 'hm',
        tappingTermMs: 280,
        flavor: 'balanced',
        quickTapMs: 175,
        requirePriorIdleMs: 150,
        bindings: ['&kp', '&kp'],
        params: ['mod', 'code']
      }
    ])
    expect(ensureHoldTapPreset(homerow, '&hm')).toEqual(homerow)
    expect(ensureHoldTapPreset(homerow, '&hm')).not.toBe(homerow)

    const both = ensureHoldTapPreset(homerow, '&as')
    expect(both.map(node => node.code)).toEqual(['&hm', '&as'])
    expect(both[1]).toMatchObject({
      tappingTermMs: 135,
      flavor: 'tap-preferred',
      quickTapMs: 0,
      params: ['code', 'code']
    })
    expect(encodeKeyBinding({ value: '&as', params: autoshiftBindingParams('Q') })).toBe(
      '&as LS(Q) Q'
    )
  })

  it('omits holdTaps when tapping-term-ms is a macro so Save keeps <TT>', () => {
    const src = `/ {
    behaviors {
        hm: hm {
            compatible = "zmk,behavior-hold-tap";
            #binding-cells = <2>;
            tapping-term-ms = <TT>;
            flavor = "balanced";
            bindings = <&kp>, <&kp>;
        };
    };

    keymap {
        compatible = "zmk,keymap";
        default_layer { bindings = <&hm LCTRL A &kp B>; };
    };
};
`
    const raw = parseDtsKeymap(src)
    expect(raw.holdTaps).toBeUndefined()
    expect(raw.warnings).toContain('hold_tap_timing_unparsed')
    const built = buildKeymapCode(TINY, parseKeymap(raw), { originalSource: src })
    expect(built.code).toContain('tapping-term-ms = <TT>;')
    expect(built.code).toContain('flavor = "balanced";')
  })

  it('does not delete an unparsed tapping-term when splicing a partial model', () => {
    const source = `hm: hm {
    compatible = "zmk,behavior-hold-tap";
    #binding-cells = <2>;
    tapping-term-ms = <TT>;
    flavor = "balanced";
    bindings = <&kp>, <&kp>;
};
`
    const spliced = spliceHoldTapsIntoDts(source, [
      {
        code: '&hm',
        nodeName: 'hm',
        flavor: 'balanced',
        bindings: ['&kp', '&kp'],
        params: ['code', 'code']
      }
    ])
    expect(spliced).toContain('tapping-term-ms = <TT>;')
    expect(spliced).toContain('flavor = "balanced";')
  })

  it('parses a single-line named hold-tap and rewrites its term in place', () => {
    const source =
      '/ { behaviors { hm: hm { compatible = "zmk,behavior-hold-tap"; tapping-term-ms = <280>; bindings = <&kp>, <&kp>; } } keymap { compatible = "zmk,keymap"; default_layer { bindings = <&hm LCTRL A &kp B>; }; }; };'
    expect(parseDtsHoldTaps(source)).toEqual([
      {
        code: '&hm',
        nodeName: 'hm',
        tappingTermMs: 280,
        bindings: ['&kp', '&kp'],
        params: ['code', 'code']
      }
    ])
    const next = replaceHoldTapTiming(parseDtsHoldTaps(source), '&hm', { tappingTermMs: 100 })
    const spliced = spliceHoldTapsIntoDts(source, next)
    expect(spliced).toContain('tapping-term-ms = <100>')
    expect(spliced).not.toContain('tapping-term-ms = <280>')
    expect(spliced.match(/tapping-term-ms/g)).toHaveLength(1)
    expect(parseDtsHoldTaps(spliced)[0]).toMatchObject({ tappingTermMs: 100, nodeName: 'hm' })
  })

  it('parses a single-line &mt override and rewrites its term in place', () => {
    const source = `&mt { tapping-term-ms = <300>; flavor = "tap-preferred"; };\n`
    expect(parseDtsHoldTaps(source)).toEqual([
      { code: '&mt', override: true, tappingTermMs: 300, flavor: 'tap-preferred' }
    ])
    const next = replaceHoldTapTiming(parseDtsHoldTaps(source), '&mt', {
      tappingTermMs: 180,
      flavor: 'tap-preferred'
    })
    const spliced = spliceHoldTapsIntoDts(source, next)
    expect(spliced).toContain('tapping-term-ms = <180>')
    expect(spliced).not.toContain('tapping-term-ms = <300>')
    expect(spliced.match(/tapping-term-ms/g)).toHaveLength(1)
    expect(parseDtsHoldTaps(spliced)).toEqual(next)
  })

  it('leaves a numeric tapping-term line unchanged when the model matches', () => {
    const source = `hm: hm {
    compatible = "zmk,behavior-hold-tap";
    tapping-term-ms = <280>; // keep
    bindings = <&kp>, <&kp>;
};
`
    const spliced = spliceHoldTapsIntoDts(source, [
      {
        code: '&hm',
        nodeName: 'hm',
        tappingTermMs: 280,
        bindings: ['&kp', '&kp'],
        params: ['code', 'code']
      }
    ])
    expect(spliced).toContain('tapping-term-ms = <280>; // keep')
  })

  it('omits holdTaps when #ifdef wraps two timing branches so Save keeps both', () => {
    const src = `/ {
    behaviors {
#ifdef SHORT_HOLD
        &mt {
            tapping-term-ms = <200>;
        };
#else
        &mt {
            tapping-term-ms = <400>;
        };
#endif
    };

    keymap {
        compatible = "zmk,keymap";
        default_layer { bindings = <&kp A &kp B>; };
    };
};
`
    const raw = parseDtsKeymap(src)
    expect(raw.holdTaps).toBeUndefined()
    expect(raw.warnings).toContain('preprocessor_conditional')
    const built = buildKeymapCode(TINY, parseKeymap(raw), { originalSource: src })
    expect(built.code).toContain('tapping-term-ms = <200>;')
    expect(built.code).toContain('tapping-term-ms = <400>;')
    expect(built.code).toContain('#ifdef SHORT_HOLD')
  })
})
