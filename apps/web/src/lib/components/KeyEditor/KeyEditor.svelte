<script lang="ts">
  import fuzzysort from 'fuzzysort'
  import { onMount } from 'svelte'
  import {
    behaviorFirmwareNote,
    behaviorSlotParam,
    ensureHoldTapPreset,
    HOLD_TAP_PRESETS,
    holdTapPresetFor,
    clampHsb,
    defaultRgbLayerHsb,
    isRgbLayerRecipeCode,
    isStockHoldTap,
    parseHsbToken,
    RGB_LAYER_RECIPE,
    zmkBehaviorDocsUrl,
    type HoldTapPreset,
    type HsbColor,
    type ZmkHoldTap,
    behaviorValueCatalog,
    catalogKeyChoices,
    buildChoiceLabeler,
    buildTaxonomyChips,
    groupChoicesByContext,
    initialTaxonomyContexts,
    nextTaxonomyContexts,
    sortBehaviorsByRole,
    parseKeyBinding,
    type KeyBindingNode,
    type CatalogChoice
  } from '@keymap-editor/keymap-core'
  import {
    editorBindingPreview,
    firstMissingSlot,
    isKeycodeParam,
    isSlotFilled,
    terminalKeySlot,
    visibleValueSlots,
    type EditorSlot
  } from '../../key-editor'
  import {
    canConfirmBinding,
    collectActiveHolds,
    needsTerminalKey,
    shouldShowPickKeyHint
  } from '../../key-editor-view'
  import { getSearchContext } from '../../context'
  import BehaviourRow from './BehaviourRow.svelte'
  import HoldRow from './HoldRow.svelte'
  import HoldTapFields from './HoldTapFields.svelte'
  import HsbPicker from './HsbPicker.svelte'
  import TaxonomyChips from './TaxonomyChips.svelte'
  import ValueGrid from './ValueGrid.svelte'
  import UnicodePicker from './UnicodePicker.svelte'
  import SelectChip from '../Common/SelectChip.svelte'
  import './KeyEditor.css'

  export type KeyEditorConfirmStaged = {
    holdTaps?: ZmkHoldTap[] | null
    rgbLayerRecipe?: boolean
  }

  interface Choice extends CatalogChoice {
    faIcon?: string
    /** `&rgblayer` chip: target layer index (session applies in one shot). */
    layer?: number
    hsb?: HsbColor
    unicodeBinding?: KeyBindingNode
  }

  interface Props {
    bindingLabel: string
    behaviours: Choice[]
    editorSlots: EditorSlot[]
    activeCodeIndex: number
    choices: Choice[]
    usedKeycodes?: ReadonlyMap<string, readonly number[]>
    usedRevision?: string
    usedLayerLabels?: readonly string[]
    /** Sensor turns: no hold-tap presets, multiple keycode params stay editable. */
    variant?: 'key' | 'encoder'
    onSelectBehaviour: (choice: Choice) => void
    onSelectValue: (choice: Choice) => void
    onSelectHsb?: (color: HsbColor, codeIndex: number) => void
    onToggleHold?: (wrapCode: string) => void
    onActivateSlot: (codeIndex: number) => void
    onConfirm: (staged?: KeyEditorConfirmStaged | null) => void
    onCancel: () => void
    holdTaps?: ZmkHoldTap[]
    onChangeHoldTaps?: (next: ZmkHoldTap[]) => void
  }

  let {
    bindingLabel,
    behaviours,
    editorSlots,
    activeCodeIndex,
    choices,
    usedKeycodes,
    usedRevision = '',
    usedLayerLabels = [],
    variant = 'key',
    onSelectBehaviour,
    onSelectValue,
    onSelectHsb,
    onToggleHold,
    onActivateSlot,
    onConfirm,
    onCancel,
    holdTaps,
    onChangeHoldTaps
  }: Props = $props()

  const searchBox = getSearchContext()
  const search = $derived(searchBox.current)

  let pickedBehaviour = $state<string | number | null>(null)
  let query = $state('')
  let pinnedContexts = $state<string[] | null>(null)
  let pinnedForKey = $state('')

  const used = $derived(usedKeycodes ?? new Map<string, readonly number[]>())
  const activeSlot = $derived(
    editorSlots.find(slot => slot.codeIndex === activeCodeIndex) ?? editorSlots[0]
  )
  const paramSlots = $derived.by(() => {
    const visible = visibleValueSlots(editorSlots)
    if (String(behaviourValue ?? '') !== '&as') return visible
    const keys = visible.filter(slot => isKeycodeParam(slot.param))
    const filled = keys.filter(slot => isSlotFilled(slot))
    const one = filled.at(-1) ?? keys[0]
    return one ? [one] : visible.slice(0, 1)
  })
  const keySlots = $derived(paramSlots.filter(slot => isKeycodeParam(slot.param)))
  /** Active keycode param, or the sole key when focus is on a modifier/layer chip. */
  const activeKeySlot = $derived(
    keySlots.find(slot => slot.codeIndex === activeCodeIndex) ?? keySlots[0]
  )
  const catalogSlot = $derived(activeKeySlot ?? activeSlot)
  const behaviourValue = $derived(pickedBehaviour ?? editorSlots[0]?.value)
  const encoderEdit = $derived(variant === 'encoder')
  const showPresets = $derived(!encoderEdit)
  /** Recipe node kept local until Apply, like hold-tap presets. */
  let stagedRgbLayerRecipe = $state(false)
  const rgbLayerEdit = $derived(isRgbLayerRecipeCode(behaviourValue))
  const unicodeEdit = $derived(behaviourValue === '&uc')
  let unicodeReady = $state(false)
  const layerSlot = $derived(paramSlots.find(slot => slot.param === 'layer'))
  const hsbSlot = $derived(paramSlots.find(slot => slot.param === 'hsb'))
  const hsbValue = $derived(
    parseHsbToken(hsbSlot?.value) ??
      parseHsbToken(
        (editorBindingPreview(editorSlots, pickedBehaviour) || bindingLabel).match(
          /RGB_COLOR_HSB(?:_VAL)?\(\d+\s*,\s*\d+\s*,\s*\d+\)/
        )?.[0]
      ) ?? defaultRgbLayerHsb(Number(layerSlot?.value) || 1)
  )
  /** Per-layer swatch memory while the dialog is open. */
  let layerColors = $state<Record<number, HsbColor>>({})
  /** Recipe params live in Presets chips — not the value grid. */
  const inlineSlots = $derived(
    paramSlots.filter(
      slot =>
        !isKeycodeParam(slot.param) &&
        slot.param !== 'hsb' &&
        !(rgbLayerEdit && slot.param === 'layer')
    )
  )
  const valueCatalog = $derived(behaviorValueCatalog(behaviourValue))
  const catalogParam = $derived(behaviorSlotParam(behaviourValue, catalogSlot?.param))
  const resolvedChoices = $derived.by(() => {
    if (catalogParam === 'command') {
      if (valueCatalog.choices.length) return valueCatalog.choices as Choice[]
      const listed = behaviours.find(
        choice => String(choice.code) === String(behaviourValue ?? '')
      ) as (Choice & { commands?: Choice[] }) | undefined
      return listed?.commands ?? []
    }
    if (search && catalogParam != null && catalogParam !== 'behaviour') {
      return (search.getSearchTargets(catalogParam, String(behaviourValue ?? '')) ??
        []) as Choice[]
    }
    return isKeycodeParam(catalogParam) ? choices : []
  })
  const dimUsed = $derived(
    isKeycodeParam(catalogParam) || catalogParam === 'command'
  )
  const showHolds = $derived(
    !encoderEdit &&
      !!activeKeySlot &&
      !!onToggleHold &&
      String(behaviourValue ?? '') !== '&as'
  )
  const showValuePicker = $derived(
    !rgbLayerEdit && catalogParam != null && catalogParam !== 'behaviour'
  )
  const keycodePicker = $derived(isKeycodeParam(catalogParam))
  const displayChoices = $derived(catalogKeyChoices(resolvedChoices))
  const previewLabel = $derived(
    editorBindingPreview(editorSlots, pickedBehaviour) || bindingLabel
  )
  const labelChoice = $derived(buildChoiceLabeler(displayChoices))
  const searching = $derived(query.trim().length > 0)
  const orderedBehaviours = $derived(sortBehaviorsByRole(behaviours))
  const activeBehaviour = $derived(
    orderedBehaviours.find(choice => String(choice.code) === String(behaviourValue ?? ''))
  )
  const behaviourCode = $derived(String(behaviourValue ?? ''))
  const preset = $derived(holdTapPresetFor(behaviourCode))
  const behaviourChoices = $derived(
    orderedBehaviours.filter(
      choice =>
        !holdTapPresetFor(String(choice.code)) &&
        !isRgbLayerRecipeCode(choice.code)
    )
  )
  const customHoldTap = $derived(
    (holdTaps ?? []).some(node => node.code === behaviourCode && !node.override) ||
      activeBehaviour?.holdTap === true
  )
  const timingFields = $derived(
    preset
      ? preset.fields
      : isStockHoldTap(behaviourCode) || customHoldTap
        ? (['tappingTermMs', 'flavor'] as const)
        : ([] as const)
  )
  /** Preset node kept in the dialog until Apply. Cancel drops it. */
  let stagedHoldTaps = $state<ZmkHoldTap[] | null>(null)
  const timingList = $derived(stagedHoldTaps ?? holdTaps)
  const autoshift = $derived(behaviourCode === '&as')

  /** A preset the keymap does not have yet stays local until Apply. */
  function stagePreset(code: string) {
    const list = ensureHoldTapPreset(holdTaps, code)
    const already = (holdTaps ?? []).some(node => node.code === code)
    stagedHoldTaps = already ? null : list
  }

  function presetTitle(item: HoldTapPreset): string {
    const docs = zmkBehaviorDocsUrl(item.code) ? 'Ctrl+click: docs' : ''
    return [item.description, docs].filter(Boolean).join('\n')
  }

  function choosePresetClick(event: MouseEvent, next: HoldTapPreset) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      const url = zmkBehaviorDocsUrl(next.code)
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
    choosePreset(next)
  }

  function choosePreset(next: HoldTapPreset) {
    if (!onChangeHoldTaps) return
    if (behaviourCode === next.code) return
    stagePreset(next.code)
    stagedRgbLayerRecipe = false
    // Behaviour chips store a local override. Presets must replace it, or the
    // row stays on &mt after the session draft has already moved.
    pickedBehaviour = next.code
    onSelectBehaviour({
      code: next.code,
      name: next.name,
      params: [...next.params],
      holdTap: true,
      ...next.defaults
    })
  }

  function swatchColor(layer: number): HsbColor {
    if (rgbLayerEdit && Number(layerSlot?.value) === layer) return hsbValue
    return layerColors[layer] ?? defaultRgbLayerHsb(layer)
  }

  function rememberLayerColor(layer: number, color: HsbColor) {
    const next = clampHsb(color)
    const prev = layerColors[layer]
    if (prev && prev.h === next.h && prev.s === next.s && prev.b === next.b) return
    layerColors = { ...layerColors, [layer]: next }
  }

  function chooseRgbLayer(layer: number, color: HsbColor = swatchColor(layer)) {
    stagedHoldTaps = null
    stagedRgbLayerRecipe = true
    rememberLayerColor(layer, color)
    if (
      rgbLayerEdit &&
      Number(layerSlot?.value) === layer &&
      hsbValue.h === color.h &&
      hsbValue.s === color.s &&
      hsbValue.b === color.b
    ) {
      return
    }
    pickedBehaviour = RGB_LAYER_RECIPE.code
    onSelectBehaviour({
      code: RGB_LAYER_RECIPE.code,
      name: RGB_LAYER_RECIPE.name,
      params: [...RGB_LAYER_RECIPE.params],
      description: RGB_LAYER_RECIPE.description,
      layer,
      hsb: color
    })
  }

  function setRgbLayerColor(layer: number, color: HsbColor) {
    rememberLayerColor(layer, color)
    if (rgbLayerEdit && Number(layerSlot?.value) === layer) {
      setHsb(color)
      return
    }
    chooseRgbLayer(layer, color)
  }

  function setHsb(color: HsbColor) {
    if (!hsbSlot || !onSelectHsb) return
    if (layerSlot != null) rememberLayerColor(Number(layerSlot.value), color)
    onActivateSlot(hsbSlot.codeIndex)
    onSelectHsb(color, hsbSlot.codeIndex)
  }

  $effect(() => {
    if (!rgbLayerEdit || layerSlot == null) return
    const layer = Number(layerSlot.value)
    if (!Number.isFinite(layer)) return
    rememberLayerColor(layer, hsbValue)
  })
  const showFilter = $derived(displayChoices.length > 16)
  const catalogKey = $derived(
    `${String(behaviourValue ?? '')}:${String(catalogParam ?? '')}:${displayChoices.length}`
  )

  const filtered = $derived.by(() => {
    const q = query.trim()
    if (!q) return displayChoices
    return fuzzysort
      .go(q, displayChoices, {
        keys: ['code', 'symbol', 'description', 'name'],
        limit: 500
      })
      .map(result => result.obj)
  })

  const allGroups = $derived(groupChoicesByContext(displayChoices))
  const filteredGroups = $derived(groupChoicesByContext(filtered))
  const taxonomyChips = $derived(buildTaxonomyChips(allGroups))
  const showTaxonomy = $derived(taxonomyChips.length > 1)

  const keycodeTaxonomy = $derived(keycodePicker)

  const activeContexts = $derived.by(() => {
    if (pinnedContexts && pinnedForKey === catalogKey) return pinnedContexts
    if (!keycodeTaxonomy) return allGroups.map(group => group.context)
    return initialTaxonomyContexts(allGroups, catalogSlot?.value)
  })

  const visibleGroups = $derived.by(() => {
    if (searching || !keycodeTaxonomy) return filteredGroups
    const selected = new Set(activeContexts)
    return filteredGroups.filter(group => selected.has(group.context))
  })

  const showGroupTitles = $derived(visibleGroups.length > 1)
  const activeHolds = $derived(
    collectActiveHolds(editorSlots, activeKeySlot?.codeIndex ?? activeCodeIndex)
  )
  const needsTerminal = $derived(needsTerminalKey(showHolds, activeHolds, paramSlots))
  const canConfirm = $derived(unicodeEdit ? unicodeReady : canConfirmBinding(editorSlots))
  const pickKeyHint = $derived(
    shouldShowPickKeyHint(catalogSlot, paramSlots, needsTerminal)
  )
  const firmwareNote = $derived(behaviorFirmwareNote(behaviourValue))

  function keyParamLabel(slot: EditorSlot | undefined, index: number): string {
    if (encoderEdit) {
      return index === 0 ? 'Clockwise' : 'Counter-clockwise'
    }
    if (!slot) return 'Key'
    if (keySlots.length > 1 && slot.label === 'Key') return `Key ${index + 1}`
    return slot.label
  }

  const activeKeySlotIndex = $derived(
    activeKeySlot
      ? keySlots.findIndex(slot => slot.codeIndex === activeKeySlot.codeIndex)
      : -1
  )
  const activeKeyLabel = $derived(
    keySlots.length > 1
      ? keyParamLabel(activeKeySlot, Math.max(0, activeKeySlotIndex))
      : 'Value'
  )

  function chooseBehaviour(choice: Choice) {
    stagedHoldTaps = null
    stagedRgbLayerRecipe = isRgbLayerRecipeCode(choice.code)
    pickedBehaviour = choice.code ?? null
    onSelectBehaviour(choice)
  }

  function choicesFor(param: unknown): Choice[] {
    const name = typeof param === 'string' ? param : ''
    if (name === 'command') {
      if (valueCatalog.choices.length) return valueCatalog.choices as Choice[]
      const listed = behaviours.find(
        choice => String(choice.code) === behaviourCode
      ) as (Choice & { commands?: Choice[] }) | undefined
      return listed?.commands ?? []
    }
    if (search && name && name !== 'behaviour') {
      return (search.getSearchTargets(name, behaviourCode) ?? []) as Choice[]
    }
    return isKeycodeParam(name) ? choices : []
  }

  /** One Presets chip per keymap layer (`&rgblayer_0` …). */
  const rgbLayerIndexes = $derived.by(() => {
    const fromSearch = catalogKeyChoices(choicesFor('layer'))
      .map(choice => Number(choice.code))
      .filter(index => Number.isFinite(index))
    if (fromSearch.length) {
      return [...new Set(fromSearch)].sort((a, b) => a - b)
    }
    const fromLabels = usedLayerLabels.length
    const fromSlot = Number(layerSlot?.value)
    const n = Math.max(
      fromLabels,
      Number.isFinite(fromSlot) ? fromSlot + 1 : 0,
      1
    )
    return Array.from({ length: n }, (_, index) => index)
  })

  /** Write a modifier or layer without hiding the key catalog. */
  function chooseInline(slot: EditorSlot, choice: Choice) {
    onActivateSlot(slot.codeIndex)
    onSelectValue(choice)
  }

  function focusKeySlot() {
    if (activeKeySlot) onActivateSlot(activeKeySlot.codeIndex)
  }

  /** The key grid always edits the active key slot, even after a modifier click. */
  function chooseKey(choice: Choice) {
    focusKeySlot()
    onSelectValue(choice)
  }
  const terminalValue = $derived(
    terminalKeySlot(editorSlots, activeKeySlot?.codeIndex ?? activeCodeIndex)?.value
  )

  function handleApply() {
    if (canConfirm) {
      const staged: KeyEditorConfirmStaged = {}
      if (stagedHoldTaps) staged.holdTaps = stagedHoldTaps
      if (stagedRgbLayerRecipe || rgbLayerEdit) staged.rgbLayerRecipe = true
      stagedHoldTaps = null
      stagedRgbLayerRecipe = false
      onConfirm(staged)
      return
    }
    const missing = firstMissingSlot(editorSlots)
    if (!missing) return
    onActivateSlot(missing.codeIndex)
  }

  function selectTaxonomy(chipId: string) {
    pinnedForKey = catalogKey
    pinnedContexts = nextTaxonomyContexts(allGroups, chipId)
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.isComposing || event.repeat) return
    if (event.key !== 'Enter') return
    const choosing =
      !canConfirm &&
      event.target instanceof HTMLButtonElement &&
      !event.target.classList.contains('key-editor-ok')
    if (choosing) return
    event.preventDefault()
    event.stopPropagation()
    handleApply()
  }

  // One listener for the dialog lifetime; handleKeyDown reads latest canConfirm/slots.
  onMount(() => {
    const onKey = (event: KeyboardEvent) => handleKeyDown(event)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  })
