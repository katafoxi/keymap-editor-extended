<script lang="ts">
  import {
    behaviorPeekNote,
    holdTapTimingNote,
    composeLegendDecode,
    hostLevels,
    keysymToGlyph,
    parseKeyBinding,
    withEditableLegendDecodeGaps,
    stripKcPrefix,
    type HostLanguageId,
    type LegendDecodeCard
  } from '@keymap-editor/keymap-core'
  import { editor } from '../editor.svelte.js'
  import { pushEscapeHandler } from '../escape-stack'
  import DecodeLevelGrid from './DecodeLevelGrid.svelte'
  import DecodeSessionBar from './DecodeSessionBar.svelte'

  interface Props {
    card: LegendDecodeCard
    anchor: DOMRect
    tooltipId: string
    /** Alt+click host-edit session for this card. */
    hostSession?: boolean
    /** Encoded binding before an unpublished edit. Empty string means the key was blank. */
    previous?: string
    /** Override the peek hint (dictionary halves are combo, not a matrix row). */
    modeHint?: string
    onArmCell?: (language: HostLanguageId, level: number) => void
    onEndSession?: () => void
  }

  let {
    card,
    anchor,
    tooltipId,
    hostSession = false,
    previous,
    modeHint,
    onArmCell,
    onEndSession
  }: Props = $props()
  let el: HTMLDivElement | undefined = $state()
  let busy = $state(false)

  const zmk = $derived(stripKcPrefix(card.keycode))
  const showBinding = $derived(!zmk || card.binding !== `&kp ${zmk}`)
  const dialogLabel = $derived(
    card.keycode ? `Legend decode ${card.keycode}` : 'Legend decode'
  )
  const displayCard = $derived.by(() => {
    void editor.hostLayoutRevision
    try {
      const base = composeLegendDecode(parseKeyBinding(card.binding), editor.hostLegend)
      return withEditableLegendDecodeGaps(base, editor.hostLegend)
    } catch {
      return card
    }
  })
  const behaviorNote = $derived.by(() => {
    try {
      const binding = parseKeyBinding(displayCard.binding)
      const peek = behaviorPeekNote(binding.value)
      const holdTap = (
        editor.draftKeymap?.holdTaps ?? editor.baselineKeymap?.holdTaps
      )?.find(item => item.code === String(binding.value))
      const timing = holdTapTimingNote(holdTap)
      const note = [peek, timing].filter(Boolean).join(' ')
      return note || null
    } catch {
      return null
    }
  })
  const editing = $derived.by(() => {
    const target = editor.hostSymbolEditTarget
    if (!target || !zmk || target.zmk !== zmk) return null
    return { language: target.language, level: target.level }
  })
  const dropsWarning = $derived.by(() => {
    void editor.hostLayoutRevision
    const target = editor.hostSymbolEditTarget
    if (!target || target.zmk !== zmk || target.level !== 0) return false
    const keysym = hostLevels(editor.activeProfileId(target.language), target.zmk)?.keysyms[0]
    return keysym != null && keysymToGlyph(keysym) == null
  })
  /** Armed cell is one the keymap's `&uc` keys type as part of their service sequence. */
  const unicodeRequired = $derived.by(() => {
    const target = editor.hostSymbolEditTarget
    if (!hostSession || !target || target.zmk !== zmk) return null
    return editor.unicodeServiceRequirement(target)
  })
  const unicodePending = $derived(
    hostSession && editor.unicodeServiceConfirm?.zmk === zmk ? editor.unicodeServiceConfirm : null
  )
  const unicodeKeysLabel = $derived(
    editor.unicodeKeyCount === 1 ? '1 &uc key' : `${editor.unicodeKeyCount} &uc keys`
  )
  /** Host levels exist only for keys in the host-key registry. */
  const hostEditable = $derived(Boolean(displayCard.keycode))
  const hasDiff = $derived(
    displayCard.current.some(column => column.slots.some(slot => slot.differs))
  )
  /** Revert only in an Alt+click session — hover peek is read-only. */
  const showRevertRow = $derived(hostSession && hasDiff)

  $effect(() => {
    const root = document.getElementById('modal-root') ?? document.body
    if (!el) return
    root.appendChild(el)
    return () => el?.remove()
  })

  $effect(() => {
    if (!el) return
    void displayCard
    void anchor
    void hostSession
    void showRevertRow
    void unicodePending
    void unicodeRequired
    const box = el.getBoundingClientRect()
    let left = anchor.left + anchor.width / 2 - box.width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8))
    let top = anchor.top - box.height - 2
    if (top < 8) top = anchor.bottom + 2
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  })

  $effect(() => {
    if (!el) return
    if (hostSession) {
      el.setAttribute('role', 'dialog')
      el.setAttribute('aria-label', dialogLabel)
      el.setAttribute('aria-modal', 'true')
      el.setAttribute('tabindex', '-1')
    } else {
      el.setAttribute('role', 'tooltip')
      el.removeAttribute('aria-label')
      el.removeAttribute('aria-modal')
      el.removeAttribute('tabindex')
    }
  })

  $effect(() => {
    if (!hostSession) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const target = event.target
        if (target instanceof HTMLElement && target.closest('button.slot, button.revert, input, textarea')) {
          return
        }
        event.preventDefault()
        event.stopImmediatePropagation()
        onEndSession?.()
      }
    }
    window.addEventListener('keydown', onKey, true)
    const popEscape = pushEscapeHandler(() => {
      onEndSession?.()
    })
    return () => {
      window.removeEventListener('keydown', onKey, true)
      popEscape()
    }
  })

  $effect(() => {
    if (!el || !hostSession) return
    const node = el
    const key = zmk
    const click = (event: MouseEvent) => {
      event.stopPropagation()
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[data-host-accept], [data-host-cancel]')) {
        onEndSession?.()
        return
      }
      if (target.closest('[data-unicode-override]')) {
        if (busy) return
        void (async () => {
          busy = true
          try {
            await editor.confirmUnicodeServiceEdit()
          } finally {
            busy = false
          }
        })()
        return
      }
      if (target.closest('[data-unicode-keep]')) {
        editor.dismissUnicodeServiceEdit()
        return
      }
      const revert = target.closest('[data-host-revert]')
      if (revert instanceof HTMLElement) {
        const language = revert.dataset.language as HostLanguageId
        const level = Number(revert.dataset.level)
        if (!key || busy || !Number.isInteger(level)) return
        void (async () => {
          busy = true
          try {
            await editor.revertHostKeyLevel(language, key, level)
          } finally {
            busy = false
          }
        })()
        return
      }
      const cell = target.closest('[data-host-edit]')
      if (cell instanceof HTMLElement) {
        const language = cell.dataset.language as HostLanguageId
        const level = Number(cell.dataset.level)
        if (!key || !Number.isInteger(level)) return
        onArmCell?.(language, level)
        queueMicrotask(() => {
          if (cell instanceof HTMLElement) cell.focus()
        })
      }
    }
    node.addEventListener('click', click, true)
    return () => {
      node.removeEventListener('click', click, true)
    }
  })
