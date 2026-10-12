<script lang="ts">
  import {
    ALT_GR_COLUMN_LABEL,
    ALT_GR_SHIFT_COLUMN_LABEL,
    addHostLanguage,
    hostLanguageName,
    hostLanguagesAvailable,
    hostLayoutChoice,
    hostLayoutChoiceLabel,
    isAddableHostLanguage,
    removeHostLanguage,
    replaceHostLanguage,
    setHostColumnAlt,
    toggleHostLanguage,
    type HostLanguageId,
    type HostLegendColumn
  } from '@keymap-editor/keymap-core'
  import { editor } from '../editor.svelte.js'
  import { clickOutside } from '../actions/click-outside'
  import { pushEscapeHandler } from '../escape-stack'
  import EyeToggle from './EyeToggle.svelte'
  import PressToggle from './Common/PressToggle.svelte'
  import HostProfileMenu from './HostProfileMenu.svelte'
  import LangFlag from './LangFlag.svelte'

  const REMOVE_LANGUAGE = '__remove__'

  interface Props {
    column?: HostLegendColumn
    interactive: boolean
    /** First column of a language after the base — stronger left edge between languages. */
    groupStart?: boolean
    /** Multilang face shows every column; the eye waits until that face is off. */
    languagesStacked?: boolean
    pickingFor?: HostLanguageId | null
    pickingNew?: boolean
    openProfile?: HostLanguageId | null
  }

  let {
    column,
    interactive,
    groupStart = false,
    languagesStacked = false,
    pickingFor = $bindable(null),
    pickingNew = $bindable(false),
    openProfile = $bindable(null)
  }: Props = $props()

  const choice = $derived(column ? hostLayoutChoice(column.layoutId) : undefined)
  const language = $derived(column?.language)
  const extra = $derived(language != null && isAddableHostLanguage(language))
  const needsHostLanguage = $derived(editor.hostLegend.columns.length < 2)
  const languageName = $derived(choice?.languageName ?? language ?? '')
  const choosing = $derived(language != null && pickingFor === language)
  const addable = $derived(hostLanguagesAvailable(editor.hostLegend))

  $effect(() => {
    const open = column ? choosing : pickingNew
    if (!open) return
    return pushEscapeHandler(() => {
      if (column) pickingFor = null
      else pickingNew = false
    })
  })

  /** Keep the document outside-close listener from seeing presses on menu items. */
  function holdLangMenu(event: Event) {
    event.stopPropagation()
  }

  function closeLangMenu() {
    if (column) pickingFor = null
    else pickingNew = false
  }

  function activeProfileLabel(): string {
    if (!language) return ''
    const id = editor.activeProfileId(language)
    const user = editor.profilesForLanguage(language).find(profile => profile.id === id)
    const full = user
      ? user.name
      : (() => {
          const selected = hostLayoutChoice(id)
          return selected ? hostLayoutChoiceLabel(selected) : ''
        })()
    const paren = full.match(/\(([^)]+)\)\s*$/)
    return paren ? paren[1] : full
  }

  function toggleLanguage() {
    if (!language || languagesStacked) return
    void editor.commitHostMap(toggleHostLanguage(editor.hostLegend, language))
  }

  function toggleAddLanguage() {
    if (addable.length === 0) return
    pickingNew = !pickingNew
    pickingFor = null
    openProfile = null
  }

  function pickNewLanguage(value: string) {
    if (!isAddableHostLanguage(value)) return
    pickingNew = false
    pickingFor = null
    void editor.commitHostMap(addHostLanguage(editor.hostLegend, value))
  }

  function toggleLanguagePicker() {
    if (!column || !language || !extra) return
    if (!column.wide) void editor.commitHostMap(toggleHostLanguage(editor.hostLegend, language))
    pickingNew = false
    pickingFor = pickingFor === language ? null : language
    openProfile = null
  }

  function changeLanguage(value: string) {
    if (!language) return
    if (value === REMOVE_LANGUAGE) {
      pickingNew = false
      pickingFor = null
      void editor.commitHostMap(removeHostLanguage(editor.hostLegend, language))
      return
    }
    if (!isAddableHostLanguage(value) || value === language) {
      pickingFor = null
      return
    }
    pickingNew = false
    pickingFor = null
    void editor.commitHostMap(replaceHostLanguage(editor.hostLegend, language, value))
  }

  function toggleAlt(field: 'altGr' | 'altGrShift', on: boolean) {
    if (!language) return
    void editor.commitHostMap(setHostColumnAlt(editor.hostLegend, language, field, !on))
  }

  function hoverAlt(kind: 'altGr' | 'altGrShift') {
    editor.setLegendHover({ kind })
  }

  function clearHover() {
    editor.setLegendHover(null)
  }

  function focusLangList(node: HTMLUListElement) {
    const first = node.querySelector('button.lang-item:not(:disabled)')
    if (first instanceof HTMLButtonElement) first.focus()
  }
