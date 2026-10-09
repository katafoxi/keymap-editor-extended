import { describe, expect, it } from 'vitest'
import { parseDtsKeymap } from './dts-keymap.js'
import { getBehaviourParams } from './keycodes.js'
import {
  buildKeymapCode,
  isPrimaryKeymapJson,
  KeymapValidationError,
  parseKeyBinding,
  parseKeymap,
  validateKeymapJson
} from './keymap.js'

const SOURCE = `#include <behaviors.dtsi>
#include <behaviors/unicode.dtsi>

/ {
    keymap {
        compatible = "zmk,keymap";
        default_layer {
            bindings = <&uc UC_DE_AE &kp A>;
        };
    };
};
`

const LAYOUT = [
  { x: 0, y: 0, row: 0, col: 0 },
  { x: 1, y: 0, row: 0, col: 1 }
]

describe('existing custom bindings', () => {
  it('loads a source binding without registering its external behavior', () => {
    const raw = parseDtsKeymap(SOURCE)
    expect(() => validateKeymapJson(raw, { allowUnknownBehaviors: true })).not.toThrow()

    const parsed = parseKeymap(raw)
    parsed.layers[0][1] = parseKeyBinding('&kp B')
    const built = buildKeymapCode(LAYOUT, parsed, { originalSource: SOURCE })
    expect(built.mode).toBe('splice')
    expect(built.code.slice(0, built.code.indexOf('/ {'))).toBe(
      SOURCE.slice(0, SOURCE.indexOf('/ {'))
    )
    expect(parseDtsKeymap(built.code).layers[0]).toEqual(['&uc UC_DE_AE', '&kp B'])
    expect(JSON.parse(built.json).layers[0]).toEqual(['&uc UC_DE_AE', '&kp B'])
  })

  it('keeps standalone JSON validation strict for unknown behaviors', () => {
    const json = { layers: [['&uc UC_DE_AE']] }
    expect(() => validateKeymapJson(json)).toThrow(KeymapValidationError)
    expect(isPrimaryKeymapJson(json)).toBe(false)
  })

  it('treats unknown behavior arguments as raw without changing known schemas', () => {
    expect(getBehaviourParams(parseKeyBinding('&uc UC_DE_AE').params, undefined))
      .toEqual(['raw'])
    expect(getBehaviourParams(parseKeyBinding('&uc 0xE4 0xC4').params, undefined))
      .toEqual(['raw', 'raw'])
    expect(getBehaviourParams([], undefined)).toEqual([])
    expect(getBehaviourParams([{ value: 'A' }], { params: ['code'] })).toEqual(['code'])
  })

  it.each(['&', '& uc', '&uc-bad 1', '&uc(1)', '&kp! A', 'uc 1', '&1bad 1'])(
    'rejects malformed behavior references in source-import mode: %s',
    binding => {
      expect(() => validateKeymapJson(
        { layers: [[binding]] },
        { allowUnknownBehaviors: true }
      )).toThrow(KeymapValidationError)
    }
  )

  it.each([null, {}, { layers: 'bad' }, { layers: [null] }, { layers: [[42]] }])(
    'keeps structural validation in source-import mode: %j',
    keymap => {
      expect(() => validateKeymapJson(keymap, { allowUnknownBehaviors: true }))
        .toThrow(KeymapValidationError)
    }
  )
})