</script>

<div
  bind:this={el}
  id={tooltipId}
  class="legend-decode"
  class:session={hostSession}
  class:peek={!hostSession}
  class:has-table={displayCard.current.length > 0}
  class:has-note={Boolean(behaviorNote)}
  style="position:fixed;left:{anchor.left}px;top:{anchor.top}px;z-index:var(--z-decode)"
>
  {#if previous !== undefined}
    <div class="was">{previous ? `Was ${previous}` : 'Was empty'}</div>
  {/if}
  <div class="ids">
    {#if showBinding}<span class="bind">{displayCard.binding}</span>{/if}
    {#if displayCard.keycode}
      <span class="id" title="ZMK keycode"><span class="mark">ZMK</span> {displayCard.keycode}</span>
    {/if}
    {#if displayCard.vk}
      <span class="id" title="Windows virtual-key"><span class="mark">Win</span> {displayCard.vk}</span>
    {/if}
    {#if displayCard.evdevName}
      <span class="id" title="Linux evdev"><span class="mark">Lin</span> {displayCard.evdevName}</span>
    {/if}
    {#if displayCard.hold}<span class="hold">{displayCard.hold}</span>{/if}
  </div>
  {#if behaviorNote}
    <p class="behavior-note">{behaviorNote}</p>
  {/if}
  {#if displayCard.current.length}
    <DecodeLevelGrid
      current={displayCard.current}
      system={displayCard.system}
      {hostSession}
      {showRevertRow}
      {dropsWarning}
      {editing}
      {zmk}
      {busy}
    />
  {/if}
  {#if unicodePending}
    <div class="unicode-guard" role="alert" data-unicode-guard="confirm">
      <p>
        The keymap has {unicodeKeysLabel}. They type unshifted “{unicodePending.required}” on
        this key in English to enter a code point. Changing it makes those keys type the wrong
        character.
      </p>
      <div class="unicode-guard-actions">
        <button type="button" data-unicode-keep>Keep “{unicodePending.required}”</button>
        <button type="button" class="override" data-unicode-override disabled={busy}>
          Change anyway
        </button>
      </div>
    </div>
  {:else if unicodeRequired}
    <p class="unicode-guard note" role="note" data-unicode-guard="note">
      Reserved for {unicodeKeysLabel}: keep unshifted “{unicodeRequired}” here. Shift and AltGr are free.
    </p>
  {/if}
  {#if hostSession}
    <DecodeSessionBar />
  {:else if modeHint}
    <p class="mode-hint" role="note">{modeHint}</p>
  {:else if hostEditable}
    <p class="mode-hint" role="note">
      Click row — ZMK · Alt+click — host
    </p>
  {:else}
    <p class="mode-hint" role="note">Click row — ZMK</p>
  {/if}
</div>

<style>
  .legend-decode {
    box-sizing: border-box;
    min-width: 18em;
    padding: 7px 9px 8px;
    border-radius: 8px;
    background: var(--paper);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--paper-shade) 12%, transparent),
      0 8px 22px color-mix(in srgb, var(--paper-shade) 18%, transparent);
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 16px;
    line-height: 1.2;
    white-space: nowrap;
  }

  /* Hover peek must not steal the pointer — no bridge / hold onto the card. */
  .legend-decode.peek {
    pointer-events: none;
  }

  .legend-decode.session {
    pointer-events: auto;
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--paper-shade) 18%, transparent),
      0 10px 28px color-mix(in srgb, var(--paper-shade) 24%, transparent);
  }

  /* Size to the level grid. Identifier and hint lines wrap to that width
     instead of stretching the columns. */
  .legend-decode.has-table {
    display: inline-grid;
    grid-template-columns: min-content;
    min-width: 0;
    max-width: min(40em, calc(100vw - 16px));
  }

  .legend-decode.has-table :is(.was, .ids, .behavior-note, .mode-hint),
  .legend-decode.has-table :global(.session-bar) {
    width: 0;
    min-width: 100%;
    white-space: normal;
  }

  /* Layer / hold-tap peeks have no grid — still wrap the one-liner. */
  .legend-decode.has-note:not(.has-table) {
    max-width: min(22em, calc(100vw - 16px));
    white-space: normal;
  }

  .was {
    margin-bottom: 4px;
    color: var(--warn-ink);
    font-size: var(--font-md);
    font-family: Quicksand, avenir, sans-serif;
    line-height: 1.3;
  }

  .behavior-note {
    margin: 0 0 6px;
    white-space: normal;
    font-family: Quicksand, avenir, sans-serif;
    font-size: var(--font-sm);
    line-height: 1.35;
    color: var(--paper-ink-subtle);
  }

  .ids {
    display: flex;
    flex-wrap: nowrap;
    gap: 0.85em;
    margin-bottom: 6px;
    color: var(--paper-ink-muted);
    font-size: var(--font-md);
    font-family: Quicksand, avenir, sans-serif;
  }

  .ids .id {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3em;
  }

  .ids .mark {
    font-size: var(--font-xs);
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--paper-ink-faint);
  }

  .ids .bind {
    color: var(--paper-ink-strong);
  }

  .ids .hold {
    padding: 0 4px;
    border-radius: 3px;
    background: var(--shade-wash);
  }

  .legend-decode.has-table .ids {
    flex-wrap: wrap;
    column-gap: 0.85em;
    row-gap: 0.25em;
  }

  .unicode-guard {
    margin: 6px 0 0;
    font-family: Quicksand, avenir, sans-serif;
    font-size: var(--font-sm);
    line-height: 1.35;
    white-space: normal;
    color: var(--warn-ink);
  }

  .unicode-guard p {
    margin: 0;
  }

  .unicode-guard:not(.note) {
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--warn-wash);
    box-shadow: inset 0 0 0 1px var(--warn-border);
  }

  .unicode-guard-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }

  .unicode-guard-actions button {
    padding: 2px 8px;
    border: 1px solid var(--warn-border);
    border-radius: 4px;
    background: var(--paper);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }

  .unicode-guard-actions button.override {
    color: var(--danger-ink);
    border-color: var(--danger-border);
  }

  .legend-decode.has-table .unicode-guard {
    width: 0;
    min-width: 100%;
  }

  .mode-hint {
    margin: 7px 0 0;
    padding-top: 5px;
    border-top: 1px solid color-mix(in srgb, var(--paper-shade) 10%, transparent);
    white-space: normal;
    font-family: Quicksand, avenir, sans-serif;
    font-size: var(--font-sm);
    line-height: 1.3;
    color: var(--paper-ink-subtle);
  }
</style>
