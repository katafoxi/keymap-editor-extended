import { describe, expect, it } from 'vitest'
import {
  unicodeCodePoint,
  unicodeBinding,
  unicodeBindingState,
  unicodeAliasBinding,
  unicodeModeBinding,
  unicodeHostLayoutCompatibility,
  unicodeServiceCharacter,
  unicodeBindingCount,
  UNICODE_ALIASES,
  UNICODE_MODES,
  ensureUnicodeInclude
} from './unicode.js'
import { parseKeyBinding, encodeKeyBinding, parseKeymap, buildKeymapCode, validateKeymapJson } from './keymap.js'
import { getBehaviourParams } from './keycodes.js'
import { loadBehaviorsData } from './keymap.js'
import { hostLayout } from './host-layout-registry.js'
import { withHostKey } from './host-layout.js'

const layout = [{ x: 0, y: 0, row: 0, col: 0 }]

describe('ZMK Unicode input', () => {
  it.each([['ä', 228], ['😀', 128512], ['U+00E4', 228], ['0x10FFFF', 1114111], ['0', 0]])(
    'accepts a scalar or explicit code point %s', (input, expected) => {
      expect(unicodeCodePoint(input)).toBe(expected)
    }
  )

  it.each(['', 'ab', 'U+D800', '0x110000', '-1', '1.2', 'U+xyz', '\uDFFF'])(
    'rejects invalid scalar input %j', input => {
      expect(unicodeCodePoint(input)).toBeNull()
    }
  )

  it('builds the two-cell unshifted and shifted binding', () => {
    expect(encodeKeyBinding(unicodeBinding('ä', 'Ä'))).toBe('&uc 0xE4 0xC4')
    expect(encodeKeyBinding(unicodeBinding('😀', '0'))).toBe('&uc 0x1F600 0')
    expect(() => unicodeBinding('U+D800', '0')).toThrow()
  })

  it('decodes shifted-zero semantics and leaves the original binding unchanged', () => {
    const original = parseKeyBinding('&uc 0xe4 0')
    expect(unicodeBindingState(original)).toEqual({ kind: 'codepoints', normal: 228, shift: 0 })
    expect(encodeKeyBinding(original)).toBe('&uc 0xe4 0')
  })

  it('uses upstream alias pairs without inferring uppercase with JavaScript', () => {
    expect(UNICODE_ALIASES.find(row => row.code === 'UC_DE_SS')).toMatchObject({ normal: 223, shift: 7838 })
    expect(unicodeBindingState(unicodeAliasBinding('UC_DE_AE'))).toEqual({ kind: 'codepoints', normal: 228, shift: 196 })
    expect(encodeKeyBinding(unicodeAliasBinding('UC_DE_OE'))).toBe('&uc UC_DE_OE')
    expect(() => unicodeAliasBinding('UC_FAKE')).toThrow()
  })

  it('recognizes all six mode switches separately from character input', () => {
    expect(UNICODE_MODES).toHaveLength(6)
    for (const mode of UNICODE_MODES) {
      expect(unicodeBindingState(unicodeModeBinding(mode.code))).toEqual({ kind: 'mode', mode: mode.code })
    }
    expect(unicodeBindingState(parseKeyBinding('&uc 0xffffff 1'))).toEqual({ kind: 'mode', mode: 'UC_SET_LINUX' })
  })

  it('checks the editor-managed English base level without rejecting Shift or AltGr symbols', () => {
    const us = hostLayout('system-us')!
    const shifted = withHostKey(us, 'N1', 1, 'at')!
    const altGr = withHostKey(shifted, 'N1', 2, 'EuroSign')!
    const remapped = withHostKey(altGr, 'N1', 0, 'exclam')!

    expect(unicodeHostLayoutCompatibility(us)).toEqual({ compatible: true, missing: [] })
    expect(unicodeHostLayoutCompatibility(altGr)).toEqual({ compatible: true, missing: [] })
    expect(unicodeHostLayoutCompatibility(remapped)).toEqual({ compatible: false, missing: ['1'] })
  })

  it('names the unshifted service character for each of the 17 host cells', () => {
    expect(unicodeServiceCharacter('N1', 0)).toBe('1')
    expect(unicodeServiceCharacter('N0', 0)).toBe('0')
    expect(unicodeServiceCharacter('F', 0)).toBe('f')
    expect(unicodeServiceCharacter('U', 0)).toBe('u')
    expect(unicodeServiceCharacter('N1', 1)).toBeNull()
    expect(unicodeServiceCharacter('N1', 2)).toBeNull()
    expect(unicodeServiceCharacter('G', 0)).toBeNull()
    const cells = [...'1234567890'].map(d => `N${d}`).concat([...'ABCDEFU'])
    expect(cells.filter(zmk => unicodeServiceCharacter(zmk, 0) != null)).toHaveLength(17)
  })

  it('counts &uc on layers, combos, and sensor turns', () => {
    const keymap = parseKeymap({
      layers: [['&uc UC_DE_AE', '&kp A'], ['&uc 0xE4 0', '&uc UC_SET_LINUX']],
      combos: [{ id: 'c', binding: '&uc UC_DE_OE', keyPositions: [0, 1] }],
      sensorBindings: [['&uc UC_DE_UE'], []]
    })
    expect(unicodeBindingCount(keymap)).toBe(5)
    expect(unicodeBindingCount(parseKeymap({ layers: [['&kp A']] }))).toBe(0)
  })

  it('keeps unrecognized external aliases opaque', () => {
    const unknown = parseKeyBinding('&uc UC_SOME_EXTERNAL_NAME')
    expect(unicodeBindingState(unknown)).toBeNull()
    const behavior = loadBehaviorsData().find(row => row.code === '&uc')!
    expect(behavior.params).toEqual(['raw', 'raw'])
    expect(getBehaviourParams(unknown.params, behavior)).toEqual(['raw'])
    expect(() => validateKeymapJson({ layers: [['&uc UC_SOME_EXTERNAL_NAME']] })).not.toThrow()
  })

  it('adds the module header when a Unicode binding is spliced into existing source', () => {
    const originalSource = '/ { keymap { compatible = "zmk,keymap"; default_layer { bindings = <&kp A>; }; }; };'
    const keymap = parseKeymap({ layers: [['&uc UC_DE_AE']] })
    const built = buildKeymapCode(layout, keymap, { originalSource })
    expect(built.code).toContain('#include <behaviors/unicode.dtsi>')
    expect(built.code).toContain('&uc UC_DE_AE')
  })

  it('keeps preprocessor flags before the new module include', () => {
    const source = '#define ZMK_BEHAVIORS_KEEP_UC\n#include <behaviors.dtsi>\n/ { };\n'
    const updated = ensureUnicodeInclude(source)
    expect(updated).toBe('#define ZMK_BEHAVIORS_KEEP_UC\n#include <behaviors.dtsi>\n#include <behaviors/unicode.dtsi>\n/ { };\n')
  })

  it.each(['#include <behaviors/unicode.dtsi>\n', '# include "behaviors/unicode.dtsi"\r\n'])(
    'keeps an existing module header byte-identical', header => {
      expect(ensureUnicodeInclude(header + '/ { };')).toBe(header + '/ { };')
    }
  )

  it('ignores commented headers and preserves CRLF', () => {
    const source = '/*\r\n#include <behaviors/unicode.dtsi>\r\n*/\r\n#include <behaviors.dtsi>\r\n/ { };'
    expect(ensureUnicodeInclude(source)).toBe(source.replace('/ { };', '#include <behaviors/unicode.dtsi>\r\n/ { };'))
  })

  it('ships every curated alias from the pinned 17 upstream headers', () => {
    expect(UNICODE_ALIASES).toHaveLength(292)
    expect(new Set(UNICODE_ALIASES.map(row => row.code)).size).toBe(292)
    expect(new Set(UNICODE_ALIASES.map(row => row.group)).size).toBe(17)
    for (const row of UNICODE_ALIASES) {
      expect(unicodeCodePoint(row.normal)).toBe(row.normal)
      expect(unicodeCodePoint(row.shift)).toBe(row.shift)
    }
  })
})
