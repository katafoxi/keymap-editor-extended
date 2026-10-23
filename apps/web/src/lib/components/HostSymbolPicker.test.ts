import {
  addHostLanguage,
  hostSymbolShelves,
  hostLayout,
  primarySystemLayoutId,
  type HostLanguageId
} from '@keymap-editor/keymap-core'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editor } from '../editor.svelte.js'
import { clearHostLayoutStore } from '../host-layout-store'
import HostSymbolCatalog from './HostSymbolCatalog.svelte'
import HostSymbolPicker from './HostSymbolPicker.svelte'
import {
  hostSymbolExpandedByLanguage,
  hostSymbolPickerFrame,
  placePickerClearOf
} from './host-symbol-geometry'
import Harness from './Keyboard/Keys/KeyHarness.svelte'

function stackRows(): HTMLButtonElement[] {
  return [...document.querySelectorAll('.layer-stack button.layer-slot')].filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement
  )
}

function catalog(): HTMLElement | null {
  return document.querySelector('[role="dialog"][aria-label="Host symbol catalog"]')
}

function openDecodeCell(levelLabel = 'Edit English tap'): HTMLButtonElement {
  const row = stackRows()[0]
  row.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true })
  )
  flushSync()
  const slot = [...document.querySelectorAll('.legend-decode .row.current button.slot')].find(
    el => el.getAttribute('aria-label') === levelLabel
  )
  if (!(slot instanceof HTMLButtonElement)) {
    throw new Error(`missing cell ${levelLabel}`)
  }
  slot.click()
  flushSync()
  return slot
}

describe('HostSymbolPicker', () => {
  let target: HTMLDivElement
  let modalRoot: HTMLDivElement
  let view: ReturnType<typeof mount> | undefined

  beforeEach(async () => {
    editor.resetForTests()
    hostSymbolExpandedByLanguage.clear()
    hostSymbolPickerFrame.geometry = null
    await clearHostLayoutStore()
    target = document.createElement('div')
    document.body.appendChild(target)
    modalRoot = document.createElement('div')
    modalRoot.id = 'modal-root'
    target.appendChild(modalRoot)
  })

  afterEach(() => {
    if (view) unmount(view)
    view = undefined
    modalRoot?.remove()
    target?.remove()
    editor.resetForTests()
    hostSymbolExpandedByLanguage.clear()
    hostSymbolPickerFrame.geometry = null
    vi.restoreAllMocks()
  })

  function mountPicker(
    language: HostLanguageId = 'en',
    handlers: { onPick?: (text: string) => void } = {}
  ) {
    const onPick = handlers.onPick ?? vi.fn()
    view = mount(HostSymbolPicker, {
      target,
      props: {
        language,
        onPick
      }
    })
    flushSync()
    return { onPick }
  }

  it('renders open shelves and keeps collapsed glyphs out of the tree until expanded', () => {
    mountPicker('en')
    const dialog = catalog()
    expect(dialog).toBeInstanceOf(HTMLElement)

    const shelves = hostSymbolShelves('en')
    const openIds = shelves.filter(shelf => shelf.open).map(shelf => shelf.id)
    const collapsed = shelves.find(shelf => !shelf.open)
    expect(collapsed).toBeDefined()
    if (!collapsed) throw new Error('expected a collapsed shelf')

    for (const id of openIds) {
      expect(dialog?.querySelector(`[data-shelf="${id}"][data-open="true"]`)).toBeInstanceOf(
        HTMLElement
      )
    }

    const sample = collapsed.entries[0]
    expect(sample).toBeDefined()
    const label = sample.dead
      ? `Dead key ${sample.glyph} ${sample.keysym}`
      : sample.glyph
        ? `${sample.glyph} ${sample.keysym}`
        : sample.keysym
    expect(
      dialog?.querySelector(`button.glyph[aria-label="${CSS.escape(label)}"]`)
    ).toBeNull()

    const toggle = dialog?.querySelector(
      `[data-shelf="${collapsed.id}"] .shelf-toggle`
    ) as HTMLButtonElement | null
    expect(toggle).toBeInstanceOf(HTMLButtonElement)
    toggle?.click()
    flushSync()

    expect(
      dialog?.querySelector(`button.glyph[aria-label="${CSS.escape(label)}"]`)
    ).toBeInstanceOf(HTMLButtonElement)
  })

  it('picks a glyph value and a modifier keysym name', () => {
    const { onPick } = mountPicker('en')
    const dialog = catalog()
    const glyph = dialog?.querySelector('button.glyph[aria-label="a a"]')
    expect(glyph).toBeInstanceOf(HTMLButtonElement)
    ;(glyph as HTMLButtonElement).click()
    flushSync()
    expect(onPick).toHaveBeenCalledWith('a')

    const noSymbol = dialog?.querySelector('button.glyph[aria-label="NoSymbol"]')
    expect(noSymbol).toBeInstanceOf(HTMLButtonElement)
    ;(noSymbol as HTMLButtonElement).click()
    flushSync()
    expect(onPick).toHaveBeenCalledWith('NoSymbol')
  })

  it('picks dead accents by keysym, not the spacing glyph', () => {
    const { onPick } = mountPicker('fr')
    const dialog = catalog()
    const dead = dialog?.querySelector(
      'button.glyph[aria-label="Dead key ^ dead_circumflex"]'
    )
    expect(dead).toBeInstanceOf(HTMLButtonElement)
    ;(dead as HTMLButtonElement).click()
    flushSync()
    expect(onPick).toHaveBeenCalledWith('dead_circumflex')
  })

  it('keeps an expanded collapsed shelf after remount', () => {
    mountPicker('en')
    const collapsed = hostSymbolShelves('en').find(shelf => !shelf.open)
    expect(collapsed).toBeDefined()
    if (!collapsed) throw new Error('expected a collapsed shelf')
    const toggle = catalog()?.querySelector(
      `[data-shelf="${collapsed.id}"] .shelf-toggle`
    ) as HTMLButtonElement
    toggle.click()
    flushSync()
    if (view) unmount(view)
    view = undefined
    flushSync()

    mountPicker('en')
    expect(
      catalog()?.querySelector(`[data-shelf="${collapsed.id}"][data-open="true"]`)
    ).toBeInstanceOf(HTMLElement)
  })
})

