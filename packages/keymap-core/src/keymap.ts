import behaviorsData from '../data/zmk-behaviors.json' with { type: 'json' }
import { spliceCombosIntoDts, type DtsComboJson } from './dts-combos.js'
import {
  encodeConditionalLayerFingerprint,
  normalizeConditionalLayers,
  spliceConditionalLayersIntoDts
} from './dts-conditional-layers.js'
import {
  normalizeRgbLayerBinding,
  RGB_LAYER_RECIPE,
  shouldEnsureRgbLayerRecipe,
  spliceRgbLayerRecipeIntoDts
} from './behavior-recipes.js'
import { normalizeHoldTaps, spliceHoldTapsIntoDts } from './dts-behaviors.js'
import {
  compileMacros,
  findKeymapLayerNodes,
  findZmkKeymapBlock,
  keymapBindingsText,
  macrosAppearInText,
  parseDefines,
  parseDtsKeymap
} from './dts-keymap.js'
import {
  encodeComboFingerprint,
  encodeHoldTapFingerprint
} from './keymap-diff.js'
import { spliceSensorBindingsIntoDts } from './dts-sensors.js'
import { uniqueDtsNodeId } from './dts-scan.js'
import { assertLayerKeyCounts, spliceBindingsIntoDts } from './dts-splice.js'
import { bindingColumnWidths, renderTable } from './layout.js'
import { KeymapValidationError } from './errors.js'
import type {
  BehaviorDef,
  KeyBindingNode,
  LayoutKey,
  ParsedKeymap,
  ZmkCombo,
  ZmkConditionalLayer,
  ZmkHoldTap
} from './types.js'

export { KeymapValidationError } from './errors.js'

export type BuildKeymapCodeMode = 'template' | 'splice' | 'default_template'

export interface BuildKeymapCodeResult {
  code: string
  json: string
  mode: BuildKeymapCodeMode
  warnings: string[]
}

const behaviours = behaviorsData as BehaviorDef[]
const behavioursByBind = Object.fromEntries(behaviours.map(b => [b.code, b]))

const INCLUDES_PATTERN = /\{\{\s*behaviour_includes\s*\}\}/
const LAYERS_PATTERN = /\{\{\s*rendered_layers\s*\}\}/

export type EncodedKeymap = Omit<ParsedKeymap, 'layers' | 'combos' | 'sensorBindings'> & {
  layers: string[][]
  combos?: DtsComboJson[]
  sensorBindings?: string[][]
}

const keymapTemplate = `
/*
 * Copyright (c) 2020 The ZMK Contributors
 *
 * SPDX-License-Identifier: MIT
 */


/* THIS FILE WAS GENERATED!
 *
 * This file was generated automatically. You may or may not want to
 * edit it directly.
 */

#include <behaviors.dtsi>
{{behaviour_includes}}

/ {
    keymap {
        compatible = "zmk,keymap";

{{rendered_layers}}
    };
};
`

function encodeBindValue(parsed: KeyBindingNode): string {
  const params = (parsed.params || []).map(encodeBindValue)
  const paramString = params.length > 0 ? `(${params.join(',')})` : ''
  return String(parsed.value) + paramString
}

export function encodeKeyBinding(parsed: KeyBindingNode): string {
  const { value, params } = parsed
  return `${value} ${params.map(encodeBindValue).join(' ')}`.trim()
}

export function encodeKeymap(parsedKeymap: ParsedKeymap): EncodedKeymap {
  const combos =
    parsedKeymap.combos !== undefined
      ? parsedKeymap.combos.map(encodeComboToJson)
      : undefined
  const sensorBindings = parsedKeymap.sensorBindings?.map(layer =>
    layer.map(encodeKeyBinding)
  )
  const { layers: _layers, combos: _combos, sensorBindings: _sensors, ...rest } =
    parsedKeymap
  return {
    ...rest,
    layers: parsedKeymap.layers.map(layer => layer.map(encodeKeyBinding)),
    ...(combos !== undefined ? { combos } : {}),
    ...(sensorBindings ? { sensorBindings } : {})
  }
}

function collectBindValues(node: KeyBindingNode, out: Set<string>): void {
  out.add(String(node.value))
}