</script>

{#if !column}
  <th class="add-language-cell lang-start" class:prompt={needsHostLanguage}>
    <div class="lang-head" class:host-prompt={needsHostLanguage}>
      {#if needsHostLanguage}
        <span class="prompt-label">Computer language</span>
      {/if}
      <div
        class="lang-menu"
        use:clickOutside={{
          enabled: pickingNew,
          closestSelector: '.lang-menu',
          handler: closeLangMenu
        }}
      >
        <button
          type="button"
          class="add-language"
          aria-label={needsHostLanguage ? 'Computer language' : 'Add language'}
          title={needsHostLanguage ? 'Computer language' : 'Add language'}
          aria-haspopup="listbox"
          aria-expanded={pickingNew}
          disabled={addable.length === 0}
          onclick={toggleAddLanguage}
        >
          {#if needsHostLanguage}
            <span class="add-label">Choose</span>
          {:else}
            <span class="add-mark" aria-hidden="true">+</span>
            <span class="add-label">Lang</span>
          {/if}
          <span class="caret" aria-hidden="true"></span>
        </button>
        {#if pickingNew}
          <ul
            class="lang-list"
            role="listbox"
            aria-label="Language"
            use:focusLangList
            onpointerdown={holdLangMenu}
          >
            {#each addable as option (option)}
              <li role="none">
                <button
                  type="button"
                  class="lang-item"
                  role="option"
                  aria-selected="false"
                  onclick={() => pickNewLanguage(option)}
                >
                  <LangFlag language={option} />
                  <span>{hostLanguageName(option)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </th>
{:else}
  <th class:off={!column.shown} class:narrow={!column.wide} class:lang-start={groupStart}>
    <div class="lang-head" class:narrow={!column.wide}>
      {#if interactive}
        <div class="lang-row">
          <EyeToggle
            on={languagesStacked || column.shown}
            disabled={languagesStacked}
            label={
              languagesStacked
                ? `${choice?.languageName ?? language} stays on the key while languages are stacked`
                : column.shown
                  ? `Hide ${choice?.languageName ?? language}`
                  : `Show ${choice?.languageName ?? language}`
            }
            dataTour="language-eye"
            onclick={toggleLanguage}
          />
          {#if extra && language}
            <div
              class="lang-menu"
              use:clickOutside={{
                enabled: choosing,
                closestSelector: '.lang-menu',
                handler: closeLangMenu
              }}
            >
              <button
                type="button"
                class="lang-flag"
                title={choice?.languageName ?? language}
                aria-label={`Language ${choice?.languageName ?? language}`}
                aria-haspopup="listbox"
                aria-expanded={choosing}
                onclick={toggleLanguagePicker}
              >
                <LangFlag {language} />
                <span class="caret" aria-hidden="true"></span>
              </button>
              {#if choosing}
                <ul
                  class="lang-list"
                  role="listbox"
                  aria-label="Language"
                  use:focusLangList
                  onpointerdown={holdLangMenu}
                >
                  <li role="none">
                    <button
                      type="button"
                      class="lang-item selected"
                      role="option"
                      aria-selected="true"
                      disabled
                    >
                      <LangFlag {language} />
                      <span>{hostLanguageName(language)}</span>
                    </button>
                  </li>
                  {#each addable as option (option)}
                    <li role="none">
                      <button
                        type="button"
                        class="lang-item"
                        role="option"
                        aria-selected="false"
                        onclick={() => changeLanguage(option)}
                      >
                        <LangFlag language={option} />
                        <span>{hostLanguageName(option)}</span>
                      </button>
                    </li>
                  {/each}
                  <li class="lang-sep" aria-hidden="true"></li>
                  <li role="none">
                    <button
                      type="button"
                      class="lang-item danger"
                      role="option"
                      aria-selected="false"
                      onclick={() => changeLanguage(REMOVE_LANGUAGE)}
                    >
                      Remove language
                    </button>
                  </li>
                </ul>
              {/if}
            </div>
          {:else}
            <span class="lang-flag" title={extra ? languageName : 'Firmware key codes (US)'}>
              {#if language}<LangFlag {language} alt={extra ? languageName : 'English, firmware key codes'} />{/if}
            </span>
          {/if}
        </div>
        <div class="lang-tools" hidden={!column.wide}>
          {#if column.wide}
            <HostProfileMenu
              language={column.language}
              languageName={choice?.languageName ?? column.language}
              open={openProfile === column.language}
              onToggle={() => {
                pickingFor = null
                openProfile = openProfile === column.language ? null : column.language
              }}
              onClose={() => {
                if (openProfile === column.language) openProfile = null
              }}
            />
          {/if}
        </div>
      {:else}
        <div class="lang-row">
          <span class="eye-spacer"></span>
          <span class="lang-flag" title={extra ? languageName : 'Firmware key codes (US)'}>
            {#if language}<LangFlag {language} alt={extra ? languageName : 'English, firmware key codes'} />{/if}
          </span>
        </div>
        {#if column.wide}
          <span class="profile-name">{activeProfileLabel()}</span>
        {/if}
      {/if}
    </div>
  </th>
  {#if column.wide}
    <th
      class="alt-head"
      class:off={!column.altGr}
      onmouseenter={interactive ? () => hoverAlt('altGr') : undefined}
      onmouseleave={interactive ? clearHover : undefined}
    >
      <div class="alt-turn">
        {#if interactive}
          <PressToggle
            class="col-toggle"
            density="pill"
            pressed={column.altGr}
            aria-label="AltGr"
            title="AltGr"
            onclick={() => toggleAlt('altGr', column.altGr)}
          >
            {ALT_GR_COLUMN_LABEL}
          </PressToggle>
        {:else}
          <span class="alt-label">{ALT_GR_COLUMN_LABEL}</span>
        {/if}
      </div>
    </th>
    <th
      class="alt-head"
      class:off={!column.altGrShift}
      onmouseenter={interactive ? () => hoverAlt('altGrShift') : undefined}
      onmouseleave={interactive ? clearHover : undefined}
    >
      <div class="alt-turn">
        {#if interactive}
          <PressToggle
            class="col-toggle"
            density="pill"
            pressed={column.altGrShift}
            aria-label="AltGr+Shift"
            title="AltGr+Shift"
            onclick={() => toggleAlt('altGrShift', column.altGrShift)}
          >
            {ALT_GR_SHIFT_COLUMN_LABEL}
          </PressToggle>
        {:else}
          <span class="alt-label">{ALT_GR_SHIFT_COLUMN_LABEL}</span>
        {/if}
      </div>
    </th>
  {/if}
{/if}

<style>
  th {
    padding: 2px 5px;
    text-align: left;
    font-weight: 500;
    white-space: nowrap;
    border: 1px solid color-mix(in srgb, var(--shade) 8%, transparent);
    font-size: var(--font-sm);
    color: var(--text-muted);
  }

  .off {
    opacity: 0.4;
  }

  th.narrow {
    min-width: 0;
    width: 1%;
  }

  th.lang-start {
    border-left: 2px solid color-mix(in srgb, var(--shade) 28%, transparent);
  }

  th.alt-head {
    width: 1%;
    padding: 4px 3px;
    vertical-align: middle;
    text-align: center;
  }

  /*
   * Rotate the whole chip −90° so glyph relative orientation stays (⎇ stays upright
   * vs R/⇧). writing-mode reorients each codepoint and misdraws ⎇.
   */
  .alt-turn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.55rem;
    height: 3.35rem;
    margin: 0 auto;
  }

  .alt-turn :global(.col-toggle),
  .alt-turn .alt-label {
    flex: none;
    transform: rotate(-90deg);
    white-space: nowrap;
  }

  .alt-turn .alt-label {
    display: inline-block;
    padding: 1px 6px;
  }

  .lang-head {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    min-width: 0;
  }

  .lang-head.narrow {
    min-width: 0;
    width: 1%;
  }

  .lang-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .lang-tools {
    display: flex;
    align-items: stretch;
    min-width: 0;
    width: 100%;
  }

  .lang-tools :global(.profile-menu) {
    display: flex;
    width: 100%;
    min-width: 0;
  }

  .lang-tools :global(.profile-trigger) {
    width: 100%;
    max-width: none;
  }

  .lang-tools[hidden] {
    display: none;
  }

  .lang-menu {
    position: relative;
  }

  .lang-list {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    z-index: 9;
    min-width: 10rem;
    margin: 0;
    padding: 4px 0;
    overflow: visible;
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
  }

  .lang-list li {
    margin: 0;
    padding: 0 4px;
  }

  .lang-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin: 0;
    padding: 4px 8px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: var(--font-sm);
    text-align: left;
    cursor: pointer;
  }

  .lang-item.selected {
    font-weight: 600;
  }

  .lang-item:disabled {
    cursor: default;
    opacity: 0.85;
  }

  .lang-item:hover:not(:disabled),
  .lang-item:focus-visible {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    outline: none;
  }

  .lang-item.danger {
    color: var(--danger, #b42318);
  }

  .lang-sep {
    height: 1px;
    margin: 4px 8px;
    padding: 0;
    background: var(--border);
  }

  .add-language-cell {
    width: 1%;
  }

  .add-language {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 7px 0 5px;
    border: 1px dashed var(--accent);
    border-radius: 6px;
    background: var(--surface);
    color: var(--accent);
    font: inherit;
    font-size: var(--font-xs);
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
  }

  .add-language:hover,
  .add-language[aria-expanded='true'] {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  .add-language:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .add-language:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .add-mark {
    font-size: var(--font-icon);
    line-height: 1;
  }

  .add-label {
    letter-spacing: 0.02em;
  }

  .add-language .caret {
    width: 0;
    height: 0;
    border-left: 3px solid transparent;
    border-right: 3px solid transparent;
    border-top: 4px solid currentColor;
  }

  .add-language[aria-expanded='true'] .caret {
    transform: rotate(180deg);
  }

  .host-prompt {
    gap: 6px;
  }

  .prompt-label {
    font-size: var(--font-xs);
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1.2;
    color: var(--accent);
  }

  .lang-flag {
    display: inline-flex;
    align-items: center;
    line-height: 0;
  }

  button.lang-flag {
    gap: 3px;
    margin: 0;
    padding: 2px 4px 2px 3px;
    border: 1px solid var(--paper-border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--paper-ink);
    cursor: pointer;
  }

  button.lang-flag:hover,
  button.lang-flag[aria-expanded='true'] {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    color: var(--accent);
  }

  button.lang-flag:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  button.lang-flag .caret {
    width: 0;
    height: 0;
    border-left: 3px solid transparent;
    border-right: 3px solid transparent;
    border-top: 4px solid currentColor;
  }

  button.lang-flag[aria-expanded='true'] .caret {
    transform: rotate(180deg);
  }

  .profile-name {
    display: block;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--font-sm);
    color: var(--text-muted);
  }

  .eye-spacer {
    display: inline-block;
    width: 16px;
    height: 16px;
    padding: 1px;
  }
</style>
