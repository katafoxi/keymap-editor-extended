import {
  autoshiftBindingParams,
  defaultRgbLayerBinding,
  encodeKeyBinding,
  getBehaviorCatalog,
  hsbBindingNode,
  isRgbLayerRecipeCode,
  rgbLayerRecipeBehaviorDef,
  type HsbColor,
  type KeyBindingNode
} from '@keymap-editor/keymap-core'
import type { SearchContextValue } from './context'
import {
  getBehaviourParams,
  hydrateTree,
  makeIndex,
  type HydratedNode
} from './hydrate'
import {
  applyModifierHold,
  applyTerminalKey,
  buildEditorSlots,
  isKeycodeParam,
  keycodeChainRootSlot,
  nextEditorSlot,
  terminalKeySlot
} from './key-editor'
import {
  cloneBindTree,
  toBindingNode,
  toKeyBinding
} from './binding-tree'
import { pick } from './utils'

export type KeyEditDraft = { value: string | number; paramsJson: string }

export type KeyEditSessionInput = {
  sources: () => Record<string, Record<string, unknown>>
  search: () => SearchContextValue | null | undefined
  bindings: () => KeyBindingNode[]
  layerIndex: () => number | undefined
  keyIndex: () => number
  onUpdate: (keyIndex: number, layerIndex: number, binding: KeyBindingNode) => void
}

/** Parse draft paramsJson; null means corrupt JSON (caller falls back / closes). */
function parseDraftParams(
  paramsJson: string
): Array<{ value?: string | number; params?: unknown[] }> | null {
  try {
    const parsed = JSON.parse(paramsJson) as unknown
    return Array.isArray(parsed)
      ? (parsed as Array<{ value?: string | number; params?: unknown[] }>)
      : []
  } catch {
    return null
  }
}

