<script lang="ts">
  import DialogBox from '../../Common/DialogBox.svelte'
  import Modal from '../../Common/Modal.svelte'

  interface Props {
    onDismiss: () => void
    title: string
    errors: string[]
    /** Repo-relative file. Overrides the title's default caption. */
    path?: string
    otherRepoOrBranchAvailable?: boolean
  }

  let {
    onDismiss,
    title,
    errors,
    path,
    otherRepoOrBranchAvailable = false
  }: Props = $props()

  function fileFromTitle(t: string, explicit?: string) {
    if (explicit) return explicit
    if (t === 'InfoValidationError') return 'config/info.json'
    if (t === 'KeymapValidationError') return 'config/keymap.json'
    return undefined
  }

  const file = $derived(fileFromTitle(title, path))
</script>

<Modal>
  <DialogBox {onDismiss}>
    <h2>{title}</h2>
    {#if file}
      <p>Errors in the file <code>{file}</code>.</p>
    {/if}
    <ul
      style="max-height:300px;overflow:auto;padding:10px;font-family:monospace;font-size:80%;background-color:var(--fill-subtle);"
    >
      {#each errors as error}
        <li style="margin:10px;">{error}</li>
      {/each}
    </ul>

    {#if otherRepoOrBranchAvailable}
      <p>
        If you have another branch or repository the the required metadata files
        you may switch to them instead.
      </p>
    {/if}
  </DialogBox>
</Modal>
