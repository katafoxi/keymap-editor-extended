import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { openSource, skipCoachAndOpenEditor } from './helpers'

const SOURCE = `#define USER_SETTING 1
#include <behaviors.dtsi>
/ {
  keymap {
    compatible = "zmk,keymap";
    default_layer { bindings = <&kp A &kp B>; };
  };
};`

async function load(page: Page, source = SOURCE) {
  await openSource(page, 'Clipboard')
  const picker = page.getByRole('dialog', { name: /Paste a \.keymap from the clipboard/ })
  await picker.getByRole('textbox', { name: /Paste your board \.keymap/ }).fill(source)
  await picker.getByRole('button', { name: 'Load' }).click()
}
async function editUnicode(page: Page) {
  await page.getByRole('button', { name: '&kp A, layer 0', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit key' })
  await dialog.getByRole('button', { name: '&uc', exact: true }).click()
  return dialog
}
async function copy(page: Page, expected: string) {
  await page.getByRole('button', { name: 'Copy .keymap' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(expected)
  const text = await page.evaluate(() => navigator.clipboard.readText())
  expect(text).toContain('#define USER_SETTING 1')
  expect(text.match(/#include <behaviors\/unicode\.dtsi>/g)).toHaveLength(1)
  return text
}

test.beforeEach(async ({ page, context }) => {
  await skipCoachAndOpenEditor(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
  await load(page)
})

test('Unicode picker validates scalars and copies a normal/Shift pair', async ({ page }) => {
  const dialog = await editUnicode(page)
  const normal = dialog.getByRole('textbox', { name: 'Normal Unicode character or code point' })
  await normal.fill('U+D800')
  await expect(dialog.getByRole('button', { name: 'Enter valid Unicode input' })).toBeDisabled()
  await expect(dialog.getByRole('alert')).toContainText('surrogates')
  await normal.fill('ä')
  await dialog.getByRole('textbox', { name: 'Shift Unicode character or code point' }).fill('Ä')
  await expect(dialog.getByLabel('Unicode character preview')).toHaveText('Normal: ä · Shift: Ä')
  await page.screenshot({ path: path.join(process.env.TMPDIR!, 'unicode-picker.png') })
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('button', { name: '&uc 0xE4 0xC4, layer 0', exact: true })).toBeVisible()
  await copy(page, '&uc 0xE4 0xC4')
})

test('Unicode picker selects an upstream alias', async ({ page }) => {
  const dialog = await editUnicode(page)
  await dialog.getByRole('searchbox', { name: 'Filter Unicode aliases' }).fill('UC_DE_OE')
  await dialog.locator('[data-unicode-alias="UC_DE_OE"]').click()
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  await copy(page, '&uc UC_DE_OE')
})

test('Unicode picker writes an input-mode switch without changing default-mode', async ({ page }) => {
  const dialog = await editUnicode(page)
  await dialog.getByRole('button', { name: 'Input mode switch' }).click()
  await dialog.getByRole('combobox', { name: 'Unicode input mode' }).selectOption('UC_SET_LINUX')
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  const text = await copy(page, '&uc UC_SET_LINUX')
  expect(text).not.toContain('default-mode')
})

test('Unicode picker Cancel does not replace the original binding', async ({ page }) => {
  const dialog = await editUnicode(page)
  await dialog.getByRole('textbox', { name: 'Normal Unicode character or code point' }).fill('😀')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: '&kp A, layer 0', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Copy .keymap' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('&kp A')
  const text = await page.evaluate(() => navigator.clipboard.readText())
  expect(text).not.toContain('&uc')
  expect(text).not.toContain('behaviors/unicode.dtsi')
})