function getBehavioursUsed(keymap: ParsedKeymap): string[] {
  const used = new Set<string>()
  for (const layer of keymap.layers) {
    for (const bind of layer) collectBindValues(bind, used)
  }
  if (keymap.combos) {
    for (const combo of keymap.combos) collectBindValues(combo.binding, used)
  }
  if (keymap.sensorBindings) {
    for (const layer of keymap.sensorBindings) {
      for (const bind of layer) collectBindValues(bind, used)
    }
  }
  return [...used]
}

/**
 * Split a comma-separated argument list, ignoring commas nested in parentheses.
 */
function splitTopLevelArgs(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      const part = text.slice(start, i).trim()
      if (part.length > 0) parts.push(part)
      start = i + 1
    }
  }
  const last = text.slice(start).trim()
  if (last.length > 0) parts.push(last)
  return parts
}

/**
 * Split bind parameters on whitespace, ignoring spaces nested in parentheses.
 */
function splitTopLevelParams(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth > 0) depth--
    }
    const isWs = depth === 0 && /\s/.test(ch)
    if (isWs) {
      if (start !== -1) {
        parts.push(text.slice(start, i))
        start = -1
      }
    } else if (start === -1) {
      start = i
    }
  }
  if (start !== -1) parts.push(text.slice(start))
  return parts
}

/**
 * Parse a bind string into a tree of values and parameters
 */
export function parseKeyBinding(binding: string): KeyBindingNode {
  if (typeof binding !== 'string') {
    throw new KeymapValidationError([`Invalid key binding: ${String(binding)}`])
  }
  function parse(code: string): KeyBindingNode {
    const open = code.indexOf('(')
    if (open === -1) return { value: code.trim(), params: [] }

    let depth = 0
    let close = -1
    for (let i = open; i < code.length; i++) {
      const ch = code[i]!
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close === -1) return { value: code.trim(), params: [] }

    const value = (code.slice(0, open) + code.slice(close + 1)).trim()
    const params = splitTopLevelArgs(code.slice(open + 1, close)).map(parse)
    return { value, params }
  }

  const trimmed = binding.trim()
  const valueMatch = trimmed.match(/^(&.+?)\b/)
  if (!valueMatch) {
    throw new KeymapValidationError([`Invalid key binding: ${binding}`])
  }
  const value = valueMatch[1]!
  const params = splitTopLevelParams(trimmed.replace(/^&.+?\b\s*/, '')).map(parse)

  return { value, params }
}

function parseBindingInput(item: unknown, label: string): KeyBindingNode {
  if (typeof item === 'string') return parseKeyBinding(item)
  if (item && typeof item === 'object' && 'value' in item) {
    const rec = item as { value: unknown; params?: unknown }
    if (typeof rec.value === 'string' || typeof rec.value === 'number') {
      const params = Array.isArray(rec.params)
        ? rec.params.map(child => parseBindingInput(child, label))
        : []
      return { value: rec.value, params }
    }
  }
  throw new KeymapValidationError([`${label} entries must be bind strings`])
}

function parseComboFromJson(raw: DtsComboJson | ZmkCombo): ZmkCombo {
  if (!raw || typeof raw !== 'object') {
    throw new KeymapValidationError(['combo entries must be objects'])
  }
  const binding = parseBindingInput(raw.binding, 'combo binding')
  const positions = raw.keyPositions
  if (positions !== undefined && !Array.isArray(positions)) {
    throw new KeymapValidationError(['combo keyPositions must be an array'])
  }
  const combo: ZmkCombo = {
    id: String(raw.id),
    keyPositions: [...(positions ?? [])].map(Number),
    binding
  }
  if (raw.timeoutMs !== undefined) combo.timeoutMs = Number(raw.timeoutMs)
  if (raw.requirePriorIdleMs !== undefined) {
    combo.requirePriorIdleMs = Number(raw.requirePriorIdleMs)
  }
  if (raw.slowRelease) combo.slowRelease = true
  if (Array.isArray(raw.layers)) combo.layers = raw.layers.map(Number)
  return combo
}

