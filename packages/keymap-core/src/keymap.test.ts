import { describe, expect, it } from 'vitest'
import {
  buildKeymapCode,
  generateKeymap,
  isPrimaryKeymapJson,
  isUserKeymapFilename,
  KeymapValidationError,
  loadBehaviorsData,
  matchingInfoJsonFilename,
  normalizeParsedKeymap,
  parseKeyBinding,
  parseKeymap
} from './keymap.js'
import type { LayoutKey } from './types.js'

const TINY_LAYOUT: LayoutKey[] = [
  { x: 0, y: 0, row: 0, col: 0 },
  { x: 1, y: 0, row: 0, col: 1 }
]

describe('parseKeyBinding', () => {
  it('splits hold-tap params on tabs', () => {
    expect(parseKeyBinding('&mt\tLSHIFT\tA')).toEqual({
      value: '&mt',
      params: [
        { value: 'LSHIFT', params: [] },
        { value: 'A', params: [] }
      ]
    })
  })

  it('keeps spaces inside parentheses as one param', () => {
    expect(parseKeyBinding('&kp LS( A )')).toEqual({
      value: '&kp',
      params: [{ value: 'LS', params: [{ value: 'A', params: [] }] }]
    })
  })

  it('throws KeymapValidationError for a lone &', () => {
    expect(() => parseKeyBinding('&')).toThrow(KeymapValidationError)
    try {
      parseKeyBinding('&')
      expect.unreachable('expected lone & to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(KeymapValidationError)
      expect((e as KeymapValidationError).errors[0]).toMatch(/invalid key binding/i)
    }
  })
})

describe('normalizeParsedKeymap', () => {
  it('fills missing layer_names as Layer N', () => {
    const km = normalizeParsedKeymap({
      layers: [
        [{ value: '&kp', params: [{ value: 'A', params: [] }] }],
        [{ value: '&trans', params: [] }]
      ]
    })
    expect(km.layer_names).toEqual(['Layer 0', 'Layer 1'])
  })

  it('keeps existing layer_names and stringifies them', () => {
    const km = normalizeParsedKeymap({
      layer_names: ['Base', 2 as unknown as string],
      layers: [
        [{ value: '&kp', params: [{ value: 'A', params: [] }] }],
        [{ value: '&trans', params: [] }]
      ]
    })
    expect(km.layer_names).toEqual(['Base', '2'])
  })
})

describe('isPrimaryKeymapJson', () => {
  it('accepts a non-empty valid keymap', () => {
    expect(isPrimaryKeymapJson({ layers: [['&kp A']] })).toBe(true)
  })

  it('rejects empty layer shells', () => {
    expect(isPrimaryKeymapJson({ layers: [[]] })).toBe(false)
    expect(isPrimaryKeymapJson({ layers: [] })).toBe(false)
  })

  it('rejects invalid binds without throwing', () => {
    expect(isPrimaryKeymapJson({ layers: [['not-a-bind']] })).toBe(false)
  })

  it('rejects null', () => {
    expect(isPrimaryKeymapJson(null)).toBe(false)
  })

  it('accepts &mkp once the mouse behaviour is in the catalog', () => {
    expect(isPrimaryKeymapJson({ layers: [['&mkp LCLK']] })).toBe(true)
  })
})

describe('generateKeymap mouse includes', () => {
  it('adds pointing.h once when mouse behaviours are used', () => {
    const { code } = generateKeymap(
      [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      parseKeymap({ layers: [['&mkp LCLK', '&msc SCRL_DOWN']] })
    )
    expect(code).toContain('#include <dt-bindings/zmk/pointing.h>')
    expect(code.match(/dt-bindings\/zmk\/pointing\.h/g)?.length).toBe(1)
    expect(code).toContain('&mkp LCLK')
  })

  it('adds includes for combo and encoder binds not used on layers', () => {
    const { code } = generateKeymap(
      [{ x: 0, y: 0 }],
      parseKeymap({
        layers: [['&trans']],
        combos: [
          {
            id: 'combo_bt',
            binding: '&bt BT_CLR',
            keyPositions: [0, 0]
          }
        ],
        sensorBindings: [['&mkp LCLK']]
      })
    )
    expect(code).toContain('#include <dt-bindings/zmk/bt.h>')
    expect(code).toContain('#include <dt-bindings/zmk/pointing.h>')
  })

  it('gives colliding sanitized layer names unique _2 suffixes', () => {
    const layout = [{ x: 0, y: 0 }, { x: 1, y: 0 }]
    const { code } = generateKeymap(
      layout,
      parseKeymap({
        layer_names: ['Base', 'a b', 'a-b'],
        layers: [
          ['&kp A', '&trans'],
          ['&kp B', '&trans'],
          ['&kp C', '&trans']
        ]
      })
    )
    expect(code).toMatch(/\bdefault_layer\s*\{/)
    expect(code).toMatch(/\blayer_a_b\s*\{/)
    expect(code).toMatch(/\blayer_a_b_2\s*\{/)
    expect(code.match(/\blayer_a_b\s*\{/g)?.length).toBe(1)

    const cyrillic = generateKeymap(
      layout,
      parseKeymap({
        layer_names: ['Base', 'аб', 'вг'],
        layers: [
          ['&kp A', '&trans'],
          ['&kp B', '&trans'],
          ['&kp C', '&trans']
        ]
      })
    ).code
    expect(cyrillic).toMatch(/\blayer___\s*\{/)
    expect(cyrillic).toMatch(/\blayer____2\s*\{/)
    expect(cyrillic.match(/\blayer___\s*\{/g)?.length).toBe(1)
  })

  it('inserts $& from a binding as a literal in code and json', () => {
    const layout = [{ x: 0, y: 0 }, { x: 1, y: 0 }]
    const { code, json } = generateKeymap(
      layout,
      parseKeymap({ layers: [['&kp $&', '&trans']] })
    )
    expect(code).toContain('&kp $&')
    expect(code).not.toContain('{{rendered_layers}}')
    expect(code).not.toContain('{{ rendered_layers }}')
    expect(json).toContain('&kp $&')
    expect(json).not.toMatch(/"layers": null/)
  })
})

describe('isUserKeymapFilename', () => {
  it('accepts user .keymap files', () => {
    expect(isUserKeymapFilename('lark.keymap')).toBe(true)
    expect(isUserKeymapFilename('LARK.KEYMAP')).toBe(true)
  })

  it('rejects templates and other files', () => {
    expect(isUserKeymapFilename('lark.keymap.template')).toBe(false)
    expect(isUserKeymapFilename('readme.md')).toBe(false)
  })
})

describe('matchingInfoJsonFilename', () => {
  it('maps a user keymap filename to its sibling layout filename', () => {
    expect(matchingInfoJsonFilename('corne_choc_pro.keymap')).toBe('corne_choc_pro.json')
    expect(matchingInfoJsonFilename('LARK.KEYMAP')).toBe('LARK.json')
  })

  it('does not collide with reserved info or keymap JSON files', () => {
    expect(matchingInfoJsonFilename('info.keymap')).toBeNull()
    expect(matchingInfoJsonFilename('INFO.KEYMAP')).toBeNull()
    expect(matchingInfoJsonFilename('keymap.keymap')).toBeNull()
    expect(matchingInfoJsonFilename('KEYMAP.KEYMAP')).toBeNull()
  })

  it('rejects templates and non-keymap names', () => {
    expect(matchingInfoJsonFilename('lark.keymap.template')).toBeNull()
    expect(matchingInfoJsonFilename('readme.md')).toBeNull()
  })
})

describe('parseKeymap combos from keymap.json', () => {
  it('round-trips layers, slowRelease, requirePriorIdleMs, and timeoutMs', () => {
    const km = parseKeymap({
      layers: [['&kp A', '&trans']],
      combos: [
        {
          id: 'combo_esc',
          binding: {
            value: '&kp',
            params: [{ value: 'ESC', params: [] }]
          },
          keyPositions: [0, 1],
          timeoutMs: 40,
          requirePriorIdleMs: 80,
          slowRelease: true,
          layers: [0, 1]
        }
      ]
    })
    const again = parseKeymap(
      JSON.parse(buildKeymapCode(TINY_LAYOUT, km).json) as {
        layers: string[][]
      }
    )
    expect(again.combos?.[0]).toEqual({
      id: 'combo_esc',
      binding: {
        value: '&kp',
        params: [{ value: 'ESC', params: [] }]
      },
      keyPositions: [0, 1],
      timeoutMs: 40,
      requirePriorIdleMs: 80,
      slowRelease: true,
      layers: [0, 1]
    })
  })
})

describe('parseKeymap sensorBindings', () => {
  it('throws KeymapValidationError for a non-bind entry', () => {
    expect(() =>
      parseKeymap({
        layers: [['&kp A']],
        sensorBindings: [[{ nope: true }]]
      })
    ).toThrow(KeymapValidationError)
  })
})

describe('loadBehaviorsData', () => {
  it('returns a copy so callers cannot mutate the shared catalog', () => {
    const first = loadBehaviorsData()
    const bt = first.find(row => row.code === '&bt')
    expect(bt?.includes).toBeTruthy()
    bt!.includes!.push('#include <mutated.h>')
    bt!.commands!.push({ code: 'MUTATED' })
    const second = loadBehaviorsData().find(row => row.code === '&bt')
    expect(second?.includes).not.toContain('#include <mutated.h>')
    expect(second?.commands?.some(row => row.code === 'MUTATED')).toBe(false)
  })
})
