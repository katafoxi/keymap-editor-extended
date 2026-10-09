/**
 * Local adapter save/load against a temp copy of the vendored LARK fixture.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeKeyBinding } from '@keymap-editor/keymap-core'
import { config } from '../../config.js'
import * as zmk from './local-source.js'

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/keymap-core/fixtures/lark'
)

let tmpRoot: string
let previousZmkPath: string

function bindStrings(km: ReturnType<typeof zmk.loadKeymap>): string[] {
  return km.layers.flat().map(encodeKeyBinding)
}

beforeEach(() => {
  previousZmkPath = config.ZMK_CONFIG_PATH
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keymap-lark-'))
  const configDir = path.join(tmpRoot, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.copyFileSync(
    path.join(FIXTURE_DIR, 'lark.keymap'),
    path.join(configDir, 'lark.keymap')
  )
  fs.copyFileSync(
    path.join(FIXTURE_DIR, 'info.json'),
    path.join(configDir, 'info.json')
  )
  config.ZMK_CONFIG_PATH = tmpRoot
})

afterEach(() => {
  config.ZMK_CONFIG_PATH = previousZmkPath
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('local-source LARK fixture', () => {
  it('loads from .keymap with expanded macros when keymap.json is absent', () => {
    const loaded = zmk.loadKeymap()
    const binds = bindStrings(loaded)
    expect(binds.some(b => b.includes('C_VOL_UP'))).toBe(true)
    expect(binds.some(b => /\bVU\b/.test(b))).toBe(false)
    expect(loaded.layers.length).toBe(7)
    expect(loaded.layers[0].length).toBe(zmk.loadLayout().length)
    expect(loaded.holdTaps).toEqual([
      { code: '&mt', override: true, flavor: 'tap-preferred', tappingTermMs: 300 },
      { code: '&lt', override: true, flavor: 'balanced', tappingTermMs: 150 }
    ])
  })

  it('writes files and reloads expanded bindings after save', () => {
    const loaded = zmk.loadKeymap()
    const layout = zmk.loadLayout()

    const draft = {
      ...loaded,
      layers: loaded.layers.map((layer, li) =>
        li === 0
          ? layer.map((bind, ki) =>
              ki === 1
                ? { value: '&kp', params: [{ value: 'M', params: [] }] }
                : bind
            )
          : layer
      )
    }

    const result = zmk.saveLocalKeymap(draft)
    expect(result.mode).toBe('splice')
    expect(result.warnings).toContain('macros_expanded')

    const keymapJsonPath = path.join(tmpRoot, 'config', 'keymap.json')
    const keymapPath = path.join(tmpRoot, 'config', 'lark.keymap')
    expect(fs.existsSync(keymapJsonPath)).toBe(true)
    expect(fs.existsSync(keymapPath)).toBe(true)

    const writtenCode = fs.readFileSync(keymapPath, 'utf8')
    expect(writtenCode).toContain('#define VU')
    expect(writtenCode).toContain('C_VOL_UP')
    expect(writtenCode).not.toMatch(/bindings = <[^>]*\bVU\b/)

    const writtenJson = fs.readFileSync(keymapJsonPath, 'utf8')
    expect(writtenJson).toContain('C_VOL_UP')
    expect(writtenJson).toContain('&kp M')

    const reloaded = zmk.loadKeymap()
    expect(reloaded.layers[0].length).toBe(layout.length)
    const binds = bindStrings(reloaded)
    expect(binds.some(b => b.includes('C_VOL_UP'))).toBe(true)
    expect(binds.some(b => b === '&kp M' || b.startsWith('&kp M'))).toBe(true)
  })

  it('loads a matching keymap JSON layout when info.json is absent', () => {
    const configDir = path.join(tmpRoot, 'config')
    const infoPath = path.join(configDir, 'info.json')
    const expectedLayout = zmk.loadLayout()
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as {
      layouts: Record<string, unknown>
    }
    fs.rmSync(infoPath)
    fs.writeFileSync(
      path.join(configDir, 'lark.json'),
      JSON.stringify({ ...info, layouts: { default_layout: info.layouts.LAYOUT } })
    )

    expect(zmk.loadLayout()).toEqual(expectedLayout)
  })

  it('loadLayout throws a path-free ENOENT when info.json is missing', () => {
    fs.rmSync(path.join(tmpRoot, 'config', 'info.json'))
    expect(() => zmk.loadLayout()).toThrow(/Layout info\.json not found/)
    try {
      zmk.loadLayout()
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
      expect(String(err)).not.toContain(tmpRoot)
    }
  })
})