function encodeComboToJson(combo: ZmkCombo): DtsComboJson {
  const raw: DtsComboJson = {
    id: combo.id,
    keyPositions: [...combo.keyPositions],
    binding: encodeKeyBinding(combo.binding)
  }
  if (combo.timeoutMs !== undefined) raw.timeoutMs = combo.timeoutMs
  if (combo.requirePriorIdleMs !== undefined) {
    raw.requirePriorIdleMs = combo.requirePriorIdleMs
  }
  if (combo.slowRelease) raw.slowRelease = true
  if (combo.layers) raw.layers = [...combo.layers]
  return raw
}

export function parseKeymap(keymap: {
  keyboard?: string
  keymap?: string
  layout?: string
  layer_names?: string[]
  layers: string[][]
  combos?: Array<DtsComboJson | ZmkCombo>
  conditionalLayers?: unknown
  holdTaps?: unknown
  sensorBindings?: unknown
  rgbLayerRecipe?: unknown
}): ParsedKeymap {
  if (typeof keymap !== 'object' || keymap === null) {
    throw new KeymapValidationError(['keymap.json root must be an object'])
  }
  if (!Array.isArray(keymap.layers)) {
    throw new KeymapValidationError(['keymap must include "layers" array'])
  }
  const combos = Array.isArray(keymap.combos)
    ? keymap.combos.map(parseComboFromJson)
    : undefined
  const conditionalLayers = normalizeConditionalLayers(keymap.conditionalLayers)
  const holdTaps = normalizeHoldTaps(keymap.holdTaps)
  const sensorBindings = normalizeSensorBindings(keymap.sensorBindings)
  const out: ParsedKeymap = {
    layers: keymap.layers.map((layer, i) => {
      if (!Array.isArray(layer)) {
        throw new KeymapValidationError([`Layer at layers[${i}] must be an array`])
      }
      return layer.map(item =>
        normalizeRgbLayerBinding(parseBindingInput(item, `layers[${i}]`))
      )
    })
  }
  if (keymap.keyboard !== undefined) out.keyboard = keymap.keyboard
  if (keymap.keymap !== undefined) out.keymap = keymap.keymap
  if (keymap.layout !== undefined) out.layout = keymap.layout
  if (keymap.layer_names !== undefined) out.layer_names = keymap.layer_names
  if (combos !== undefined) {
    out.combos = combos.map(combo => ({
      ...combo,
      binding: normalizeRgbLayerBinding(combo.binding)
    }))
  }
  if (conditionalLayers) out.conditionalLayers = conditionalLayers
  if (holdTaps) out.holdTaps = holdTaps
  if (sensorBindings) {
    out.sensorBindings = sensorBindings.map(row => row.map(normalizeRgbLayerBinding))
  }
  if (keymap.rgbLayerRecipe === true) out.rgbLayerRecipe = true
  else if (keymap.rgbLayerRecipe === false) out.rgbLayerRecipe = false
  return out
}

/**
 * Ensure `layer_names` is present (default `Layer N` per layer) and stringified.
 * Call at the keyboard-accept boundary; do not invent names in UI pickers.
 */
export function normalizeParsedKeymap(km: ParsedKeymap): ParsedKeymap {
  const layer_names = (
    km.layer_names ?? km.layers.map((_, i) => `Layer ${i}`)
  ).map(String)
  return { ...km, layer_names }
}

/** JSON `string[][]` or already-parsed nodes. Undefined when the field is absent. */
function normalizeSensorBindings(raw: unknown): KeyBindingNode[][] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.map(layer => {
    if (!Array.isArray(layer)) return []
    return layer.map(item => parseBindingInput(item, 'sensorBindings'))
  })
}

