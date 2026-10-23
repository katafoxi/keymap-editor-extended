import type { KeysymRejection, HostKeymapSnapshot, LayoutKey, ParsedKeymap } from '@keymap-editor/keymap-core'
import type { DemoHostLayoutSeed } from '../demo/host-seeds.js'
import type { HostLanguageId } from '../host-layout-store'

export type HostSnapshotLoadError = 'unsupported_version' | 'invalid'

export type HostProfilePrompt =
  | { kind: 'save-as'; language: HostLanguageId }
  | { kind: 'copy'; language: HostLanguageId; layoutId?: string }
  | { kind: 'rename'; language: HostLanguageId; profileId?: string }
  | { kind: 'delete'; language: HostLanguageId; profileId?: string }

/** Armed host-level cell that receives glyphs from the persistent symbol catalog. */
export type HostSymbolEditTarget = {
  language: HostLanguageId
  zmk: string
  level: number
}

/** Result of editing one host-layout level from the decode card. */
export type HostKeyLevelEditResult =
  | {
      ok: true
      keysym: string
      layoutId: string
      /** Base level is a non-character keysym — the key drops out of composition. */
      dropsFromCompose: boolean
    }
  | {
      ok: false
      reason: 'rejected' | 'unknown-key' | 'missing-layout' | 'no-target' | 'unicode-service-key'
      detail?: KeysymRejection
    }

/** Host edit held back because the keymap's `&uc` keys need this cell unchanged. */
export type UnicodeServiceConfirm = HostSymbolEditTarget & {
  text: string
  /** Unshifted character the `&uc` service sequence types on this key. */
  required: string
}

export type SaveNotice = {
  kind: 'warning' | 'error'
  messages: string[]
  /** Optional help links for load/save warnings (e.g. Shield Wizard). */
  links?: Array<{ href: string; label: string }>
}

export type GithubMeta = { repository: string; branch: string; headSha?: string }

/** Shared board payload present on every keymap-selection source. */
type KeyboardSelectionBase = {
  layout?: LayoutKey[] | null
  keymap?: ParsedKeymap | null
  warnings?: string[]
  /** True when the user chose this load (picker action), not an automatic mount/effect. */
  userInitiated?: boolean
}

export type DemoKeyboardSelection = KeyboardSelectionBase & {
  source: 'demo'
  demo?: { id: string; name: string }
  /** Demo-only host layouts to open when the legend is still English-only. */
  demoHost?: DemoHostLayoutSeed[]
}

export type ClipboardKeyboardSelection = KeyboardSelectionBase & {
  source: 'clipboard'
  /** Pasted `.keymap` text for clipboard Copy (splice). */
  clipboardOriginalSource?: string | null
  clipboardInferredLayout?: boolean
}

export type GithubKeyboardSelection = KeyboardSelectionBase & {
  source: 'github'
  github: GithubMeta
  /**
   * Keep the live draft and Host legend when retargeting the same GitHub repo
   * (Create branch ≈ `git checkout -b`). Baseline becomes the loaded tip.
   */
  preserveSession?: boolean
  /**
   * Host snapshot from `host_keymap/snapshot.json` (GitHub). When present it
   * wins over IndexedDB for this keymap identity.
   */
  hostSnapshot?: HostKeymapSnapshot | null
  /** Repo snapshot was present but not applied (`unsupported_version` / `invalid`). */
  hostSnapshotError?: HostSnapshotLoadError
}

export type LocalKeyboardSelection = KeyboardSelectionBase & {
  source: 'local'
}

/** Keymap load/selection event stamped by source (Demo / Clipboard / GitHub / Local). */
export type KeyboardSelection =
  | DemoKeyboardSelection
  | ClipboardKeyboardSelection
  | GithubKeyboardSelection
  | LocalKeyboardSelection

export type KeyboardSelectionSource = KeyboardSelection['source']

/**
 * Payload from a source picker before KeyboardPicker stamps `source` from the
 * live chip (GitHub/Local often omit `source`; Demo/Clipboard include it).
 */
export type KeymapPickerPayload =
  | DemoKeyboardSelection
  | ClipboardKeyboardSelection
  | (Omit<GithubKeyboardSelection, 'source'> & { source?: 'github' })
  | (Omit<LocalKeyboardSelection, 'source'> & { source?: 'local' })

/** Max draft snapshots kept for undo / redo. */
export const HISTORY_LIMIT = 50

/** Debounce for IndexedDB draft writes. */
export const PERSIST_DEBOUNCE_MS = 400