describe('LegendDecodeCard host symbol catalog', () => {
  let target: HTMLDivElement
  let modalRoot: HTMLDivElement
  let view: ReturnType<typeof mount> | undefined
  let catalogView: ReturnType<typeof mount> | undefined

  beforeEach(async () => {
    editor.resetForTests()
    hostSymbolExpandedByLanguage.clear()
    hostSymbolPickerFrame.geometry = null
    await clearHostLayoutStore()
    target = document.createElement('div')
    document.body.appendChild(target)
    modalRoot = document.createElement('div')
    modalRoot.id = 'modal-root'
    target.appendChild(modalRoot)
    catalogView = mount(HostSymbolCatalog, {
      target
    })
  })

  afterEach(() => {
    if (view) unmount(view)
    view = undefined
    if (catalogView) unmount(catalogView)
    catalogView = undefined
    modalRoot?.remove()
    target?.remove()
    editor.resetForTests()
    hostSymbolExpandedByLanguage.clear()
    hostSymbolPickerFrame.geometry = null
  })

  function openKey(code = 'A') {
    view = mount(Harness, {
      target,
      props: {
        value: '&kp',
        params: [{ value: code, params: [] }],
        layerBindings: [{ value: '&kp', params: [{ value: code, params: [] }] }]
      }
    })
    flushSync()
  }

  it('opens a catalog dialog from a level cell without a text field', async () => {
    openKey('A')
    await editor.selectLanguageProfile('en', primarySystemLayoutId('en')!)
    flushSync()
    openDecodeCell('Edit English tap')

    expect(catalog()).toBeInstanceOf(HTMLElement)
    expect(document.querySelector('.cell-input')).toBeNull()
    expect(document.querySelector('[role="dialog"].legend-decode')).toBeInstanceOf(HTMLElement)
    expect(editor.hostSymbolEditTarget).toEqual({ language: 'en', zmk: 'A', level: 0 })
  })

  it('asks before breaking a cell the keymap’s &uc keys need', async () => {
    openKey('A')
    await editor.selectLanguageProfile('en', primarySystemLayoutId('en')!)
    editor.draftKeymap = {
      layer_names: ['default'],
      layers: [[{ value: '&uc', params: [{ value: 'UC_DE_AE', params: [] }] }]]
    }
    flushSync()
    openDecodeCell('Edit English tap')
    const card = () => document.querySelector('.legend-decode')
    expect(card()?.querySelector('[data-unicode-guard="note"]')?.textContent).toMatch(
      /Reserved for 1 &uc key: keep unshifted “a”/
    )

    await editor.pickHostSymbol('α')
    flushSync()
    expect(card()?.querySelector('[data-unicode-guard="confirm"]')?.textContent).toMatch(/type unshifted “a”/)
    expect(hostLayout(editor.activeProfileId('en'))?.byZmk.get('A')?.glyphs[0]).toBe('a')

    ;(card()?.querySelector('[data-unicode-keep]') as HTMLElement).click()
    flushSync()
    expect(card()?.querySelector('[data-unicode-guard="confirm"]')).toBeNull()

    await editor.pickHostSymbol('α')
    flushSync()
    ;(card()?.querySelector('[data-unicode-override]') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(hostLayout(editor.activeProfileId('en'))?.byZmk.get('A')?.glyphs[0]).toBe('α')
    })
  })

  it('arms AltGr by default when the host-edit session opens', async () => {
    openKey('A')
    await editor.selectLanguageProfile('en', primarySystemLayoutId('en')!)
    flushSync()
    const row = stackRows()[0]
    row.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true })
    )
    flushSync()
    expect(editor.hostSymbolEditTarget).toEqual({ language: 'en', zmk: 'A', level: 2 })
    expect(catalog()?.querySelector('button.clear-slot')).toBeInstanceOf(HTMLButtonElement)
    expect(catalog()?.querySelector('.nav-hint')?.textContent).toMatch(/Tab/)
    expect(catalog()?.querySelector('[data-shelf]')?.getAttribute('data-shelf')).toBe('signs')
  })

  it('advances across languages after a pick and after Clear', async () => {
    openKey('G')
    editor.hostLegend = addHostLanguage(editor.hostLegend, 'ru')
    flushSync()
    const row = stackRows()[0]
    row.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true })
    )
    flushSync()
    expect(editor.hostSymbolEditTarget).toEqual({ language: 'ru', zmk: 'G', level: 2 })

    await editor.pickHostSymbol('α')
    flushSync()
    expect(editor.hostSymbolEditTarget).toEqual({ language: 'en', zmk: 'G', level: 2 })

    ;(catalog()?.querySelector('button.clear-slot') as HTMLElement | null)?.click()
    flushSync()
    await vi.waitFor(() => {
      expect(editor.hostSymbolEditTarget).toEqual({ language: 'ru', zmk: 'G', level: 3 })
    })
    expect(hostLayout(editor.activeProfileId('en'))?.byZmk.get('G')?.keysyms[2]).toBe(
      'NoSymbol'
    )
  })

  it('moves the armed cell with Tab without writing', async () => {
    openKey('A')
    await editor.selectLanguageProfile('en', primarySystemLayoutId('en')!)
    flushSync()
    const row = stackRows()[0]
    row.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true })
    )
    flushSync()
    expect(editor.hostSymbolEditTarget).toEqual({ language: 'en', zmk: 'A', level: 2 })
    const before = hostLayout(editor.activeProfileId('en'))?.byZmk.get('A')?.keysyms.slice()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    )
    flushSync()
    expect(editor.hostSymbolEditTarget).toEqual({ language: 'en', zmk: 'A', level: 3 })
    expect(hostLayout(editor.activeProfileId('en'))?.byZmk.get('A')?.keysyms).toEqual(before)

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    flushSync()
    expect(editor.hostSymbolEditTarget).toEqual({ language: 'en', zmk: 'A', level: 2 })
  })

  it('lets Tab from a glyph reach the next glyph without stepping the armed level', async () => {
    openKey('A')
    await editor.selectLanguageProfile('en', primarySystemLayoutId('en')!)
    flushSync()
    const row = stackRows()[0]
    row.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true })
    )
    flushSync()
    const level = editor.hostSymbolEditTarget?.level
    const glyphs = [...(catalog()?.querySelectorAll('button.glyph') ?? [])].filter(
      (el): el is HTMLButtonElement => el instanceof HTMLButtonElement && !el.disabled
    )
    expect(glyphs.length).toBeGreaterThan(1)
    glyphs[0].focus()
    flushSync()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    glyphs[0].dispatchEvent(tab)
    flushSync()
    expect(tab.defaultPrevented).toBe(false)
    expect(editor.hostSymbolEditTarget?.level).toBe(level)
    if (document.activeElement === glyphs[0]) glyphs[1].focus()
    expect(document.activeElement).toBe(glyphs[1])
  })

  it('applies an open-shelf glyph through setHostKeyLevel and keeps the catalog open', async () => {
    openKey('A')
    await editor.selectLanguageProfile('en', primarySystemLayoutId('en')!)
    flushSync()
    openDecodeCell('Edit English tap')

    const glyph = catalog()?.querySelector('button.glyph[aria-label="b b"]')
    expect(glyph).toBeInstanceOf(HTMLButtonElement)
    expect((glyph as HTMLButtonElement).disabled).toBe(false)
    ;(glyph as HTMLButtonElement).click()
    flushSync()
    await vi.waitFor(() => {
      const layoutId = editor.activeProfileId('en')
      expect(hostLayout(layoutId)?.byZmk.get('A')?.keysyms[0]).toBe('b')
    })
    expect(catalog()).toBeInstanceOf(HTMLElement)
  })

  it('clears a level when NoSymbol is chosen from modifiers', async () => {
    openKey('A')
    await editor.selectLanguageProfile('en', primarySystemLayoutId('en')!)
    flushSync()
    await editor.setHostKeyLevel('en', 'A', 1, 'B')
    flushSync()

    openDecodeCell('Edit English ⇧')
    const noSymbol = catalog()?.querySelector('button.glyph[aria-label="NoSymbol"]')
    expect(noSymbol).toBeInstanceOf(HTMLButtonElement)
    ;(noSymbol as HTMLButtonElement).click()
    flushSync()
    await vi.waitFor(() => {
      const layoutId = editor.activeProfileId('en')
      expect(hostLayout(layoutId)?.byZmk.get('A')?.keysyms[1]).toBe('NoSymbol')
    })
    expect(catalog()).toBeInstanceOf(HTMLElement)
  })

  it('closes the catalog on Escape and ends the host-edit session', async () => {
    openKey('A')
    await editor.selectLanguageProfile('en', primarySystemLayoutId('en')!)
    flushSync()
    openDecodeCell('Edit English tap')
    expect(catalog()).toBeInstanceOf(HTMLElement)
    expect(editor.hostEditSession).not.toBeNull()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    flushSync()
    await vi.waitFor(() => expect(catalog()).toBeNull())

    expect(editor.hostSymbolCatalogOpen).toBe(false)
    expect(editor.hostEditSession).toBeNull()
    expect(document.querySelector('.legend-decode')).toBeNull()
  })
})

