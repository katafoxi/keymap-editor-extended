import { beforeEach, describe, expect, it } from 'vitest'
import { addHostLanguage, hostLayout, parseKeyBinding } from '@keymap-editor/keymap-core'
import { editor } from './editor.svelte.js'
import { clearHostLayoutStore } from './host-layout-store'

function useKeymap(...codes: string[]) {
  editor.draftKeymap = { layer_names: ['default'], layers: [codes.map(parseKeyBinding)] }
}

function baseGlyph(language: 'en' | 'ru', zmk: string, level = 0) {
  return hostLayout(editor.activeProfileId(language))?.byZmk.get(zmk)?.glyphs[level]
}

describe('editor &uc service-key guard', () => {
  beforeEach(async () => {
    editor.resetForTests()
    await clearHostLayoutStore()
    await editor.restoreHostProfiles()
  })

  it('counts &uc keys in the draft', () => {
    expect(editor.unicodeKeyCount).toBe(0)
    useKeymap('&uc UC_DE_AE', '&kp A', '&uc 0xE4 0')
    expect(editor.unicodeKeyCount).toBe(2)
  })

  it('holds back an unshifted English service-cell edit until confirmed', async () => {
    useKeymap('&uc UC_DE_AE')
    editor.armHostSymbolEdit({ language: 'en', zmk: 'N1', level: 0 })

    const held = await editor.pickHostSymbol('!')
    expect(held).toEqual({ ok: false, reason: 'unicode-service-key' })
    expect(editor.unicodeServiceConfirm).toMatchObject({ zmk: 'N1', level: 0, text: '!', required: '1' })
    expect(baseGlyph('en', 'N1')).toBe('1')

    const written = await editor.confirmUnicodeServiceEdit()
    expect(written.ok).toBe(true)
    expect(editor.unicodeServiceConfirm).toBeNull()
    expect(baseGlyph('en', 'N1')).toBe('!')
  })

  it('drops the held edit on Keep', async () => {
    useKeymap('&uc UC_DE_AE')
    editor.armHostSymbolEdit({ language: 'en', zmk: 'A', level: 0 })
    await editor.pickHostSymbol('NoSymbol')
    expect(editor.unicodeServiceConfirm?.required).toBe('a')

    editor.dismissUnicodeServiceEdit()
    expect(editor.unicodeServiceConfirm).toBeNull()
    expect(baseGlyph('en', 'A')).toBe('a')
  })

  it.each([
    ['Shift level of a service key', { language: 'en', zmk: 'N1', level: 1 }, '¡'],
    ['AltGr level of a service key', { language: 'en', zmk: 'N1', level: 2 }, '€'],
    ['non-service key', { language: 'en', zmk: 'G', level: 0 }, 'γ'],
    ['restoring the required character', { language: 'en', zmk: 'N2', level: 0 }, '2']
  ] as const)('writes at once: %s', async (_name, target, text) => {
    useKeymap('&uc UC_DE_AE')
    editor.armHostSymbolEdit(target)
    const result = await editor.pickHostSymbol(text)
    expect(result.ok).toBe(true)
    expect(editor.unicodeServiceConfirm).toBeNull()
  })

  it('leaves the national column alone', async () => {
    useKeymap('&uc UC_DE_AE')
    editor.hostLegend = addHostLanguage(editor.hostLegend, 'ru')
    editor.armHostSymbolEdit({ language: 'ru', zmk: 'A', level: 0 })
    const result = await editor.pickHostSymbol('я')
    expect(result.ok).toBe(true)
    expect(baseGlyph('ru', 'A')).toBe('я')
  })

  it('does not guard without &uc in the keymap', async () => {
    useKeymap('&kp A')
    editor.armHostSymbolEdit({ language: 'en', zmk: 'N1', level: 0 })
    const result = await editor.pickHostSymbol('!')
    expect(result.ok).toBe(true)
    expect(baseGlyph('en', 'N1')).toBe('!')
  })
})
