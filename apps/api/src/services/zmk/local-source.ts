import fs from 'node:fs'
import path from 'node:path'
import {
  buildKeymapCode,
  isPrimaryKeymapJson,
  isUserKeymapFilename,
  matchingInfoJsonFilename,
  parseDtsKeymap,
  parseKeymap,
  pickInfoLayout,
  type BuildKeymapCodeResult,
  type LayoutKey,
  type ParsedKeymap
} from '@keymap-editor/keymap-core'
import { config } from '../../config.js'

const EMPTY_KEYMAP = {
  keyboard: 'unknown',
  keymap: 'unknown',
  layout: 'unknown',
  layer_names: ['default'],
  layers: [[]] as string[][]
}

function matchingInfoPath(keymapFile: string): string | null {
  const filename = matchingInfoJsonFilename(keymapFile)
  return filename ? path.join(config.ZMK_CONFIG_PATH, 'config', filename) : null
}

function missingLayoutInfo(): Error & { code: 'ENOENT' } {
  return Object.assign(new Error('Layout info.json not found'), { code: 'ENOENT' as const })
}

function readLayoutInfo(): unknown {
  const infoPath = path.join(config.ZMK_CONFIG_PATH, 'config', 'info.json')
  try {
    return JSON.parse(fs.readFileSync(infoPath, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const keymapFile = findKeymapFile()
  if (keymapFile) {
    const fallbackPath = matchingInfoPath(keymapFile)
    if (fallbackPath) {
      try {
        return JSON.parse(fs.readFileSync(fallbackPath, 'utf8'))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
  }

  throw missingLayoutInfo()
}

export function loadLayout(layoutName?: string): LayoutKey[] {
  return pickInfoLayout(readLayoutInfo(), { layoutName }).layout
}

function findKeymapFile(): string | null {
  const dir = path.join(config.ZMK_CONFIG_PATH, 'config')
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir)
  return files.find(file => isUserKeymapFilename(file)) ?? null
}

function findKeymapTemplateFile(): string | null {
  const dir = path.join(config.ZMK_CONFIG_PATH, 'config')
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir)
  return (
    files.find(file => file.toLowerCase().endsWith('.keymap.template')) ?? null
  )
}

function loadKeymapFromDts(): ParsedKeymap | null {
  const keymapFile = findKeymapFile()
  if (!keymapFile) return null
  const source = fs.readFileSync(
    path.join(config.ZMK_CONFIG_PATH, 'config', keymapFile),
    'utf8'
  )
  let keyboard = 'unknown'
  try {
    const info = readLayoutInfo() as { id?: string; name?: string }
    keyboard = info.id || info.name || keyboard
  } catch {
    /* ignore */
  }
  const raw = parseDtsKeymap(source, {
    keyboard,
    keymap: keymapFile.replace(/\.keymap$/i, ''),
    layout: 'LAYOUT'
  })
  return parseKeymap(raw)
}

export function loadKeymap(): ParsedKeymap {
  const keymapPath = path.join(config.ZMK_CONFIG_PATH, 'config', 'keymap.json')
  if (fs.existsSync(keymapPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(keymapPath, 'utf8'))
      if (isPrimaryKeymapJson(parsed)) {
        const keymap = parseKeymap(parsed)
        if (keymap.holdTaps === undefined || keymap.sensorBindings === undefined) {
          const fromDts = loadKeymapFromDts()
          if (keymap.holdTaps === undefined) {
            keymap.holdTaps = fromDts?.holdTaps ?? []
          }
          if (keymap.sensorBindings === undefined) {
            keymap.sensorBindings = fromDts?.sensorBindings ?? []
          }
        }
        return keymap
      }
    } catch {
      /* fall through to .keymap */
    }
  }
  const fromDts = loadKeymapFromDts()
  if (fromDts) return fromDts
  return parseKeymap(EMPTY_KEYMAP)
}

export function saveLocalKeymap(
  keymap: ParsedKeymap
): Pick<BuildKeymapCodeResult, 'mode' | 'warnings'> {
  const keymapDir = path.join(config.ZMK_CONFIG_PATH, 'config')
  const keymapFile = findKeymapFile()
  if (!keymapFile) {
    throw new Error('No .keymap file in zmk-config/config')
  }

  const layout = loadLayout()
  const keymapPath = path.join(keymapDir, keymapFile)
  const originalSource = fs.existsSync(keymapPath)
    ? fs.readFileSync(keymapPath, 'utf8')
    : undefined

  const templateFile = findKeymapTemplateFile()
  const template =
    templateFile != null
      ? fs.readFileSync(path.join(keymapDir, templateFile), 'utf8')
      : undefined

  const built = buildKeymapCode(layout, keymap, { template, originalSource })

  if (!fs.existsSync(keymapDir)) fs.mkdirSync(keymapDir, { recursive: true })
  fs.writeFileSync(path.join(keymapDir, 'keymap.json'), built.json)
  fs.writeFileSync(keymapPath, built.code)

  return { mode: built.mode, warnings: built.warnings }
}
