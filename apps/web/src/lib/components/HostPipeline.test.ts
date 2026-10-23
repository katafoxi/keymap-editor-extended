import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addHostLanguage, parseKeyBinding, primarySystemLayoutId } from '@keymap-editor/keymap-core'
import { editor } from '../editor.svelte.js'
import { clearHostLayoutStore } from '../host-layout-store'
import HostPipeline from './HostPipeline.svelte'

describe('HostPipeline', () => {
  let target: HTMLDivElement
  let modalRoot: HTMLDivElement
  let view: ReturnType<typeof mount> | undefined

  beforeEach(async () => {
    editor.resetForTests()
    await clearHostLayoutStore()
    await editor.restoreHostProfiles()
    target = document.createElement('div')
    document.body.appendChild(target)
    modalRoot = document.createElement('div')
    modalRoot.id = 'modal-root'
    document.body.appendChild(modalRoot)
  })

  afterEach(() => {
    if (view) unmount(view)
    view = undefined
    modalRoot.remove()
    target.remove()
    editor.resetForTests()
    vi.restoreAllMocks()
  })

  function mountPipeline() {
    view = mount(HostPipeline, { target })
    flushSync()
  }

  it('keeps OS install buttons available with only system layouts', () => {
    mountPipeline()
    const root = target.querySelector('.host-pipeline')
    expect(root?.getAttribute('data-host-dirty')).toBe('false')
    const hostStatus = root?.querySelector('.chrome-status')
    expect(hostStatus?.textContent?.trim()).toBe('Ready')
    expect(hostStatus?.getAttribute('title')).toBe(
      'No custom host layout yet — Alt+click a key to edit what the OS types'
    )
    expect(hostStatus?.getAttribute('aria-label')).toBe(
      'No custom host layout yet — Alt+click a key to edit what the OS types'
    )
    const buttons = [...target.querySelectorAll('button.download')] as HTMLButtonElement[]
    expect(buttons).toHaveLength(2)
    expect(buttons.every(button => !button.disabled)).toBe(true)
    expect(buttons.map(button => button.title)).toEqual([
      'Open Linux install guide',
      'Open Windows install guide'
    ])
    expect(buttons.every(button => button.classList.contains('ready'))).toBe(false)

    buttons[0].click()
    flushSync()
    const dialog = document.querySelector('[aria-labelledby="linux-install-title"]')
    expect(dialog).toBeInstanceOf(HTMLElement)
    expect(dialog?.textContent).toMatch(/No custom host layout yet/)
    expect(dialog?.querySelectorAll('section.layout-card')).toHaveLength(0)
  })

  it('highlights OS buttons after a host key edit forks a user layout', async () => {
    mountPipeline()
    await editor.setHostKeyLevel('en', 'A', 0, 'b')
    flushSync()

    const root = target.querySelector('.host-pipeline')
    expect(root?.getAttribute('data-host-dirty')).toBe('true')
    expect(root?.querySelector('.chrome-status')?.textContent?.trim()).toBe('Changed')
    expect(root?.querySelector('.chrome-status')?.getAttribute('title')).toBe(
      'User layout ready to install'
    )
    const buttons = [...target.querySelectorAll('button.download')] as HTMLButtonElement[]
    expect(buttons.every(button => !button.disabled)).toBe(true)
    expect(buttons.every(button => button.classList.contains('ready'))).toBe(true)
    expect(buttons.map(button => button.title)).toEqual([
      'Open Linux install guide',
      'Open Windows install guide'
    ])
    expect(editor.activeProfileId('en')).not.toBe(primarySystemLayoutId('en')!)
  })

  it('shows an &uc badge that turns broken when an English service cell is remapped', async () => {
    mountPipeline()
    expect(target.querySelector('.unicode-badge')).toBeNull()

    editor.draftKeymap = {
      layer_names: ['default'],
      layers: [[parseKeyBinding('&uc UC_DE_AE'), parseKeyBinding('&uc 0xE4 0')]]
    }
    flushSync()
    const badge = () => target.querySelector<HTMLElement>('.unicode-badge')
    expect(badge()?.dataset.unicodeHost).toBe('reserved')
    expect(badge()?.textContent).toContain('2')
    expect(badge()?.title).toMatch(/reserved/)

    await editor.setHostKeyLevel('en', 'N1', 0, '!')
    flushSync()
    expect(badge()?.dataset.unicodeHost).toBe('incompatible')
    expect(badge()?.title).toMatch(/no longer types unshifted 1/)
  })

  it('opens a Linux install dialog with copy/download actions', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:host-test')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL
    })
    const click = vi.fn()
    const originalCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreate(tag)
      if (tag === 'a') {
        Object.defineProperty(el, 'click', { value: click })
      }
      return el
    })

    mountPipeline()
    await editor.setHostKeyLevel('en', 'A', 0, 'b')
    flushSync()

    const linux = target.querySelector(
      'button.download[aria-label="Install host layout on Linux"]'
    ) as HTMLButtonElement
    linux.click()
    flushSync()

    const dialog = document.querySelector('[aria-labelledby="linux-install-title"]')
    expect(dialog).toBeInstanceOf(HTMLElement)
    expect(dialog?.textContent).toMatch(/xkb_symbols/)
    const pathInput = dialog?.querySelector('input.path-input')
    expect(pathInput).toBeInstanceOf(HTMLInputElement)
    expect((pathInput as HTMLInputElement).value).toContain('/usr/share/X11/xkb/symbols/au')
    expect(dialog?.textContent).toMatch(/Australia/)
    expect(dialog?.textContent).toMatch(/sudo/)
    expect(dialog?.querySelectorAll('section.layout-card')).toHaveLength(1)

    const downloadBtn = [...(dialog?.querySelectorAll('button') ?? [])].find(
      button => button.textContent?.trim() === 'Download file'
    )
    expect(downloadBtn).toBeInstanceOf(HTMLButtonElement)
    ;(downloadBtn as HTMLButtonElement).click()
    flushSync()

    expect(createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob
    expect(await blob.text()).toContain('xkb_symbols')
    expect(editor.isHostDirty).toBe(false)
    expect(rootStatus()).toBe('Saved')
  })

  function rootStatus() {
    return target.querySelector('.host-pipeline .chrome-status')?.textContent?.trim()
  }

  it('shows a Russian layout card only when Russian host work is dirty', async () => {
    mountPipeline()
    await editor.setHostKeyLevel('en', 'A', 0, 'b')
    flushSync()

    const linux = target.querySelector(
      'button.download[aria-label="Install host layout on Linux"]'
    ) as HTMLButtonElement
    linux.click()
    flushSync()
    expect(document.querySelectorAll('section.layout-card')).toHaveLength(1)

    document.querySelector('.dialog-foot button')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    )
    flushSync()

    await editor.commitHostMap(addHostLanguage(editor.hostLegend, 'ru'))
    await editor.setHostKeyLevel('ru', 'A', 0, 'ф')
    flushSync()
    linux.click()
    flushSync()

    const cards = document.querySelectorAll('section.layout-card')
    expect(cards.length).toBe(2)
    const tips = [...cards].map(card => card.querySelector('.card-tip')?.textContent ?? '')
    expect(tips.some(tip => /legacy/.test(tip))).toBe(true)
  })

  it('opens a Windows install dialog with an MSKLC link and a .klc download', async () => {
    mountPipeline()
    await editor.setHostKeyLevel('en', 'A', 0, 'b')
    flushSync()

    const windows = target.querySelector(
      'button.download[aria-label="Install host layout on Windows"]'
    ) as HTMLButtonElement
    windows.click()
    flushSync()

    const dialog = document.querySelector('[aria-labelledby="windows-install-title"]')
    expect(dialog).toBeInstanceOf(HTMLElement)
    expect(dialog?.querySelector('a[href*="microsoft.com"]')).toBeInstanceOf(HTMLAnchorElement)
    const klc = [...(dialog?.querySelectorAll('button') ?? [])].find(
      button => button.textContent?.trim() === 'Download .klc'
    )
    expect(klc).toBeInstanceOf(HTMLButtonElement)
    expect((klc as HTMLButtonElement).disabled).toBe(false)
    expect(dialog?.querySelector('#windows-paired-title')).toBeNull()
  })

  it('does not offer Caps Lock pairing for French and explains separate layouts', async () => {
    mountPipeline()
    await editor.commitHostMap(addHostLanguage(editor.hostLegend, 'fr'))
    await editor.setHostKeyLevel('en', 'A', 0, 'b')
    flushSync()

    const windows = target.querySelector(
      'button.download[aria-label="Install host layout on Windows"]'
    ) as HTMLButtonElement
    windows.click()
    flushSync()
    const dialog = document.querySelector('[aria-labelledby="windows-install-title"]')
    expect(dialog?.querySelector('#windows-paired-title')).toBeNull()
    expect(dialog?.textContent).toMatch(/Caps Lock pairing with English does not fit/)
    expect(dialog?.textContent).toMatch(/Win\+Space/)
    expect(dialog?.textContent).toMatch(/One language per file/)
    const combined = [...(dialog?.querySelectorAll('button') ?? [])].find(button =>
      button.textContent?.includes('English + French')
    )
    expect(combined).toBeUndefined()
  })

  it('explains a Caps Lock alphabet and downloads that .klc when another language is shown', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:caps-klc')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL
    })
    const click = vi.fn()
    const originalCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreate(tag)
      if (tag === 'a') {
        Object.defineProperty(el, 'click', { value: click })
      }
      return el
    })

    mountPipeline()
    await editor.commitHostMap(addHostLanguage(editor.hostLegend, 'ru'))
    await editor.setHostKeyLevel('en', 'A', 0, 'b')
    flushSync()

    localStorage.removeItem('klc-paired-version:ru')
    const windows = target.querySelector(
      'button.download[aria-label="Install host layout on Windows"]'
    ) as HTMLButtonElement
    windows.click()
    flushSync()
    const dialog = document.querySelector('[aria-labelledby="windows-install-title"]')
    expect(dialog?.textContent).toMatch(/Two alphabets in one layout/)
    expect(dialog?.textContent).toMatch(/at most 8 letters and digits/)
    expect(dialog?.textContent).toMatch(/language.s\s+keyboard list/)
    expect(dialog?.textContent).toMatch(/English keyboard list/)
    expect(dialog?.textContent).toMatch(/If the previous characters are still there, reboot/)
    expect(dialog?.textContent).toMatch(/Layout name EngRus01/)
    expect(dialog?.textContent).toMatch(/GIMP/)
    expect(dialog?.textContent).toMatch(/Caps Lock switches alphabet/)
    expect(dialog?.textContent).toMatch(/AltGr and AltGr\+Shift come from the other language/)
    expect(dialog?.textContent).toMatch(/Russian, Ukrainian, or Bulgarian/)
    expect(dialog?.textContent).toMatch(/One language per file/)
    const separate = [...(dialog?.querySelectorAll('button') ?? [])].find(
      button => button.textContent?.trim() === 'Download .klc'
    )
    expect(separate).toBeInstanceOf(HTMLButtonElement)

    const combined = [...(dialog?.querySelectorAll('button') ?? [])].find(button =>
      button.textContent?.includes('English + Russian')
    )
    expect(combined).toBeInstanceOf(HTMLButtonElement)
    ;(combined as HTMLButtonElement).click()
    flushSync()

    expect(click).toHaveBeenCalled()
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(bytes[0]).toBe(0xff)
    expect(bytes[1]).toBe(0xfe)
    const text = new TextDecoder('utf-16le').decode(bytes.subarray(2))
    expect(text).toContain('LOCALEID\t"00000409"')
    expect(text).toContain('KBD\tEngRus01\t"English + Russian"')
    expect(text).toContain('SGCap')
    expect(localStorage.getItem('klc-paired-version:ru')).toBe('1')
    expect(text).toContain('0439')
  })
})