function renderTemplate(
  template: string,
  params: {
    layout: LayoutKey[]
    behaviourHeaders: string[]
    layers: string[][]
    layerNames: string[]
  }
): string {
  const columnWidths = bindingColumnWidths(params.layout, params.layers, {
    columnSeparator: ' '
  })

  const usedNames = new Set<string>()
  const renderedLayers = params.layers.map((layer, i) => {
    const raw = i === 0 ? 'default_layer' : `layer_${params.layerNames[i] || i}`
    const stem = raw.replace(/[^a-zA-Z0-9_]/g, '_')
    const name = uniqueDtsNodeId(stem, usedNames)
    const rendered = renderTable(params.layout, layer, {
      linePrefix: '',
      columnSeparator: ' ',
      columnWidths
    })

    return `
        ${name} {
            bindings = <
${rendered}
            >;
        };
`
  })

  return template
    .replace(INCLUDES_PATTERN, () => params.behaviourHeaders.join('\n'))
    .replace(LAYERS_PATTERN, () => renderedLayers.join(''))
}

function generateKeymapCode(
  layout: LayoutKey[],
  keymap: ParsedKeymap,
  encoded: EncodedKeymap,
  template: string
): string {
  const names = keymap.layer_names ?? []
  const used = getBehavioursUsed(keymap)
  const behaviourHeaders = [
    ...new Set([
      ...used.flatMap(bind => behavioursByBind[bind]?.includes ?? []),
      ...(shouldEnsureRgbLayerRecipe(keymap) || used.includes(RGB_LAYER_RECIPE.code)
        ? [...RGB_LAYER_RECIPE.includes]
        : [])
    ])
  ]

  return renderTemplate(template, {
    layout,
    behaviourHeaders,
    layers: encoded.layers,
    layerNames: names
  })
}

function generateKeymapJSON(layout: LayoutKey[], encoded: EncodedKeymap): string {
  const layers = encoded.layers
  const columnWidths = bindingColumnWidths(layout, layers, { useQuotes: true })
  const base = JSON.stringify({ ...encoded, layers: null }, null, 2)
  const rendered = layers.map(layer => {
    const body = renderTable(layout, layer, {
      useQuotes: true,
      linePrefix: '      ',
      columnWidths
    })
    return `[\n${body}\n    ]`
  })

  return base.replace(
    '"layers": null',
    () => `"layers": [\n    ${rendered.join(', ')}\n  ]`
  )
}

export function generateKeymap(
  layout: LayoutKey[],
  keymap: ParsedKeymap,
  template?: string
): { code: string; json: string } {
  const encoded = encodeKeymap(keymap)
  return {
    code: generateKeymapCode(layout, keymap, encoded, template || keymapTemplate),
    json: generateKeymapJSON(layout, encoded)
  }
}

/**
 * Prefer an explicit template, else splice into originalSource, else the default
 * generated template. Always validates layer key counts first.
 *
 * Template / default_template name layer nodes as `default_layer` (index 0) or
 * `layer_${name}` from `layer_names` (sanitized, then `_2`/`_3` if that id is
 * taken); splice keeps existing DTS node ids by index and does not rename them
 * from UI names (ADR 0002). New spliced nodes use `layer_${index}` or `_2`/`_3`.
 *
 * Optional model fields on every save path (`applyModelBlocks`):
 *
 * | Field | Absent (`undefined`) | Present empty (`[]`) | Present non-empty |
 * |-------|----------------------|----------------------|-------------------|
 * | `combos` | Leave existing `combos` block alone | Remove the block | Rewrite / insert block |
 * | `conditionalLayers` | Leave alone | Remove the node | Rewrite / insert |
 * | `holdTaps` | Leave alone | (timing cleared per list) | Rewrite / insert |
 * | `sensorBindings` | Leave alone | Clear per-layer props as listed | Rewrite per layer |
 * | `rgbLayerRecipe` | Insert node only if a binding uses `&rgblayer` | — | `true` ensures the fixed macro node |
 *
 * DTS parse omits `combos` when there is no block, or when a block is not
 * fully parsed (`combos_unparsed`: skipped node, DTS label, or non-numeric
 * token). The same omit+warn rule applies to `conditionalLayers`
 * (`conditional_layers_unparsed`) and `holdTaps` (`hold_tap_timing_unparsed`).
 * UI clear-all must set `combos: []` explicitly so Save can drop the block.
 * On the splice path, combos / conditional layers / hold-taps stay
 * byte-identical when fingerprints match a reparse of `originalSource`.
 */
