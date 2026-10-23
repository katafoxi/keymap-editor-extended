import {
  glyphToKeysym,
  keysymToGlyph,
  unicodeBindingCount,
  unicodeServiceCharacter
} from '@keymap-editor/keymap-core'
import { defaultHostEditTarget, stepHostEditTarget } from '../host-edit-cycle'
import type { EditorState } from './state.svelte'
import type { HostKeyLevelEditResult, HostSymbolEditTarget } from './types'

export function armHostSymbolEdit(this: EditorState, target: HostSymbolEditTarget) {
  this.unicodeServiceConfirm = null
  this.hostSymbolEditTarget = target
  this.hostSymbolCatalogOpen = true
}

/**
 * Start an Alt+click host-edit session. When `zmk` is known, arm the first
 * AltGr cycle cell (extras before base) so the catalog is ready to write.
 */
export function beginHostEditSession(this: EditorState, keyIndex: number, layer: number, zmk?: string) {
  this.unicodeServiceConfirm = null
  this.hostEditSession = { keyIndex, layer }
  this.hostSymbolCatalogOpen = true
  if (zmk) {
    const target = defaultHostEditTarget(zmk, this.hostLegend)
    this.hostSymbolEditTarget = target
  } else {
    this.hostSymbolEditTarget = null
  }
}

/** Close catalog + clear armed cell; caller unpins the decode card. */
export function endHostEditSession(this: EditorState) {
  this.hostEditSession = null
  this.hostSymbolEditTarget = null
  this.hostSymbolCatalogOpen = false
  this.unicodeServiceConfirm = null
}

export function closeHostSymbolCatalog(this: EditorState) {
  this.hostSymbolCatalogOpen = false
}

/** Move the armed cell along the AltGr cycle without writing. */
export function stepHostSymbolEdit(this: EditorState, delta: number) {
  const target = this.hostSymbolEditTarget
  if (!target || delta === 0) return
  this.unicodeServiceConfirm = null
  this.hostSymbolEditTarget = stepHostEditTarget(target, this.hostLegend, delta)
}

/** Draft bindings (layers, combos, sensors) that use `&uc`. */
export function unicodeKeyCount(this: EditorState): number {
  return this.draftKeymap ? unicodeBindingCount(this.draftKeymap) : 0
}

/**
 * Character the keymap's `&uc` keys need on this cell, when it applies:
 * the keymap uses `&uc`, the cell is the base (English) column's unshifted
 * level of a service key, and the cell is the one being armed.
 */
export function unicodeServiceRequirement(
  this: EditorState,
  target: HostSymbolEditTarget | null
): string | null {
  if (!target || this.unicodeKeyCount === 0) return null
  if (target.language !== this.hostLegend.columns[0]?.language) return null
  return unicodeServiceCharacter(target.zmk, target.level)
}

export async function pickHostSymbol(this: EditorState, text: string): Promise<HostKeyLevelEditResult> {
  const target = this.hostSymbolEditTarget
  if (!target) {
    return { ok: false, reason: 'no-target' }
  }
  this.unicodeServiceConfirm = null
  const required = this.unicodeServiceRequirement(target)
  if (required) {
    const parsed = glyphToKeysym(text)
    if (parsed.ok && keysymToGlyph(parsed.keysym) !== required) {
      this.unicodeServiceConfirm = { ...target, text, required }
      return { ok: false, reason: 'unicode-service-key' }
    }
  }
  return this._writeHostSymbol(target, text)
}

/** Write the held-back edit after the user accepts breaking `&uc` on that key. */
export async function confirmUnicodeServiceEdit(this: EditorState): Promise<HostKeyLevelEditResult> {
  const pending = this.unicodeServiceConfirm
  if (!pending) return { ok: false, reason: 'no-target' }
  this.unicodeServiceConfirm = null
  const target = { language: pending.language, zmk: pending.zmk, level: pending.level }
  return this._writeHostSymbol(target, pending.text)
}

export function dismissUnicodeServiceEdit(this: EditorState) {
  this.unicodeServiceConfirm = null
}

export async function _writeHostSymbol(
  this: EditorState,
  target: HostSymbolEditTarget,
  text: string
): Promise<HostKeyLevelEditResult> {
  const result = await this.setHostKeyLevel(
    target.language,
    target.zmk,
    target.level,
    text
  )
  if (result.ok) this.stepHostSymbolEdit(1)
  return result
}
