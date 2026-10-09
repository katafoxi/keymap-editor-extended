import { expect, type Page, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { editKey, openSource } from './helpers'

const LARK_DIR = path.join(
  process.cwd(),
  'packages/keymap-core/fixtures/lark'
)
const KEYMAP_TEXT = fs.readFileSync(path.join(LARK_DIR, 'lark.keymap'), 'utf8')
const INFO_TEXT = fs.readFileSync(path.join(LARK_DIR, 'info.json'), 'utf8')

const ESC_KEY = '.key[data-label="1,0"]'
const NEW_KEYCODE = 'F13'
const ORIGINAL_BIND = '&kp ESC'
const EDITED_BIND = `&kp ${NEW_KEYCODE}`
const INFERRED_WARNING =
  'No info.json — using a flat rectangular board from the binding count. Paste info.json for the real layout.'
const GARBAGE_KEYMAP = '/* empty */'
const GARBAGE_ERROR = 'No layers with bindings found in .keymap'

function normalizeNewlines(text: string) {
  return text.replace(/\r\n/g, '\n')
}

function preambleBeforeKeymapBlock(source: string) {
  const marker = 'keymap {'
  const idx = source.indexOf(marker)
  if (idx === -1) throw new Error('keymap source has no "keymap {" block')
  return source.slice(0, idx)
}

function layerSlice(source: string, start: string, end: string) {
  return source.slice(source.indexOf(start), source.indexOf(end))
}

function layer0BindingCount(source: string) {
  const slice = layerSlice(source, 'layer_0', 'layer_1')
  const open = slice.indexOf('<')
  const close = slice.lastIndexOf('>')
  if (open === -1 || close <= open) {
    throw new Error('layer_0 has no bindings list')
  }
  return slice
    .slice(open + 1, close)
    .split(/\s+/)
    .filter(token => token.startsWith('&')).length
}

async function openClipboardPicker(page: Page) {
  await openSource(page, 'Clipboard')
  const picker = page.getByRole('dialog', {
    name: /Paste a \.keymap from the clipboard/
  })
  await expect(picker).toBeVisible()
  return picker
}

test.describe('Clipboard source', () => {
  test.beforeEach(async ({ context, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('coachTourDone', '1')
    })
    await page.goto('/')
    await expect(page.getByTestId('source-menu-trigger')).toHaveAccessibleName(
      'Demo keyboard: Corne'
    )
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(page.url()).origin
    })
  })

  test('Copy .keymap splices an edit and keeps the preamble', async ({
    page
  }) => {
    const picker = await openClipboardPicker(page)
    await picker
      .getByRole('textbox', { name: /Paste your board \.keymap/ })
      .fill(KEYMAP_TEXT)
    await picker
      .getByRole('textbox', { name: /rectangular board from binding count/ })
      .fill(INFO_TEXT)
    await picker.getByRole('button', { name: 'Load' }).click()

    await expect(page.getByTestId('source-menu-trigger')).toHaveAccessibleName(
      'Clipboard keyboard: lark'
    )
    await editKey(
      page,
      page.locator(ESC_KEY).getByRole('button', { name: '&kp ESC, layer 0' }),
      NEW_KEYCODE
    )

    const copy = page.getByRole('button', { name: 'Copy .keymap' })
    await expect(copy).toBeEnabled()
    await copy.click()
    const exportDialog = page.getByRole('dialog', { name: 'Exported keymap' })
    await expect(exportDialog).toBeVisible()
    await expect(
      exportDialog.getByRole('status').filter({
        hasText: 'Copied to the system clipboard'
      })
    ).toBeVisible()

    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain(EDITED_BIND)
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(normalizeNewlines(preambleBeforeKeymapBlock(copied))).toBe(
      normalizeNewlines(preambleBeforeKeymapBlock(KEYMAP_TEXT))
    )
    const layer0 = layerSlice(copied, 'layer_0', 'layer_1')
    expect(layer0).toContain(EDITED_BIND)
    expect(layer0).not.toContain(ORIGINAL_BIND)
  })

  test('omitted info.json infers a rectangular board from the binding count', async ({
    page
  }) => {
    const picker = await openClipboardPicker(page)
    await picker
      .getByRole('textbox', { name: /Paste your board \.keymap/ })
      .fill(KEYMAP_TEXT)
    await picker.getByRole('button', { name: 'Load' }).click()

    await expect(page.getByTestId('source-menu-trigger')).toHaveAccessibleName(
      'Clipboard keyboard: clipboard (inferred)'
    )
    await expect(page.getByRole('status')).toContainText(INFERRED_WARNING)
    const bindingCount = layer0BindingCount(KEYMAP_TEXT)
    await expect
      .poll(() => page.getByRole('button', { name: /, layer 0/ }).count())
      .toBe(bindingCount)
  })

  test('Apply preserves an external Unicode binding when another key is edited', async ({ page }) => {
    const source = `#include <behaviors.dtsi>
#include <behaviors/unicode.dtsi>
/ {
  keymap {
    compatible = "zmk,keymap";
    default_layer { bindings = <&uc UC_DE_AE &kp A>; };
  };
};`
    const picker = await openClipboardPicker(page)
    await picker.getByRole('textbox', { name: /Paste your board \.keymap/ }).fill(source)
    await picker.getByRole('button', { name: 'Load' }).click()

    const unicode = page.getByRole('button', { name: '&uc UC_DE_AE, layer 0', exact: true })
    await expect(unicode).toBeVisible()
    await unicode.click()
    const dialog = page.getByRole('dialog', { name: 'Edit key' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await expect(dialog).toBeHidden()
    await expect(unicode).toBeVisible()

    await editKey(page, page.getByRole('button', { name: '&kp A, layer 0', exact: true }), NEW_KEYCODE)
    await page.getByRole('button', { name: 'Copy .keymap' }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(EDITED_BIND)
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain('&uc UC_DE_AE')
    expect(preambleBeforeKeymapBlock(copied)).toBe(preambleBeforeKeymapBlock(source))
  })

  test('garbage keymap shows an error and leaves the board unchanged', async ({
    page
  }) => {
    const corneE = page.getByRole('button', { name: '&kp E, layer 0' })
    await expect(corneE).toBeVisible()

    const picker = await openClipboardPicker(page)
    await picker
      .getByRole('textbox', { name: /Paste your board \.keymap/ })
      .fill(GARBAGE_KEYMAP)
    await picker.getByRole('button', { name: 'Load' }).click()

    await expect(picker.getByRole('alert')).toHaveText(GARBAGE_ERROR)
    await expect(corneE).toBeVisible()
    await expect(page.getByRole('button', { name: 'Copy .keymap' })).toHaveCount(
      0
    )
  })
})