export function buildKeymapCode(
  layout: LayoutKey[],
  keymap: ParsedKeymap,
  options?: { template?: string; originalSource?: string }
): BuildKeymapCodeResult {
  const encoded = encodeKeymap(keymap)
  const layers = encoded.layers
  assertLayerKeyCounts(layout, layers)

  const warnings: string[] = []
  const template = options?.template
  const originalSource = options?.originalSource

  if (typeof template === 'string' && template.length > 0) {
    return {
      code: applyModelBlocks(
        generateKeymapCode(layout, keymap, encoded, template),
        keymap
      ),
      json: generateKeymapJSON(layout, encoded),
      mode: 'template',
      warnings
    }
  }

  if (typeof originalSource === 'string' && originalSource.length > 0) {
    const compiled = compileMacros(parseDefines(originalSource))
    const regionsText = keymapBindingsText(originalSource)
    if (regionsText && macrosAppearInText(regionsText, compiled)) {
      warnings.push('macros_expanded')
    }
    const spliced = spliceBindingsIntoDts(originalSource, {
      layout,
      layers
    })
    return {
      code: applyModelBlocks(spliced, keymap, parseOriginalModel(originalSource)),
      json: generateKeymapJSON(layout, encoded),
      mode: 'splice',
      warnings
    }
  }

  warnings.push('generated_default_template')
  return {
    code: applyModelBlocks(
      generateKeymapCode(layout, keymap, encoded, keymapTemplate),
      keymap
    ),
    json: generateKeymapJSON(layout, encoded),
    mode: 'default_template',
    warnings
  }
}

function parseOriginalModel(source: string): ParsedKeymap | undefined {
  try {
    return parseKeymap(parseDtsKeymap(source))
  } catch {
    return undefined
  }
}

function fingerprintsMatch<T>(
  draft: T[],
  original: T[] | undefined,
  encode: (item: T) => string
): boolean {
  if (original === undefined || draft.length !== original.length) return false
  for (let i = 0; i < draft.length; i++) {
    if (encode(draft[i]!) !== encode(original[i]!)) return false
  }
  return true
}

function comboFingerprint(combo: ZmkCombo): string {
  return `${combo.id}\n${encodeComboFingerprint(combo)}`
}

function conditionalLayerFingerprint(rule: ZmkConditionalLayer): string {
  return `${rule.id}\n${encodeConditionalLayerFingerprint(rule)}`
}

function holdTapFingerprint(node: ZmkHoldTap): string {
  return `${node.code}\n${encodeHoldTapFingerprint(node)}`
}

/** Sensors → combos → conditional layers → hold-taps → RGB layer recipe. */
function applyModelBlocks(
  code: string,
  keymap: ParsedKeymap,
  original?: ParsedKeymap
): string {
  return applyRgbLayerRecipe(
    applyHoldTaps(
      applyConditionalLayers(
        applyCombos(applySensorBindings(code, keymap), keymap, original),
        keymap,
        original
      ),
      keymap,
      original
    ),
    keymap
  )
}

function applyRgbLayerRecipe(code: string, keymap: ParsedKeymap): string {
  if (!shouldEnsureRgbLayerRecipe(keymap)) return code
  return spliceRgbLayerRecipeIntoDts(code)
}

function applySensorBindings(code: string, keymap: ParsedKeymap): string {
  if (keymap.sensorBindings === undefined) return code
  const block = findZmkKeymapBlock(code)
  if (!block) return code
  const nodes = findKeymapLayerNodes(code, block)
  const encoded = keymap.sensorBindings.map(layer => layer.map(encodeKeyBinding))
  // Pad or truncate to the layer-node count so every layer is rewritten.
  while (encoded.length < nodes.length) encoded.push([])
  if (encoded.length > nodes.length) encoded.length = nodes.length
  return spliceSensorBindingsIntoDts(code, nodes, encoded)
}

/** Rewrite combos from the model when present (including empty → drop block). */
function applyCombos(
  code: string,
  keymap: ParsedKeymap,
  original?: ParsedKeymap
): string {
  if (keymap.combos === undefined) return code
  if (fingerprintsMatch(keymap.combos, original?.combos, comboFingerprint)) {
    return code
  }
  return spliceCombosIntoDts(code, keymap.combos.map(encodeComboToJson))
}

