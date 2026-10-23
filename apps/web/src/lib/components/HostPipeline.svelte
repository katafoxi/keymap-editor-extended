<script lang="ts">
  import { editor } from '../editor.svelte.js'
  import {
    hostLayout,
    hostLegendColumns,
    pairedKbdId,
    unicodeHostLayoutCompatibility,
    windowsCapsPairingRecommended
  } from '@keymap-editor/keymap-core'
  import logoLinux from '../assets/logo-linux.png'
  import logoWindows from '../assets/logo-windows.png'
  import ChromeStatus from './Common/ChromeStatus.svelte'
  import Button from './Common/Button.svelte'
  import LinuxInstallSheet from './LinuxInstallSheet.svelte'
  import WindowsInstallSheet from './WindowsInstallSheet.svelte'
  import { downloadBytes, downloadFileName, downloadText } from '../download'

  type InstallSheet = 'linux' | 'windows' | null

  let sheet = $state<InstallSheet>(null)
  let copyNote = $state('')
  /** Last paired-layout version written for each caps language. The next download uses +1. */
  let pairedVersion = $state<Record<string, number>>({})

  async function copyText(text: string, okMessage: string, markDelivered = false) {
    try {
      await navigator.clipboard.writeText(text)
      copyNote = okMessage
      if (markDelivered) editor.markHostDelivered()
    } catch {
      copyNote = 'Could not copy — select the text manually'
    }
  }

  const dirty = $derived(editor.isHostDirty)
  const hasDeliverable = $derived(editor.hostDeliverableLayoutIds.length > 0)
  /** Quiet first visit: no user layout yet → Ready, not Saved. */
  const statusLabel = $derived(
    dirty ? 'Changed' : hasDeliverable ? 'Saved' : 'Ready'
  )
  const statusTitle = $derived(
    dirty
      ? 'User layout ready to install'
      : hasDeliverable
        ? 'No pending host edits'
        : 'No custom host layout yet — Alt+click a key to edit what the OS types'
  )
  const unicodeKeys = $derived(editor.unicodeKeyCount)
  /** Service cells the base (English) column no longer types, for the keymap's `&uc` keys. */
  const unicodeMissing = $derived.by(() => {
    void editor.hostLayoutRevision
    if (unicodeKeys === 0) return []
    const base = hostLayout(editor.hostLegend.columns[0]?.layoutId ?? '')
    return base ? [...unicodeHostLayoutCompatibility(base).missing] : []
  })
  const unicodeTitle = $derived.by(() => {
    const keys = unicodeKeys === 1 ? '1 key uses' : `${unicodeKeys} keys use`
    return unicodeMissing.length
      ? `${keys} &uc, but the English layout no longer types unshifted ${unicodeMissing.join(', ')}. ` +
          'Those keys type the wrong character until the cells are restored.'
      : `${keys} &uc. Unshifted 0–9, a–f and u in the English layout are reserved for its ` +
          'service sequence; editing them asks first. Press &uc keys with English active.'
  })
  const exports = $derived.by(() => {
    void editor.hostLayoutRevision
    void editor.hostLegend
    return editor.listActiveHostLayoutExports()
  })
  const capsExports = $derived.by(() => {
    void editor.hostLayoutRevision
    void editor.hostLegend
    return editor.listCapsAlphabetKlcExports()
  })
  /** Dense Latin on the board — Caps pairing is not offered; explain separate files. */
  const separateLayoutsNote = $derived.by(() => {
    void editor.hostLegend
    return hostLegendColumns(editor.hostLegend).some(
      column => column.language !== 'en' && !windowsCapsPairingRecommended(column.language)
    )
  })

  function pairedVersionKey(language: string): string {
    return `klc-paired-version:${language}`
  }

  function readPairedVersion(language: string): number {
    try {
      const raw = Number(localStorage.getItem(pairedVersionKey(language)) || '0')
      if (!Number.isInteger(raw) || raw < 1) return 0
      return Math.min(raw, 99)
    } catch {
      return 0
    }
  }

  function upcomingPairedVersion(language: string): number {
    const prev = pairedVersion[language] ?? 0
    return prev >= 99 ? 1 : prev + 1
  }

  function pairedLayoutName(baseName: string, capsName: string, language: string): string {
    return pairedKbdId(baseName, capsName, upcomingPairedVersion(language))
  }

  function openSheet(next: 'linux' | 'windows') {
    copyNote = ''
    if (next === 'windows') {
      const versions: Record<string, number> = {}
      for (const item of editor.listCapsAlphabetKlcExports()) {
        versions[item.capsLanguage] = readPairedVersion(item.capsLanguage)
      }
      pairedVersion = versions
    }
    sheet = next
  }

  function closeSheet() {
    sheet = null
    copyNote = ''
  }

  function downloadSection(text: string, name: string) {
    downloadText(text, downloadFileName(name, 'symbols.txt', 'host-layout'))
    editor.markHostDelivered()
  }

  function downloadKlc(layoutId: string, name: string) {
    const file = editor.exportUserHostLayoutKlc(layoutId)
    if (!file) return
    downloadBytes(file.bytes, downloadFileName(name, 'klc', 'host-layout'))
    editor.markHostDelivered()
  }

  function downloadCapsKlc(item: (typeof capsExports)[number]) {
    const version = upcomingPairedVersion(item.capsLanguage)
    try {
      localStorage.setItem(pairedVersionKey(item.capsLanguage), String(version))
    } catch {
      /* private mode: the file still carries this version */
    }
    pairedVersion = { ...pairedVersion, [item.capsLanguage]: version }
    const file = editor.exportCapsAlphabetKlc(item.capsLanguage, version)
    if (!file) return
    downloadBytes(file.bytes, downloadFileName(file.kbdId, 'klc', 'host-layout'))
    editor.markHostDelivered()
  }

  function downloadAllLinux() {
    const all = editor.exportActiveHostLayoutsXkb()
    if (!all) return
    downloadText(all.text, downloadFileName(all.name, 'symbols.txt', 'host-layout'))
    editor.markHostDelivered()
  }
