/**
 * Shared editor document state (Svelte 5 runes).
 * Baseline (last load / successful publish+reload) vs draft (live edits).
 *
 * Domain logic lives in sibling modules; this file holds reactive state and
 * a thin façade that exposes the public `editor` singleton.
 */

import {
  buildHostKeymapSnapshot,
  diffKeymaps,
  encodeHostKeymapSnapshot,
  getBehaviorCatalog,
  getKeycodeCatalog,
  resetHostLayoutRegistry,
  standardHostLegendView,
  standardLayerView,
  symbolAlign,
  type HostLegendView,
  type LayerView,
  type LegendHover,
  type LayoutKey,
  type ParsedKeymap,
  type SymbolAlign,
  type ZmkHoldTap
} from '@keymap-editor/keymap-core'
import type { Definitions } from '../context'
import type { StoredHostAssembly, UserHostLayout } from '../host-layout-store'
import { assignEditorApi, GETTER_NAMES, type BoundMixin } from './assign-api'
import { hostLegendAnchorIndex, legendHoversEqual } from './helpers'
import * as demoHost from './demo-host'
import * as documentApi from './document.svelte'
import * as hostEditUi from './host-edit-ui.svelte'
import * as hostLegendApi from './host-legend.svelte'
import * as hostRepo from './host-repo'
import * as persistDraft from './persist-draft'
import * as publishBridge from './publish-bridge'
import * as selectKeyboardApi from './select-keyboard'
import type {
  GithubMeta,
  HostProfilePrompt,
  HostSymbolEditTarget,
  KeyboardSelectionSource,
  SaveNotice,
  UnicodeServiceConfirm
} from './types'

export interface EditorState
  extends BoundMixin<typeof documentApi>,
    BoundMixin<typeof persistDraft>,
    BoundMixin<typeof selectKeyboardApi>,
    BoundMixin<typeof publishBridge>,
    BoundMixin<typeof hostLegendApi>,
    BoundMixin<typeof hostRepo>,
    BoundMixin<typeof hostEditUi>,
    BoundMixin<typeof demoHost> {}

export type {
  ClipboardKeyboardSelection,
  DemoKeyboardSelection,
  GithubKeyboardSelection,
  GithubMeta,
  HostKeyLevelEditResult,
  HostProfilePrompt,
  HostSymbolEditTarget,
  KeyboardSelection,
  KeyboardSelectionSource,
  KeymapPickerPayload,
  LocalKeyboardSelection,
  SaveNotice,
  UnicodeServiceConfirm
} from './types'
export { hostLegendAnchorIndex } from './helpers'