describe('placePickerClearOf', () => {
  const view = { width: 1400, height: 900 }
  const card = { left: 29, top: 319, width: 227, height: 177 }

  function overlaps(a: typeof card, b: typeof card): boolean {
    const gap = 8
    return (
      a.left < b.left + b.width + gap &&
      a.left + a.width + gap > b.left &&
      a.top < b.top + b.height + gap &&
      a.top + a.height + gap > b.top
    )
  }

  it('moves a catalog that only invades the gutter', () => {
    expect(
      placePickerClearOf({ left: 263, top: 227, width: 560, height: 394 }, card, view)
    ).toEqual({ left: 264, top: 227, width: 560, height: 394 })
  })

  it('leaves a catalog that already clears the card', () => {
    const picker = { left: 400, top: 40, width: 560, height: 394 }
    expect(placePickerClearOf(picker, card, view)).toEqual(picker)
  })

  it('steps to the right of a card it covers on the left', () => {
    const next = placePickerClearOf({ left: 20, top: 300, width: 560, height: 394 }, card, view)
    expect(next.left).toBe(29 + 227 + 8)
    expect(overlaps(next, card)).toBe(false)
  })

  it('steps to the left when the card is against the right edge', () => {
    const rightCard = { left: 1100, top: 200, width: 227, height: 177 }
    const next = placePickerClearOf(
      { left: 700, top: 180, width: 560, height: 394 },
      rightCard,
      view
    )
    expect(next.left + next.width).toBeLessThanOrEqual(1100 - 8)
    expect(overlaps(next, rightCard)).toBe(false)
  })

  it('stacks clear of the card when neither side fits', () => {
    const narrow = { width: 400, height: 900 }
    const mid = { left: 80, top: 400, width: 227, height: 177 }
    const next = placePickerClearOf({ left: 8, top: 40, width: 560, height: 300 }, mid, narrow)
    expect(overlaps(next, mid)).toBe(false)
    expect(next.width).toBeGreaterThanOrEqual(240)
    expect(next.height).toBeGreaterThanOrEqual(180)
  })
})
