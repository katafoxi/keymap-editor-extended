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
            bindings = <&vendor UC_DE_AE &kp A>;
        };
    };
};
`

const LAYOUT = [
  { x: 0, y: 0, row: 0, col: 0 },
  { x: 1, y: 0, row: 0, col: 1 }
]

describe('well-formed unknown behaviors', () => {
  it('loads from keymap.json and stays the primary cache', () => {
    const json = { layers: [['&vendor UC_DE_AE', '&kp A']] }
    expect(() => validateKeymapJson(json)).not.toThrow()
    expect(isPrimaryKeymapJson(json)).toBe(true)
  })

  it('splices an external binding back into the original keymap', () => {
    const raw = parseDtsKeymap(SOURCE)
    const parsed = parseKeymap(raw)
    parsed.layers[0][1] = parseKeyBinding('&kp B')
    const built = buildKeymapCode(LAYOUT, parsed, { originalSource: SOURCE })
    expect(built.mode).toBe('splice')
    expect(built.code.slice(0, built.code.indexOf('/ {'))).toBe(
      SOURCE.slice(0, SOURCE.indexOf('/ {'))
    )
    expect(parseDtsKeymap(built.code).layers[0]).toEqual(['&vendor UC_DE_AE', '&kp B'])
    expect(JSON.parse(built.json).layers[0]).toEqual(['&vendor UC_DE_AE', '&kp B'])
  })

  it('treats unknown behavior arguments as raw without changing known schemas', () => {
    expect(getBehaviourParams(parseKeyBinding('&vendor UC_DE_AE').params, undefined)).toEqual([
      'raw'
    ])
    expect(getBehaviourParams(parseKeyBinding('&vendor 0xE4 0xC4').params, undefined)).toEqual([
      'raw',
      'raw'
    ])
    expect(getBehaviourParams([], undefined)).toEqual([])
    expect(getBehaviourParams([{ value: 'A' }], { params: ['code'] })).toEqual(['code'])
  })

  it.each(['&', '& vendor', '&vendor-bad 1', '&vendor(1)', '&kp! A', 'vendor 1', '&1bad 1'])(
    'rejects a malformed behavior reference: %s',
    binding => {
      expect(() => validateKeymapJson({ layers: [[binding]] })).toThrow(KeymapValidationError)
      expect(isPrimaryKeymapJson({ layers: [[binding]] })).toBe(false)
    }
  )

  it.each([null, {}, { layers: 'bad' }, { layers: [null] }, { layers: [[42]] }])(
    'keeps structural validation: %j',
    keymap => {
      expect(() => validateKeymapJson(keymap)).toThrow(KeymapValidationError)
    }
  )
})
