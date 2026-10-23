<script lang="ts">
  import { hostLayout, type CatalogChoice, type HsbColor } from '@keymap-editor/keymap-core'
  import { editor } from '../editor.svelte.js'
  import type { EditorSlot } from '../key-editor'
  import Modal from './Common/Modal.svelte'
  import KeyEditor, { type KeyEditorConfirmStaged } from './KeyEditor/KeyEditor.svelte'

  interface Choice extends CatalogChoice {
    faIcon?: string
  }

  interface Props {
    open: boolean
    bindingLabel: string
    behaviours: Choice[]
    editorSlots: EditorSlot[]
    activeCodeIndex: number
    choices: Choice[]
    usedKeycodes?: ReadonlyMap<string, readonly number[]>
    usedRevision?: string
    usedLayerLabels?: readonly string[]
    variant?: 'key' | 'encoder'
    onSelectBehaviour: (choice: Choice) => void
    onSelectValue: (choice: Choice) => void
    onSelectHsb?: (color: HsbColor, codeIndex: number) => void
    onToggleHold?: (wrapCode: string) => void
    onActivateSlot: (codeIndex: number) => void
    /** Runs after any staged hold-tap / recipe flags are armed for the next keymap update. */
    onConfirm: () => void
    onCancel: () => void
  }

  let {
    open,
    bindingLabel,
    behaviours,
    editorSlots,
    activeCodeIndex,
    choices,
    usedKeycodes,
    usedRevision,
    usedLayerLabels,
    variant = 'key',
    onSelectBehaviour,
    onSelectValue,
    onSelectHsb,
    onToggleHold,
    onActivateSlot,
    onConfirm,
    onCancel
  }: Props = $props()

  const encoderEdit = $derived(variant === 'encoder')
  const unicodeHostLayout = $derived(hostLayout(editor.hostLegend.columns[0]?.layoutId ?? ''))

  function applyStaged(staged?: KeyEditorConfirmStaged | null) {
    if (staged?.holdTaps?.length) editor.armHoldTapsForNextUpdate(staged.holdTaps)
    if (staged?.rgbLayerRecipe) editor.armRgbLayerRecipeForNextUpdate(true)
    onConfirm()
  }
</script>

{#if open}
  <Modal onBackdrop={onCancel} ariaLabel={encoderEdit ? 'Edit encoder' : 'Edit key'}>
    <KeyEditor
      {bindingLabel}
      {behaviours}
      {editorSlots}
      {activeCodeIndex}
      {choices}
      {usedKeycodes}
      {usedRevision}
      {usedLayerLabels}
      {unicodeHostLayout}
      {variant}
      {onSelectBehaviour}
      {onSelectValue}
      {onSelectHsb}
      onToggleHold={encoderEdit ? undefined : onToggleHold}
      {onActivateSlot}
      onConfirm={applyStaged}
      onCancel={onCancel}
      holdTaps={
        encoderEdit
          ? undefined
          : (editor.draftKeymap?.holdTaps ?? editor.baselineKeymap?.holdTaps)
      }
      onChangeHoldTaps={
        encoderEdit ? undefined : next => editor.updateHoldTaps(next)
      }
    />
  </Modal>
{/if}