</script>

<div
  class="host-pipeline"
  class:dirty
  data-host-dirty={dirty ? 'true' : 'false'}
>
  <span
    class="lane-label"
    title="What the OS types — install host layouts on Linux or Windows"
  >Host</span>
  <ChromeStatus dirty={dirty} label={statusLabel} title={statusTitle} />
  {#if unicodeKeys > 0}
    <span
      class="unicode-badge"
      class:broken={unicodeMissing.length > 0}
      data-unicode-host={unicodeMissing.length ? 'incompatible' : 'reserved'}
      role="status"
      aria-label={unicodeTitle}
      title={unicodeTitle}
    >&uc {unicodeMissing.length ? '⚠' : '·'} {unicodeKeys}</span>
  {/if}

  <Button
    variant="softReady"
    class="download"
    ready={dirty}
    aria-label="Install host layout on Linux"
    title="Open Linux install guide"
    onclick={() => openSheet('linux')}
  >
    <img class="os-icon" src={logoLinux} alt="" width="20" height="20" />
    <span class="dl-label">Linux</span>
  </Button>

  <Button
    variant="softReady"
    class="download"
    ready={dirty}
    aria-label="Install host layout on Windows"
    title="Open Windows install guide"
    onclick={() => openSheet('windows')}
  >
    <img class="os-icon" src={logoWindows} alt="" width="20" height="20" />
    <span class="dl-label">Windows</span>
  </Button>
</div>

{#if sheet === 'linux'}
  <LinuxInstallSheet
    {exports}
    {copyNote}
    onCopyText={copyText}
    onDownloadSection={downloadSection}
    onDownloadAll={downloadAllLinux}
    onClose={closeSheet}
  />
{/if}

{#if sheet === 'windows'}
  <WindowsInstallSheet
    {exports}
    {capsExports}
    {separateLayoutsNote}
    {pairedLayoutName}
    onDownloadKlc={downloadKlc}
    onDownloadCapsKlc={downloadCapsKlc}
    onClose={closeSheet}
  />
{/if}

<style>
  .host-pipeline {
    display: flex;
    flex-wrap: nowrap;
    align-items: flex-end;
    gap: 6px 8px;
    margin: 0;
    color: var(--text-muted);
    font-size: var(--font-md);
  }

  .host-pipeline :global(.download) {
    /* Layout extras for softReady OS buttons; colors come from Button. */
    padding: 0 8px 0 6px;
  }

  .unicode-badge {
    align-self: center;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: var(--font-sm);
    white-space: nowrap;
    cursor: help;
  }

  .unicode-badge.broken {
    color: var(--danger-ink);
    background: var(--danger-wash);
    border-color: var(--danger-border);
  }

  .os-icon {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border-radius: 2px;
    object-fit: contain;
  }

  .dl-label {
    white-space: nowrap;
  }
</style>