export class EditorState {
  definitions = $state<Definitions | null>(null)
  source = $state<KeyboardSelectionSource | null>(null)
  githubMeta = $state<GithubMeta | null>(null)
  /** Pasted `.keymap` kept for clipboard splice / Copy. */
  clipboardOriginalSource = $state<string | null>(null)
  layout = $state<LayoutKey[] | null>(null)
  /**
   * Layout as last loaded. Scheme-mode `promoteAbsentKey` mutates `layout` only;
   * Discard restores this baseline. Not part of undo/redo.
   */
  baselineLayout = $state<LayoutKey[] | null>(null)
  /** Last loaded / successfully published+reloaded keymap. */
  baselineKeymap = $state.raw<ParsedKeymap | null>(null)
  /** Live editor document; always set after load. */
  draftKeymap = $state.raw<ParsedKeymap | null>(null)
  /** ZMK draft snapshots for step undo (not host edits; not vs baseline). */
  undoStack = $state.raw<ParsedKeymap[]>([])
  /**
   * Hold-tap list staged by the key dialog. The next keymap update absorbs it
   * so Apply writes the new node and the key in one step. Cancel never sets it.
   */
  _holdTapsOnNextUpdate: ZmkHoldTap[] | null = null
  /** When true, the next keymap update sets `rgbLayerRecipe` so Save inserts the node. */
  _rgbLayerRecipeOnNextUpdate: boolean | null = null
  redoStack = $state.raw<ParsedKeymap[]>([])
  saving = $state(false)
  /** View over the host profile. It does not edit the keymap. */
  _hostLegend = $state<HostLegendView>(standardHostLegendView())
  get hostLegend(): HostLegendView {
    return this._hostLegend
  }
  set hostLegend(view: HostLegendView) {
    this._hostLegend = view
    // Stack needs three columns; drop the preference when the board no longer qualifies.
    if (view.columns.length < 3) this.multilangView = false
  }
  /** Column sets remembered for this keyboard. Each one points at layouts. */
  hostAssemblies = $state<StoredHostAssembly[]>([])
  /**
   * Bumps when a user layout is registered/replaced in the core registry.
   * The registry is not reactive; board compose reads this so keycaps repaint.
   */
  hostLayoutRevision = $state(0)
  /**
   * Deliverable fingerprint (`layoutIds|revision`) captured by the last
   * Linux/Windows export via `markHostDelivered`. Host is dirty while
   * deliverable user layouts exist and the live fingerprint differs.
   */
  hostDeliveredFingerprint = $state('')
  /**
   * Session toggle. On underlines a symbol that sits on a different key and
   * outlines AltGr cells the combined Windows file cannot keep. Not stored
   * with the legend view.
   */
  symbolAlignOn = $state(true)
  /**
   * Session toggle. Stacks every host language on the key and hides other
   * firmware layers. Needs at least three host columns (`multilangViewOn`).
   * Not stored with the legend view or the layer view.
   */
  multilangView = $state(false)
  /**
   * Session toggle. Soft wash tint per firmware layer on the keycap and in the
   * legend table. Off by default; not stored with the legend view.
   */
  layerTonesOn = $state(false)
  /** Full matrix + layout row/col rails on the board. Session-only; not stored. */
  schemeMode = $state(false)
  /**
   * Session mode: list/edit ZMK combos and pick `key-positions` on the board.
   * Not stored with the keymap draft identity.
   */
  comboMode = $state(false)
  /** Selected combo id while `comboMode` is on. */
  activeComboId = $state<string | null>(null)
  /** Short hint while editing combos (key count or a shared chord). */
  comboNotice = $state<string | null>(null)

  /** Which firmware layers are drawn on the keycap. */
  layerView = $state<LayerView>(standardLayerView())
  userLayouts = $state<UserHostLayout[]>([])
  hostProfilePrompt = $state<HostProfilePrompt | null>(null)
  hostProfileNote = $state<string | null>(null)
  legendHover = $state<LegendHover | null>(null)
  /** Sample key for the host-legend table; scanned once per draft, not per key. */
  legendAnchorIndex = $derived(hostLegendAnchorIndex(this.draftKeymap))
  /** Persistent host-symbol catalog (docked, not per-cell popover). */
  hostSymbolCatalogOpen = $state(false)
  hostSymbolEditTarget = $state<HostSymbolEditTarget | null>(null)
  /**
   * Alt+click host-edit session on a composed row. Instant writes still go through
   * setHostKeyLevel; this only locks the decode card until Accept/Cancel.
   */
  hostEditSession = $state<{ keyIndex: number; layer: number } | null>(null)
  unicodeServiceConfirm = $state<UnicodeServiceConfirm | null>(null)
  saveNotice = $state<SaveNotice | null>(null)

  /** Bumps on select / new publish so stale reloads are ignored. */
  _publishGeneration = 0
  /** Bumps on select so stale IDB restore prompts are ignored. */
  _selectGeneration = 0
  /** Bumps to cancel in-flight / debounced IDB writes. */
  _persistGeneration = 0
  _persistTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Identity we already offered Restore/Discard for this session.
   * Prevents picker effect re-entry from wiping a restored draft.
   */
  _handledDraftIdentityKey: string | null = null
  /**
   * Encoded `host_keymap/snapshot.json` last loaded from or committed to the
   * GitHub repo. Null when this session has no repo host baseline yet.
   */
  _hostRepoBaselineEncoded = $state<string | null>(null)
  /**
   * True when Commit must leave `host_keymap/snapshot.json` untouched
   * (repo snapshot is a newer schema).
   */
  _omitHostKeymapSnapshotOnCommit = false

