import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { encodeKeyBinding } from '@keymap-editor/keymap-core'
import { loadClipboardBundle, parseClipboardInfo, parseClipboardKeymap } from './load'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../../../../../packages/keymap-core/fixtures/lark')
const infoText = readFileSync(join(fixtures, 'info.json'), 'utf8')
const keymapText = readFileSync(join(fixtures, 'lark.keymap'), 'utf8')

describe('parseClipboardInfo', () => {
  it('reads the first layout from info.json', () => {
    const info = parseClipboardInfo(infoText)
    expect(info.keyboard).toBe('lark')
    expect(info.layoutName).toBe('LAYOUT')
    expect(info.layout.length).toBeGreaterThan(10)
  })

  it('rejects empty layout text', () => {
    expect(() => parseClipboardInfo('')).toThrow(/empty/i)
  })
})

describe('parseClipboardKeymap', () => {
  it('parses a .keymap and keeps originalSource', () => {
    const result = parseClipboardKeymap(keymapText, {
      keyboard: 'lark',
      layoutName: 'LAYOUT'
    })
    expect(result.originalSource).toBe(keymapText.trim())
    expect(result.keymap.layers.length).toBeGreaterThan(0)
    expect(result.keymap.keyboard).toBe('lark')
  })

  it('parses keymap.json that uses an external behavior', () => {
    const json = JSON.stringify({ layers: [['&vendor UC_DE_AE']] })
    const result = parseClipboardKeymap(json, {
      keyboard: 'toy',
      layoutName: 'LAYOUT'
    })
    expect(encodeKeyBinding(result.keymap.layers[0][0])).toBe('&vendor UC_DE_AE')
  })

  it('rejects keymap.json with a malformed behavior name', () => {
    const json = JSON.stringify({ layers: [['&vendor-bad 1']] })
    expect(() =>
      parseClipboardKeymap(json, { keyboard: 'toy', layoutName: 'LAYOUT' })
    ).toThrow(/invalid behaviour/)
  })

  it('parses keymap.json without originalSource', () => {
    const json = JSON.stringify({
      keyboard: 'toy',
      layout: 'LAYOUT',
      layer_names: ['default'],
      layers: [['&kp A', '&kp B']]
    })
    const result = parseClipboardKeymap(json, {
      keyboard: 'toy',
      layoutName: 'LAYOUT'
    })
    expect(result.originalSource).toBeNull()
    expect(result.warnings).toContain('clipboard_json_no_export_source')
    expect(result.keymap.layers[0]).toHaveLength(2)
  })

  it('uses export .keymap when the load paste is keymap.json', () => {
    const json = JSON.stringify({
      layer_names: ['default'],
      layers: [Array(84).fill('&trans')]
    })
    const result = parseClipboardKeymap(
      json,
      { keyboard: 'lark', layoutName: 'LAYOUT' },
      keymapText
    )
    expect(result.originalSource).toBe(keymapText.trim())
    expect(result.warnings).not.toContain('clipboard_json_no_export_source')
  })
})

describe('loadClipboardBundle', () => {
  it('loads matching lark info + keymap', () => {
    const bundle = loadClipboardBundle(infoText, keymapText)
    expect(bundle.keyboard).toBe('lark')
    expect(bundle.inferredLayout).toBe(false)
    expect(bundle.layout.length).toBe(bundle.keymap.layers[0].length)
    expect(bundle.originalSource).toContain('compatible = "zmk,keymap"')
  })

  it('infers a rectangular layout when info.json is omitted', () => {
    const bundle = loadClipboardBundle('', keymapText)
    expect(bundle.inferredLayout).toBe(true)
    expect(bundle.warnings).toContain('clipboard_inferred_layout')
    expect(bundle.layout.length).toBe(bundle.keymap.layers[0].length)
    expect(bundle.layout[0]).toMatchObject({ row: 0, col: 0, x: 0, y: 0 })
    expect(bundle.originalSource).toContain('compatible = "zmk,keymap"')
  })

  it('rejects a keymap whose layer length does not match the layout', () => {
    const json = JSON.stringify({
      layers: [['&kp A']]
    })
    expect(() => loadClipboardBundle(infoText, json)).toThrow(/layout has/i)
  })
})