</script>

<div class="key-editor">
  <!-- Result sticker above the panel — not a window title. -->
  <div class="key-editor-preview">
    <code id="key-editor-binding" class="binding">{previewLabel}</code>
    <div class="key-editor-preview-actions">
      <button
        type="button"
        class="key-editor-ok"
        class:blocked={!canConfirm}
        aria-label={canConfirm ? 'Apply' : unicodeEdit ? 'Enter valid Unicode input' : 'Pick a key to finish the combo'}
        title={canConfirm ? 'Apply (Enter)' : unicodeEdit ? 'Enter valid Unicode input' : 'Pick a key to finish the combo'}
        disabled={unicodeEdit && !canConfirm}
        onclick={handleApply}
      >
        ✓
      </button>
      <button
        type="button"
        class="key-editor-cancel"
        aria-label="Cancel"
        title="Cancel (Esc)"
        onclick={onCancel}
      >
        ×
      </button>
    </div>
  </div>

  <div class="key-editor-body">
    <div class="key-editor-main">
      <div class="key-editor-choice-block" data-behavior-choice>
        <BehaviourRow
          behaviours={behaviourChoices}
          activeCode={behaviourValue}
          onChoose={chooseBehaviour}
        />

        {#if showPresets}
          <section class="key-editor-row" data-behavior-presets>
            <p class="key-editor-section-label">Presets</p>
            <div class="key-editor-chips" role="group" aria-label="Presets and recipes">
              {#each HOLD_TAP_PRESETS as item (item.code)}
                <SelectChip
                  active={behaviourCode === item.code}
                  title={presetTitle(item)}
                  aria-label={item.name}
                  data-behavior-preset={item.code}
                  disabled={!onChangeHoldTaps}
                  onclick={event => choosePresetClick(event, item)}
                >
                  {item.code}
                </SelectChip>
              {/each}
              <span class="key-editor-chip-sep" aria-hidden="true"></span>
              {#each rgbLayerIndexes as layer (layer)}
                <span
                  class="key-editor-rgblayer-preset"
                  data-behavior-recipe-layer={layer}
                >
                  <SelectChip
                    active={rgbLayerEdit && Number(layerSlot?.value) === layer}
                    title={RGB_LAYER_RECIPE.description}
                    aria-label={`${RGB_LAYER_RECIPE.name} · layer ${layer}`}
                    data-behavior-recipe={RGB_LAYER_RECIPE.code}
                    data-rgblayer-layer={layer}
                    onclick={() => chooseRgbLayer(layer)}
                  >
                    {RGB_LAYER_RECIPE.code}_{layer}
                  </SelectChip>
                  <HsbPicker
                    compact
                    value={swatchColor(layer)}
                    title={RGB_LAYER_RECIPE.description}
                    aria-label={`Color for layer ${layer}`}
                    data-rgblayer-color={layer}
                    onChange={color => setRgbLayerColor(layer, color)}
                  />
                </span>
              {/each}
            </div>
          </section>
        {/if}
      </div>

      {#if showPresets && !rgbLayerEdit}
        <HoldTapFields
          {behaviourCode}
          {timingFields}
          {timingList}
          defaults={activeBehaviour}
          {autoshift}
          disabled={!onChangeHoldTaps}
          {stagedHoldTaps}
          onStagedHoldTaps={next => {
            stagedHoldTaps = next
          }}
          {onChangeHoldTaps}
        />
      {/if}

      {#if firmwareNote}
        <p class="key-editor-note">{firmwareNote}</p>
      {/if}

      {#if unicodeEdit}
        <UnicodePicker
          value={parseKeyBinding(bindingLabel)}
          onChange={binding => {
            unicodeReady = binding != null
            if (binding) onSelectBehaviour({ code: '&uc', unicodeBinding: binding })
          }}
        />
      {:else}
      {#each inlineSlots as slot (slot.codeIndex)}
        {@const options = catalogKeyChoices(choicesFor(slot.param))}
        {@const labelOf = buildChoiceLabeler(options)}
        <section class="key-editor-row" data-slot-values>
          <p class="key-editor-section-label">{slot.label}</p>
          <div class="key-editor-grid">
            {#if options.length === 0}
              <p class="key-editor-empty">No matching values.</p>
            {:else}
              {#each options as choice (String(choice.code ?? ''))}
                <button
                  type="button"
                  class="key-editor-choice"
                  class:active={String(choice.code) === String(slot.value ?? '')}
                  class:used={slot.param === 'command' &&
                    used.has(String(choice.code ?? '')) &&
                    String(choice.code) !== String(slot.value ?? '')}
                  title={choice.description || String(choice.code ?? '')}
                  onclick={() => chooseInline(slot, choice)}
                >
                  {labelOf(choice)}
                </button>
              {/each}
            {/if}
          </div>
        </section>
      {/each}

      {#if activeKeySlot}
        {#if keySlots.length > 1}
          <section class="key-editor-row" data-keycode-slots>
            <p class="key-editor-section-label">Keys</p>
            <div
              class="key-editor-chips"
              role="group"
              aria-label={encoderEdit ? 'Encoder directions' : 'Key parameters'}
            >
              {#each keySlots as slot, index (slot.codeIndex)}
                <SelectChip
                  active={slot.codeIndex === activeKeySlot.codeIndex}
                  data-keycode-slot={slot.codeIndex}
                  aria-label={keyParamLabel(slot, index)}
                  title={String(slot.value ?? '')}
                  onclick={() => onActivateSlot(slot.codeIndex)}
                >
                  {slot.value
                    ? `${keyParamLabel(slot, index)} · ${slot.value}`
                    : keyParamLabel(slot, index)}
                </SelectChip>
              {/each}
            </div>
          </section>
        {/if}

        <section class="key-editor-row">
          <p class="key-editor-section-label">{activeKeyLabel}</p>
          <div class="key-editor-chips">
            {#if showTaxonomy}
              <TaxonomyChips
                chips={taxonomyChips}
                {activeContexts}
                onChoose={selectTaxonomy}
              />
            {/if}
          </div>
        </section>

        {#if showHolds}
          <HoldRow
            {activeHolds}
            {terminalValue}
            {displayChoices}
            onSelectKey={code => chooseKey({ code })}
            onToggleHold={wrap => {
              focusKeySlot()
              onToggleHold?.(wrap)
            }}
          />
        {/if}

        {#if showFilter}
          <input
            class="key-editor-filter"
            type="search"
            placeholder="Filter values…"
            bind:value={query}
          />
        {/if}

        <ul class="key-editor-legend" aria-label="Value chip styles">
          <li>
            <span class="key-editor-legend-swatch selected" aria-hidden="true"></span>
            Selected
          </li>
          {#if dimUsed}
            <li>
              <span class="key-editor-legend-swatch used" aria-hidden="true"></span>
              Already used elsewhere
            </li>
          {/if}
          <li>
            <span class="key-editor-legend-swatch limited" aria-hidden="true"></span>
            Limited OS support
          </li>
          <li>
            <span class="key-editor-legend-swatch alias" aria-hidden="true"></span>
            Alias / alternate name
          </li>
        </ul>

        {#key `${usedRevision}:${activeKeySlot.codeIndex}`}
          <ValueGrid
            groups={visibleGroups}
            {showGroupTitles}
            {searching}
            {pickKeyHint}
            activeValue={activeKeySlot.value}
            {dimUsed}
            {used}
            {usedLayerLabels}
            {labelChoice}
            onChoose={chooseKey}
          />
        {/key}
      {:else if inlineSlots.length === 0 && showValuePicker}
        <section class="key-editor-row">
          <p class="key-editor-section-label">Value</p>
        </section>
        <div class="key-editor-values">
          {#if displayChoices.length === 0}
            <p class="key-editor-empty">No matching values.</p>
          {:else}
            <div class="key-editor-grid">
              {#each displayChoices as choice (String(choice.code ?? ''))}
                <button
                  type="button"
                  class="key-editor-choice"
                  class:active={String(choice.code) === String(activeSlot?.value ?? '')}
                  class:used={dimUsed &&
                    used.has(String(choice.code ?? '')) &&
                    String(choice.code) !== String(activeSlot?.value ?? '')}
                  title={choice.description || String(choice.code ?? '')}
                  onclick={() => onSelectValue(choice)}
                >
                  {labelChoice(choice)}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {:else if inlineSlots.length === 0}
        <p class="key-editor-empty">This behaviour applies immediately.</p>
      {/if}
      {/if}
    </div>
  </div>
</div>
