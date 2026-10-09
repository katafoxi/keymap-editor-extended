<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import {
    UNICODE_ALIASES, UNICODE_MODES, UNICODE_DOCS_URL,
    unicodeAliasBinding, unicodeBinding, unicodeBindingState,
    unicodeCodePoint, unicodeCodePointLabel, unicodeGlyph, unicodeModeBinding,
    type KeyBindingNode
  } from '@keymap-editor/keymap-core'

  let { value, onChange }: {
    value: KeyBindingNode
    onChange: (binding: KeyBindingNode | null) => void
  } = $props()
  const original = untrack(() => value)
  const initial = unicodeBindingState(original)
  let kind = $state<'character' | 'mode'>(initial?.kind === 'mode' ? 'mode' : 'character')
  let normal = $state(initial?.kind === 'codepoints' ? unicodeCodePointLabel(initial.normal) : '')
  let shift = $state(initial?.kind === 'codepoints' && initial.shift !== 0 ? unicodeCodePointLabel(initial.shift) : '0')
  let mode = $state(initial?.kind === 'mode' ? initial.mode : 'UC_SET_WIN_COMPOSE')
  let query = $state('')
  let group = $state('')
  let error = $state('')
  let opaque = $state(initial == null && original.params.length > 0)
  const normalCp = $derived(unicodeCodePoint(normal))
  const shiftCp = $derived(unicodeCodePoint(shift))
  const groups = [...new Set(UNICODE_ALIASES.map(row => row.group))]
  const matches = $derived(UNICODE_ALIASES.filter(row => {
    const text = `${row.code} ${row.group} ${unicodeGlyph(row.normal)} ${unicodeGlyph(row.shift || row.normal)}`
    return (!group || row.group === group) && text.toLowerCase().includes(query.trim().toLowerCase())
  }))
  const modeInfo = $derived(UNICODE_MODES.find(row => row.code === mode))

  onMount(() => onChange(initial || opaque ? original : null))

  function characterChanged() {
    opaque = false
    try {
      const binding = unicodeBinding(normal, shift)
      error = ''
      onChange(binding)
    } catch (e) {
      error = (e as Error).message
      onChange(null)
    }
  }
  function chooseAlias(code: string) {
    const binding = unicodeAliasBinding(code)
    const pair = unicodeBindingState(binding)
    if (pair?.kind !== 'codepoints') return
    normal = unicodeCodePointLabel(pair.normal)
    shift = pair.shift === 0 ? '0' : unicodeCodePointLabel(pair.shift)
    opaque = false
    error = ''
    onChange(binding)
  }
  function modeChanged() {
    opaque = false
    error = ''
    onChange(unicodeModeBinding(mode))
  }
  function chooseKind(next: 'character' | 'mode') {
    kind = next
    if (kind === 'mode') modeChanged()
    else characterChanged()
  }
</script>

<section class="unicode-picker" aria-label="Unicode picker">
  <div class="unicode-tabs" role="group" aria-label="Unicode binding type">
    <button type="button" aria-pressed={kind === 'character'} data-unicode-kind="character" onclick={() => chooseKind('character')}>Character</button>
    <button type="button" aria-pressed={kind === 'mode'} data-unicode-kind="mode" onclick={() => chooseKind('mode')}>Input mode switch</button>
  </div>
  <p class="unicode-note">Requires urob/zmk-unicode in west.yml and host input setup with a US keyboard layout. Save adds the module header; it does not install the module or configure your OS. <a href={UNICODE_DOCS_URL} target="_blank" rel="noopener noreferrer">Setup instructions</a></p>
  {#if opaque}
    <p class="unicode-note">This external expression is kept unchanged. Enter code points or pick an alias to replace it.</p>
  {/if}
  {#if kind === 'character'}
    <div class="unicode-fields">
      <label>Normal
        <input aria-label="Normal Unicode character or code point" placeholder="ä, U+00E4, or 0xE4" value={normal} oninput={event => { normal = event.currentTarget.value; characterChanged() }} />
      </label>
      <label>With Shift
        <input aria-label="Shift Unicode character or code point" placeholder="Ä, U+00C4, or 0" value={shift} oninput={event => { shift = event.currentTarget.value; characterChanged() }} />
      </label>
    </div>
    <p class="unicode-note">Enter one Unicode scalar, U+hex, 0xhex, or a decimal code point. Shift 0 reuses Normal; no uppercase conversion is guessed.</p>
    {#if normalCp != null && shiftCp != null}
      <output aria-label="Unicode character preview">Normal: {unicodeGlyph(normalCp)} · Shift: {unicodeGlyph(shiftCp || normalCp)}</output>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="unicode-fields">
      <label>Common aliases
        <input type="search" aria-label="Filter Unicode aliases" placeholder="Search alias or character…" bind:value={query} />
      </label>
      <label>Group
        <select aria-label="Unicode alias group" bind:value={group}>
          <option value="">All aliases</option>
          {#each groups as name}<option value={name}>{name}</option>{/each}
        </select>
      </label>
    </div>
    <div class="unicode-aliases">
      {#each matches as alias (alias.code)}
        <button type="button" data-unicode-alias={alias.code} title={`${alias.group}: ${unicodeCodePointLabel(alias.normal)} / ${unicodeCodePointLabel(alias.shift || alias.normal)}`} onclick={() => chooseAlias(alias.code)}>
          <span>{unicodeGlyph(alias.normal)} · {unicodeGlyph(alias.shift || alias.normal)}</span><code>{alias.code}</code>
        </button>
      {:else}<p>No matching aliases. Any scalar can be entered above.</p>{/each}
    </div>
  {:else}
    <label>Switch the keyboard's Unicode input system
      <select aria-label="Unicode input mode" value={mode} onchange={event => { mode = event.currentTarget.value; modeChanged() }}>
        {#each UNICODE_MODES as item}<option value={item.code}>{item.name}</option>{/each}
      </select>
    </label>
    <p class="unicode-note">{modeInfo?.setup} This binding switches the mode at runtime; it does not change default-mode or OS settings.</p>
  {/if}
</section>

<style>
  .unicode-picker { display: grid; gap: 0.7rem; }
  .unicode-tabs, .unicode-fields { display: flex; gap: 0.7rem; flex-wrap: wrap; }
  label { display: grid; gap: 0.3rem; flex: 1; min-width: 10rem; }
  input, select, button { font: inherit; color: inherit; background: var(--fill-subtle); border: 1px solid var(--border); border-radius: 0.4rem; padding: 0.4rem 0.6rem; }
  button { cursor: pointer; }
  button[aria-pressed="true"] { outline: 2px solid var(--accent); }
  .unicode-note { font-size: 0.85rem; opacity: 0.85; margin: 0; }
  .unicode-aliases { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: 0.4rem; max-height: 14rem; overflow: auto; }
  .unicode-aliases button { display: grid; gap: 0.3rem; text-align: left; }
  .unicode-aliases code { font-size: 0.75rem; overflow-wrap: anywhere; }
  [role="alert"] { color: var(--danger); margin: 0; }
</style>
