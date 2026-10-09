import aliasesData from '../data/zmk-unicode-aliases.json' with { type: 'json' }
import type { KeyBindingNode } from './types.js'
import { scanDts } from './dts-scan.js'
import { dominantEol } from './eol.js'

export const UNICODE_DOCS_URL = 'https://github.com/urob/zmk-unicode'
export const UNICODE_INCLUDE = '#include <behaviors/unicode.dtsi>'

/** Keep existing header spelling and all other preamble text; add only if needed. */
export function ensureUnicodeInclude(source: string): string {
  const { masked } = scanDts(source)
  const includes = /^[ \t]*#[ \t]*include[ \t]*[<"]behaviors\/unicode\.dtsi[>"]/gm
  for (const match of source.matchAll(includes)) {
    if (masked[source.indexOf('#', match.index)] === '#') return source
  }
  const bodyStart = masked.search(/(?:\/|&[a-zA-Z_]\w*)\s*\{/)
  const insertAt = bodyStart < 0 ? source.length : bodyStart
  const before = source.slice(0, insertAt)
  const eol = dominantEol(source)
  const separator = before && !before.endsWith('\n') ? eol : ''
  return before + separator + UNICODE_INCLUDE + eol + source.slice(insertAt)
}

export const UNICODE_ALIASES = Object.freeze(
  aliasesData.aliases.map(row => Object.freeze({ ...row }))
)

export const UNICODE_MODES = Object.freeze([
  { code: 'UC_SET_MACOS', value: 0, name: 'macOS', setup: 'Enable and select Unicode Hex Input on macOS.' },
  { code: 'UC_SET_LINUX', value: 1, name: 'Linux (IBus)', setup: 'Use an IBus-enabled desktop; GTK applications may also support this input.' },
  { code: 'UC_SET_LINUX_ALT', value: 2, name: 'Linux (alternative)', setup: 'Try this Ctrl+Shift input variant when the standard Linux mode does not work.' },
  { code: 'UC_SET_WIN_COMPOSE', value: 3, name: 'Windows (WinCompose)', setup: 'Install and run WinCompose. Recommended for Windows; supports all code points.' },
  { code: 'UC_SET_WIN_ALT', value: 4, name: 'Windows (HexNumpad)', setup: 'Requires EnableHexNumpad on Windows; limited to U+FFFF and not recommended upstream.' },
  { code: 'UC_SET_EMACS', value: 5, name: 'Emacs', setup: 'Uses the Emacs insert-char command.' }
].map(mode => Object.freeze(mode)))

/** Unicode scalar input, not a grapheme/string sequence. Zero is the module sentinel. */
export function unicodeCodePoint(input: string | number): number | null {
  let value: number
  if (typeof input === 'number') value = input
  else {
    const text = input.trim()
    if (/^(?:U\+|0x)[0-9a-f]+$/i.test(text)) value = Number.parseInt(text.slice(2), 16)
    else if (/^\d+$/.test(text)) value = Number(text)
    else if ([...text].length === 1) value = text.codePointAt(0)!
    else return null
  }
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff) ? value : null
}

export function unicodeCodePointLabel(value: number): string {
  return `U+${value.toString(16).toUpperCase().padStart(4, '0')}`
}

export function unicodeGlyph(value: number): string {
  if (unicodeCodePoint(value) == null) return unicodeCodePointLabel(value)
  // Invisible/control characters need an honest visible preview.
  const glyph = String.fromCodePoint(value)
  return /[\p{C}\p{Z}]/u.test(glyph) ? unicodeCodePointLabel(value) : glyph
}

function node(params: Array<string | number>): KeyBindingNode {
  return { value: '&uc', params: params.map(value => ({ value, params: [] })) }
}

export function unicodeBinding(normal: string | number, shift: string | number): KeyBindingNode {
  const cp = unicodeCodePoint(normal)
  const shifted = unicodeCodePoint(shift)
  if (cp == null || shifted == null) throw new Error('Enter one Unicode scalar or a code point from U+0000 to U+10FFFF (excluding surrogates).')
  const token = (value: number) => value === 0 ? '0' : `0x${value.toString(16).toUpperCase()}`
  return node([token(cp), token(shifted)])
}

export function unicodeAliasBinding(code: string): KeyBindingNode {
  if (!UNICODE_ALIASES.some(alias => alias.code === code)) throw new Error('Unknown Unicode alias')
  return node([code])
}

export function unicodeModeBinding(code: string): KeyBindingNode {
  if (!UNICODE_MODES.some(mode => mode.code === code)) throw new Error('Unknown Unicode input mode')
  return node([code])
}

export type UnicodeBindingState =
  | { kind: 'codepoints'; normal: number; shift: number }
  | { kind: 'mode'; mode: string }

/** Decode known aliases and expanded cells without rewriting the source tokens. */
export function unicodeBindingState(binding: KeyBindingNode): UnicodeBindingState | null {
  if (binding.value !== '&uc' || binding.params.some(param => param.params.length > 0)) return null
  const [first, second] = binding.params
  if (!first) return null
  if (binding.params.length === 1) {
    const alias = UNICODE_ALIASES.find(row => row.code === first.value)
    if (alias) return { kind: 'codepoints', normal: alias.normal, shift: alias.shift }
    const mode = UNICODE_MODES.find(row => row.code === first.value)
    return mode ? { kind: 'mode', mode: mode.code } : null
  }
  if (binding.params.length !== 2 || !second) return null
  const modeIndex = /^UC_MODE_/.test(String(second.value))
    ? UNICODE_MODES.find(row => row.code.replace('UC_SET_', 'UC_MODE_') === second.value)?.value
    : unicodeCodePoint(second.value)
  if (first.value === 'UC_SELECT_INPUT_MODE' || Number(first.value) === 0xffffff) {
    const mode = UNICODE_MODES.find(row => row.value === modeIndex)
    return mode ? { kind: 'mode', mode: mode.code } : null
  }
  const normal = unicodeCodePoint(first.value)
  const shift = unicodeCodePoint(second.value)
  return normal != null && shift != null ? { kind: 'codepoints', normal, shift } : null
}
