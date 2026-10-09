import { encodeKeyBinding, parseKeyBinding, type KeyBindingNode } from '@keymap-editor/keymap-core'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UnicodePicker from './UnicodePicker.svelte'

let target: HTMLDivElement
let view: ReturnType<typeof mount> | undefined
const change = vi.fn<(binding: KeyBindingNode | null) => void>()

function open(code = '&uc') {
  change.mockClear()
  target = document.createElement('div')
  document.body.appendChild(target)
  view = mount(UnicodePicker, { target, props: { value: parseKeyBinding(code), onChange: change } })
  flushSync()
}
function input(label: string, value: string) {
  const field = target.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
  flushSync()
}
function lastBinding() {
  const binding = change.mock.calls.at(-1)?.[0]
  return binding ? encodeKeyBinding(binding) : null
}

afterEach(() => {
  if (view) unmount(view)
  view = undefined
  target?.remove()
})

describe('UnicodePicker', () => {
  it('creates a normal and Shift character pair with glyph previews', () => {
    open()
    input('Normal Unicode character or code point', 'ä')
    input('Shift Unicode character or code point', 'Ä')
    expect(lastBinding()).toBe('&uc 0xE4 0xC4')
    expect(target.textContent).toContain('ä')
    expect(target.textContent).toContain('Ä')
  })

  it('blocks surrogate and out-of-range input without clamping', () => {
    open('&uc 0xE4 0')
    input('Normal Unicode character or code point', 'U+D800')
    expect(lastBinding()).toBeNull()
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('surrogates')
  })

  it('selects an upstream alias without rewriting it into numeric cells', () => {
    open()
    input('Filter Unicode aliases', 'UC_DE_OE')
    target.querySelector<HTMLButtonElement>('[data-unicode-alias="UC_DE_OE"]')!.click()
    flushSync()
    expect(lastBinding()).toBe('&uc UC_DE_OE')
  })

  it('creates an input mode switch rather than treating the sentinel as a glyph', () => {
    open()
    target.querySelector<HTMLButtonElement>('[data-unicode-kind="mode"]')!.click()
    flushSync()
    const select = target.querySelector<HTMLSelectElement>('select[aria-label="Unicode input mode"]')!
    select.value = 'UC_SET_LINUX'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()
    expect(lastBinding()).toBe('&uc UC_SET_LINUX')
  })

  it('preserves unresolved expressions unless the user explicitly replaces them', () => {
    open('&uc UC_EXTERNAL_NAME')
    expect(lastBinding()).toBe('&uc UC_EXTERNAL_NAME')
    expect(target.textContent).toContain('kept unchanged')
  })
})