function applyConditionalLayers(
  code: string,
  keymap: ParsedKeymap,
  original?: ParsedKeymap
): string {
  if (keymap.conditionalLayers === undefined) return code
  if (
    fingerprintsMatch(
      keymap.conditionalLayers,
      original?.conditionalLayers,
      conditionalLayerFingerprint
    )
  ) {
    return code
  }
  return spliceConditionalLayersIntoDts(code, keymap.conditionalLayers)
}

function applyHoldTaps(
  code: string,
  keymap: ParsedKeymap,
  original?: ParsedKeymap
): string {
  if (keymap.holdTaps === undefined) return code
  if (fingerprintsMatch(keymap.holdTaps, original?.holdTaps, holdTapFingerprint)) {
    return code
  }
  return spliceHoldTapsIntoDts(code, keymap.holdTaps)
}

/**
 * Validate JSON against the catalog by default. Source imports may preserve
 * external behavior references; this does not discover their schema or includes.
 */
export function validateKeymapJson(
  keymap: unknown,
  options: { allowUnknownBehaviors?: boolean } = {}
): void {
  const errors: string[] = []

  if (typeof keymap !== 'object' || keymap === null) {
    errors.push('keymap.json root must be an object')
  } else {
    const km = keymap as {
      layers?: unknown
      holdTaps?: Array<{ code?: unknown; override?: unknown }>
      rgbLayerRecipe?: unknown
    }
    const extraBehaviours = new Set(
      (Array.isArray(km.holdTaps) ? km.holdTaps : [])
        .filter(row => row && row.override !== true && typeof row.code === 'string')
        .map(row => String(row.code))
    )
    if (km.rgbLayerRecipe === true) {
      extraBehaviours.add(RGB_LAYER_RECIPE.code)
    }
    if (!Array.isArray(km.layers)) {
      errors.push('keymap must include "layers" array')
    } else {
      for (let i = 0; i < km.layers.length; i++) {
        const layer = km.layers[i]
        if (!Array.isArray(layer)) {
          errors.push(`Layer at layers[${i}] must be an array`)
        } else {
          for (let j = 0; j < layer.length; j++) {
            const key = layer[j]
            const keyPath = `layers[${i}][${j}]`
            if (typeof key !== 'string') {
              errors.push(`Value at "${keyPath}" must be a string`)
            } else {
              const bind = key.match(/^&[a-zA-Z_][a-zA-Z0-9_]*(?=\s|$)/)
              if (!(
                bind && (
                  options.allowUnknownBehaviors === true ||
                  Object.hasOwn(behavioursByBind, bind[0]) ||
                  extraBehaviours.has(bind[0])
                )
              )) {
                errors.push(`Key bind at "${keyPath}" has invalid behaviour`)
              }
            }
          }
        }
      }
    }
  }

  if (errors.length) {
    throw new KeymapValidationError(errors)
  }
}

/**
 * True when keymap.json is non-empty and passes validateKeymapJson.
 * Empty shells (`[]`, `[[]]`) and invalid binds are not primary — callers fall back to .keymap.
 */
export function isPrimaryKeymapJson(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const layers = (value as { layers?: unknown }).layers
  if (!Array.isArray(layers) || layers.length === 0) return false
  if (!layers.some(layer => Array.isArray(layer) && layer.length > 0)) return false
  try {
    validateKeymapJson(value)
    return true
  } catch (err) {
    if (err instanceof KeymapValidationError) return false
    throw err
  }
}

/** User `.keymap` only — excludes `*.keymap.template` (case-insensitive). */
export function isUserKeymapFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.keymap') && !lower.endsWith('.keymap.template')
}

function cloneBehaviorDef(def: BehaviorDef): BehaviorDef {
  return {
    ...def,
    includes: def.includes ? [...def.includes] : undefined,
    params: def.params ? [...def.params] : undefined,
    commands: def.commands?.map(command => ({
      ...command,
      additionalParams: command.additionalParams
        ? [...command.additionalParams]
        : undefined
    }))
  }
}

export function loadBehaviorsData(): BehaviorDef[] {
  return behaviours.map(cloneBehaviorDef)
}