  _changes = $derived.by(() => {
    if (!this.baselineKeymap || !this.draftKeymap) return []
    return diffKeymaps(this.baselineKeymap, this.draftKeymap)
  })

  /** Host half differs from the last GitHub load/commit (ADR 0005). */
  isHostRepoDirty = $derived.by(() => {
    if (this.source !== 'github') return false
    if (this._omitHostKeymapSnapshotOnCommit) return false
    const live = this._encodeLiveHostSnapshot()
    if (this._hostRepoBaselineEncoded === null) {
      return (
        live !==
        encodeHostKeymapSnapshot(buildHostKeymapSnapshot(standardHostLegendView(), []))
      )
    }
    return live !== this._hostRepoBaselineEncoded
  })

  /** Null when the toggle is off or fewer than two languages are on the key. */
  symbolAlignIndex = $derived.by((): SymbolAlign | null => {
    void this.hostLayoutRevision
    if (!this.symbolAlignOn) return null
    const pair = this._alignInputs()
    if (!pair) return null
    return symbolAlign(pair.left, pair.right, { winMerge: pair.winMerge })
  })

  /** Encoded binding before the unpublished edit, keyed by `keyIndex:layer`. */
  unpublishedBefore = $derived.by(() => {
    const map = new Map<string, string>()
    for (const change of this._changes) {
      if (change.type === 'binding') map.set(`${change.index}:${change.layer}`, change.before)
    }
    return map
  })

  setLegendHover(hover: LegendHover | null) {
    if (legendHoversEqual(this.legendHover, hover)) return
    this.legendHover = hover
  }

  initCatalogs() {
    this.definitions = {
      keycodes: getKeycodeCatalog(),
      behaviours: getBehaviorCatalog()
    }
  }

  /**
   * Drop the loaded keymap session (document, modes, host-edit UI).
   * Host layout profiles stay in the browser. Shared with `resetForTests`.
   */
  reset() {
    this._cancelPersistTimer()
    this._persistGeneration += 1
    this._selectGeneration += 1
    this._publishGeneration += 1
    this._hostRepoBaselineEncoded = null
    this._omitHostKeymapSnapshotOnCommit = false
    this._handledDraftIdentityKey = null
    this.endHostEditSession()
    this.legendHover = null
    this.source = null
    this.githubMeta = null
    this.clipboardOriginalSource = null
    this.layout = null
    this.baselineLayout = null
    this.baselineKeymap = null
    this.draftKeymap = null
    this.clearHistory()
    this.saving = false
    this.schemeMode = false
    this.comboMode = false
    this.activeComboId = null
    this.comboNotice = null
    this.saveNotice = null
  }

  /** Drop the loaded keymap after GitHub logout. Host layouts stay in the browser. */
  clearLoadedKeymap() {
    this.reset()
  }

  /** Reset singleton between vitest cases (no-op outside test/dev). */
  resetForTests() {
    if (import.meta.env.MODE !== 'test' && !import.meta.env.DEV) return
    this.reset()
    this._holdTapsOnNextUpdate = null
    this._rgbLayerRecipeOnNextUpdate = null
    this.definitions = null
    resetHostLayoutRegistry()
    this.hostLegend = standardHostLegendView()
    this.hostAssemblies = []
    this.hostLayoutRevision = 0
    this.hostDeliveredFingerprint = ''
    this.symbolAlignOn = true
    this.multilangView = false
    this.layerTonesOn = false
    this.layerView = standardLayerView()
    this.userLayouts = []
    this.hostProfilePrompt = null
    this.hostProfileNote = null
  }
}

for (const mod of [
  documentApi,
  persistDraft,
  selectKeyboardApi,
  publishBridge,
  hostLegendApi,
  hostRepo,
  hostEditUi,
  demoHost
]) {
  assignEditorApi(EditorState.prototype, mod as Record<string, unknown>, GETTER_NAMES)
}

export const editor = new EditorState()