export function createKeyEditSession(input: KeyEditSessionInput) {
  let editing = $state<{ rowKey: string; slotCodeIndex: number } | null>(null)
  let draftByRow = $state<Record<string, KeyEditDraft>>({})

  const sources = $derived(input.sources())
  const search = $derived(input.search())
  const bindings = $derived(input.bindings())
  const canEdit = $derived(!!search)

  const fallbackBinding = $derived(
    bindings[input.layerIndex() ?? 0] ?? bindings[0] ?? { value: '&none', params: [] }
  )
  const normalized = $derived(
    hydrateTree(fallbackBinding.value, fallbackBinding.params ?? [], sources)
  )
  const activeDraft = $derived(editing ? draftByRow[editing.rowKey] : undefined)
  const working = $derived.by(() => {
    if (activeDraft == null) return normalized
    const params = parseDraftParams(activeDraft.paramsJson)
    if (params == null) return normalized
    return hydrateTree(activeDraft.value, params, sources)
  })
  const workingBehaviourParams = $derived(
    getBehaviourParams(working.params, lookupBehaviour(working.value) as never)
  )
  const slots = $derived(buildEditorSlots(working, workingBehaviourParams))
  const activeSlot = $derived(
    slots.find(slot => slot.codeIndex === editing?.slotCodeIndex) ??
      slots.find(slot => slot.param !== 'behaviour') ??
      slots[0]
  )
  const behaviourCode = $derived(String(slots[0]?.value ?? working.value ?? '&none'))
  const valueParam = $derived(
    activeSlot?.param != null && activeSlot.param !== 'behaviour'
      ? activeSlot.param
      : typeof workingBehaviourParams[0] === 'string'
        ? workingBehaviourParams[0]
        : undefined
  )
  const behaviours = $derived(
    (search?.getSearchTargets('behaviour', behaviourCode) ?? []) as Array<{
      code?: string | number
      name?: string
    }>
  )
  const choices = $derived(
    !search || valueParam == null || valueParam === 'behaviour'
      ? []
      : (search.getSearchTargets(valueParam, behaviourCode) as Array<{
          code?: string | number
          description?: string
          context?: string
          symbol?: string
        }>)
  )
  const bindingLabel = $derived(
    encodeKeyBinding({
      value: behaviourCode,
      params: (working.params ?? []).map(toBindingNode)
    })
  )

  function lookupBehaviour(code: string | number | undefined) {
    const key = String(code ?? '')
    return (sources.behaviours?.[key] ??
      getBehaviorCatalog().byCode[key] ??
      (isRgbLayerRecipeCode(key) ? rgbLayerRecipeBehaviorDef() : undefined)) as
      | Record<string, unknown>
      | undefined
  }

  function bindingForLayer(layer: number): KeyBindingNode {
    return bindings[layer] ?? fallbackBinding
  }

  function readDraft(): HydratedNode | null {
    if (!editing) return null
    const draft = draftByRow[editing.rowKey]
    if (!draft) return null
    const params = parseDraftParams(draft.paramsJson)
    if (params == null) {
      closeEditor()
      return null
    }
    return {
      value: draft.value,
      params: params as HydratedNode[]
    }
  }

  function setDraft(node: HydratedNode, preferIndex: number) {
    if (!editing) return
    const plain = cloneBindTree(node)
    const nextBehaviour = lookupBehaviour(plain.value)
    const nextParams = getBehaviourParams(plain.params, nextBehaviour as never)
    const hydrated = hydrateTree(plain.value ?? '&none', plain.params, sources)
    const nextSlots = buildEditorSlots(hydrated, nextParams)
    draftByRow = {
      ...draftByRow,
      [editing.rowKey]: {
        value: plain.value ?? '&none',
        paramsJson: JSON.stringify(plain.params ?? [])
      }
    }
    editing = { rowKey: editing.rowKey, slotCodeIndex: nextEditorSlot(nextSlots, preferIndex) }
  }

  function closeEditor() {
    if (editing) {
      const next = { ...draftByRow }
      delete next[editing.rowKey]
      draftByRow = next
    }
    editing = null
  }

  function firstEditSlot(node: KeyBindingNode): number {
    const hydrated = hydrateTree(node.value, node.params ?? [], sources)
    const nextBehaviour = lookupBehaviour(node.value)
    const nextParams = getBehaviourParams(hydrated.params, nextBehaviour as never)
    const nextSlots = buildEditorSlots(hydrated, nextParams)
    const firstValue = nextSlots.find(slot => slot.param !== 'behaviour')
    const terminal = terminalKeySlot(nextSlots, firstValue?.codeIndex ?? 1)
    return terminal?.codeIndex ?? firstValue?.codeIndex ?? 0
  }

  function openEditor(slotCodeIndex: number, fromLayer?: number) {
    if (!canEdit) return
    const editingLayer = editing ? Number(editing.rowKey) : undefined
    const targetLayer =
      fromLayer ??
      (editingLayer != null && Number.isFinite(editingLayer)
        ? editingLayer
        : input.layerIndex())
    if (targetLayer == null) return
    const rowKey = String(targetLayer)
    if (!draftByRow[rowKey]) {
      const source = bindingForLayer(targetLayer)
      const plain = cloneBindTree(hydrateTree(source.value, source.params ?? [], sources))
      draftByRow = {
        ...draftByRow,
        [rowKey]: {
          value: plain.value ?? '&none',
          paramsJson: JSON.stringify(plain.params ?? [])
        }
      }
    }
    editing = { rowKey, slotCodeIndex }
  }

  function emptyParamNodes(count: number): HydratedNode[] {
    return Array.from({ length: count }, () => ({ value: undefined, params: [] }))
  }

  function selectBehaviour(choice: {
    code?: string | number
    params?: unknown[]
    layer?: number
    hsb?: HsbColor
    unicodeBinding?: KeyBindingNode
  }) {
    const nextValue = choice.code
    if (nextValue == null) return
    if (nextValue === '&uc' && choice.unicodeBinding?.value === '&uc') {
      setDraft(choice.unicodeBinding, 1)
      return
    }
    if (nextValue === '&uc') {
      setDraft({ value: '&uc', params: [
        { value: '0', params: [] }, { value: '0', params: [] }
      ] }, 1)
      return
    }
    if (isRgbLayerRecipeCode(nextValue)) {
      const layer = Number.isFinite(choice.layer) ? Number(choice.layer) : 1
      setDraft(defaultRgbLayerBinding(layer, choice.hsb), 1)
      return
    }
    const lookedUp = lookupBehaviour(nextValue)
    const nextBehaviour =
      lookedUp ??
      (Array.isArray(choice.params) ? { params: choice.params } : undefined)
    const nextParams = getBehaviourParams([], nextBehaviour as never)
    setDraft(
      { value: nextValue, params: emptyParamNodes(nextParams.length) },
      nextParams.length === 0 ? 0 : 1
    )
  }

  function selectHsb(color: HsbColor, codeIndex?: number) {
    const current = readDraft()
    if (!editing || !current) return
    const index = codeIndex ?? editing.slotCodeIndex
    const updated = cloneBindTree(current)
    let target = makeIndex(updated)[index]
    if (!target && index > 0) {
      const count = Math.max(updated.params.length, index)
      updated.params = [
        ...updated.params,
        ...emptyParamNodes(count - updated.params.length)
      ]
      target = makeIndex(updated)[index]
    }
    if (!target) return
    const next = hsbBindingNode(color)
    target.value = next.value
    target.params = next.params as HydratedNode[]
    setDraft(updated, index)
  }

  function selectValue(choice: { code?: string | number }) {
    const current = readDraft()
    if (!editing || !activeSlot || !current || choice.code == null) return
    const code = typeof choice.code === 'number' ? String(choice.code) : choice.code
    if (String(current.value) === '&as') {
      setDraft(
        { value: '&as', params: autoshiftBindingParams(String(code)) },
        1
      )
      return
    }
    const updated = cloneBindTree(current)
    const root = keycodeChainRootSlot(slots, editing.slotCodeIndex)
    if (root && (activeSlot.param === 'code' || activeSlot.param === 'keycode')) {
      applyTerminalKey(updated, root.codeIndex, code)
    } else {
      let target = makeIndex(updated)[editing.slotCodeIndex]
      if (!target && editing.slotCodeIndex > 0) {
        const count = Math.max(updated.params.length, editing.slotCodeIndex)
        updated.params = [
          ...updated.params,
          ...emptyParamNodes(count - updated.params.length)
        ]
        target = makeIndex(updated)[editing.slotCodeIndex]
      }
      if (!target) return
      target.value = code
      target.params = []
    }
    setDraft(updated, root?.codeIndex ?? editing.slotCodeIndex)
  }

  function toggleHold(wrapCode: string) {
    const current = readDraft()
    if (!editing || !current) return
    const root = keycodeChainRootSlot(slots, editing.slotCodeIndex)
    if (!root || !isKeycodeParam(root.param)) return
    const updated = applyModifierHold(cloneBindTree(current), root.codeIndex, wrapCode)
    setDraft(updated, root.codeIndex)
  }

  function confirm() {
    const current = readDraft()
    if (!current || !editing) return
    const layer = Number(editing.rowKey)
    if (!Number.isFinite(layer)) return
    input.onUpdate(
      input.keyIndex(),
      layer,
      toKeyBinding(pick(cloneBindTree(current), ['value', 'params']))
    )
    closeEditor()
  }

  function openRow(fromLayer: number) {
    if (!canEdit) return
    openEditor(firstEditSlot(bindingForLayer(fromLayer)), fromLayer)
  }

  return {
    get editing() {
      return editing
    },
    get draftByRow() {
      return draftByRow
    },
    get slots() {
      return slots
    },
    get activeSlot() {
      return activeSlot
    },
    get bindingLabel() {
      return bindingLabel
    },
    get behaviours() {
      return behaviours
    },
    get choices() {
      return choices
    },
    get canEdit() {
      return canEdit
    },
    get normalized() {
      return normalized
    },
    openEditor,
    setDraft,
    closeEditor,
    confirm,
    selectBehaviour,
    selectValue,
    selectHsb,
    toggleHold,
    openRow,
    bindingForLayer
  }
}
