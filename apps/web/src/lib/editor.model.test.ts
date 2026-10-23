/**
 * Model-based tests for EditorState: random command sequences must keep
 * layer indexes, combo filters, history, and discard/undo in range.
 */

import {
  cloneParsedKeymap,
  diffKeymaps,
  keymapsAreEqual,
  toggleShownLayer,
  type KeyBindingNode,
  type ParsedKeymap,
  type ZmkCombo,
  type ZmkConditionalLayer
} from '@keymap-editor/keymap-core'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { editor } from './editor.svelte.js'
import { HISTORY_LIMIT } from './editor/types.js'

const NUM_RUNS = 50
const FC = { numRuns: NUM_RUNS }

const trans: KeyBindingNode = { value: '&trans', params: [] }
const esc: KeyBindingNode = {
  value: '&kp',
  params: [{ value: 'ESC', params: [] }]
}
const vol: KeyBindingNode = {
  value: '&inc_dec_kp',
  params: [
    { value: 'C_VOL_UP', params: [] },
    { value: 'C_VOL_DN', params: [] }
  ]
}

function kp(code: string): KeyBindingNode {
  return { value: '&kp', params: [{ value: code, params: [] }] }
}

function mo(layer: number): KeyBindingNode {
  return { value: '&mo', params: [{ value: String(layer), params: [] }] }
}

function fixtureLayout() {
  return [
    { x: 0, y: 0, row: 0, col: 0 },
    { x: 1, y: 0, row: 0, col: 1 },
    { x: 2, y: 0, row: 0, col: 2 }
  ]
}

/** Four layers, a combo filter, a conditional-layer rule, and encoders. */
function fixtureKeymap(): ParsedKeymap {
  return {
    keyboard: 'model',
    layer_names: ['Base', 'Lower', 'Raise', 'Adjust'],
    layers: [
      [mo(2), kp('A'), trans],
      [kp('B'), trans, trans],
      [kp('C'), trans, trans],
      [kp('D'), trans, trans]
    ],
    combos: [
      {
        id: 'combo_raise',
        keyPositions: [0, 1],
        binding: esc,
        layers: [3]
      }
    ],
    conditionalLayers: [{ id: 'adjust_when_lr', ifLayers: [1, 2], thenLayer: 3 }],
    sensorBindings: [[vol], [vol], [vol], [vol]]
  }
}

async function selectFixture() {
  editor.resetForTests()
  await editor.selectKeyboard({
    source: 'local',
    layout: fixtureLayout(),
    keymap: fixtureKeymap()
  })
}

type Model = {
  layerCount: number
  keyCount: number
  sensorSlots: number
  comboIds: string[]
  undoLen: number
  redoLen: number
}

function captureModel(m: Model, real: typeof editor) {
  const draft = real.draftKeymap!
  m.layerCount = draft.layers.length
  m.keyCount = real.layout?.length ?? 0
  m.sensorSlots = draft.sensorBindings?.[0]?.length ?? 0
  m.comboIds = (draft.combos ?? []).map(c => c.id)
  m.undoLen = real.undoStack.length
  m.redoLen = real.redoStack.length
}

function freshModel(): Model {
  const m: Model = {
    layerCount: 0,
    keyCount: 0,
    sensorSlots: 0,
    comboIds: [],
    undoLen: 0,
    redoLen: 0
  }
  captureModel(m, editor)
  return m
}

function assertInvariants(real: typeof editor, lastWasEdit: boolean) {
  const draft = real.draftKeymap
  const layout = real.layout
  const baseline = real.baselineKeymap
  expect(draft).toBeTruthy()
  expect(layout).toBeTruthy()
  expect(baseline).toBeTruthy()
  const n = draft!.layers.length
  expect(n).toBeGreaterThan(0)
  for (const layer of draft!.layers) {
    expect(layer.length).toBe(layout!.length)
  }
  if (draft!.sensorBindings) {
    expect(draft!.sensorBindings.length).toBe(n)
  }
  for (const rule of draft!.conditionalLayers ?? []) {
    expect(rule.thenLayer).toBeGreaterThanOrEqual(0)
    expect(rule.thenLayer).toBeLessThan(n)
    for (const index of rule.ifLayers) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(n)
    }
  }
  for (const combo of draft!.combos ?? []) {
    for (const index of combo.layers ?? []) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(n)
    }
  }
  for (const index of real.layerView.shown) {
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThan(n)
  }
  expect(real.isDirty).toBe(diffKeymaps(baseline!, draft!).length > 0)
  expect(real.undoStack.length).toBeLessThanOrEqual(HISTORY_LIMIT)
  if (lastWasEdit) expect(real.redoStack).toEqual([])
  if (real.activeComboId != null) {
    expect((draft!.combos ?? []).some(c => c.id === real.activeComboId)).toBe(
      true
    )
  }
}

function finish(m: Model, real: typeof editor, lastWasEdit: boolean) {
  assertInvariants(real, lastWasEdit)
  captureModel(m, real)
}

class PatchBindingCommand implements fc.AsyncCommand<Model, typeof editor> {
  constructor(
    readonly layer: number,
    readonly index: number,
    readonly code: string
  ) {}
  check(m: Readonly<Model>): boolean {
    return this.layer < m.layerCount && this.index < m.keyCount
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    const next = cloneParsedKeymap(r.draftKeymap!)
    next.layers[this.layer][this.index] = kp(this.code)
    r.updateKeymap(next)
    finish(m, r, true)
  }
  toString(): string {
    return `updateKeymap binding[${this.layer}][${this.index}]=&kp ${this.code}`
  }
}

class PatchMoCommand implements fc.AsyncCommand<Model, typeof editor> {
  constructor(
    readonly layer: number,
    readonly index: number,
    readonly target: number
  ) {}
  check(m: Readonly<Model>): boolean {
    return (
      this.layer < m.layerCount &&
      this.index < m.keyCount &&
      this.target < m.layerCount
    )
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    const next = cloneParsedKeymap(r.draftKeymap!)
    next.layers[this.layer][this.index] = mo(this.target)
    r.updateKeymap(next)
    finish(m, r, true)
  }
  toString(): string {
    return `updateKeymap binding[${this.layer}][${this.index}]=&mo ${this.target}`
  }
}

class AddLayerCommand implements fc.AsyncCommand<Model, typeof editor> {
  check(): boolean {
    return true
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    r.addLayer()
    finish(m, r, true)
  }
  toString(): string {
    return 'addLayer'
  }
}

class DeleteLayerCommand implements fc.AsyncCommand<Model, typeof editor> {
  constructor(readonly index: number) {}
  check(m: Readonly<Model>): boolean {
    return m.layerCount > 1 && this.index < m.layerCount
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    r.deleteLayer(this.index)
    finish(m, r, true)
  }
  toString(): string {
    return `deleteLayer(${this.index})`
  }
}

/** Always removes the highest index so combo filters on the last layer are in play (T1-6). */
class DeleteLastLayerCommand implements fc.AsyncCommand<Model, typeof editor> {
  check(m: Readonly<Model>): boolean {
    return m.layerCount > 1
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    r.deleteLayer(m.layerCount - 1)
    finish(m, r, true)
  }
  toString(): string {
    return 'deleteLayer(last)'
  }
}

class RenameLayerCommand implements fc.AsyncCommand<Model, typeof editor> {
  constructor(
    readonly index: number,
    readonly name: string
  ) {}
  check(m: Readonly<Model>): boolean {
    return this.index < m.layerCount
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    r.renameLayer(this.index, this.name)
    finish(m, r, true)
  }
  toString(): string {
    return `renameLayer(${this.index}, ${JSON.stringify(this.name)})`
  }
}

class UpdateCombosCommand implements fc.AsyncCommand<Model, typeof editor> {
  constructor(readonly combos: ZmkCombo[]) {}
  check(m: Readonly<Model>): boolean {
    return this.combos.every(
      c =>
        (c.layers ?? []).every(index => index < m.layerCount) &&
        c.keyPositions.every(pos => pos < m.keyCount)
    )
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    r.updateCombos(
      this.combos.map(c => ({
        ...c,
        keyPositions: [...c.keyPositions],
        layers: c.layers ? [...c.layers] : undefined,
        binding: { ...c.binding, params: [...c.binding.params] }
      }))
    )
    finish(m, r, true)
  }
  toString(): string {
    return `updateCombos(${this.combos.map(c => c.id).join(',') || 'empty'})`
  }
}

class UpdateSensorBindingCommand implements fc.AsyncCommand<Model, typeof editor> {
  constructor(
    readonly layer: number,
    readonly index: number,
    readonly up: string
  ) {}
  check(m: Readonly<Model>): boolean {
    return (
      m.sensorSlots > 0 &&
      this.layer < m.layerCount &&
      this.index < m.sensorSlots
    )
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    r.updateSensorBinding(this.layer, this.index, {
      value: '&inc_dec_kp',
      params: [
        { value: this.up, params: [] },
        { value: 'C_VOL_DN', params: [] }
      ]
    })
    finish(m, r, true)
  }
  toString(): string {
    return `updateSensorBinding(${this.layer}, ${this.index}, ${this.up})`
  }
}

class UpdateConditionalLayersCommand implements fc.AsyncCommand<Model, typeof editor> {
  constructor(readonly rules: ZmkConditionalLayer[]) {}
  check(m: Readonly<Model>): boolean {
    if (this.rules.length === 0) return true
    if (m.layerCount < 3) return false
    return this.rules.every(
      rule =>
        rule.thenLayer < m.layerCount &&
        rule.ifLayers.length >= 2 &&
        rule.ifLayers.every(index => index < m.layerCount)
    )
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    r.updateConditionalLayers(
      this.rules.map(rule => ({
        id: rule.id,
        ifLayers: [...rule.ifLayers],
        thenLayer: rule.thenLayer
      }))
    )
    finish(m, r, true)
  }
  toString(): string {
    return `updateConditionalLayers(${this.rules.map(r => r.id).join(',') || 'empty'})`
  }
}

class ToggleShownLayerCommand implements fc.AsyncCommand<Model, typeof editor> {
  constructor(readonly index: number) {}
  check(m: Readonly<Model>): boolean {
    return this.index < m.layerCount
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    r.layerView = toggleShownLayer(r.layerView, this.index)
    finish(m, r, false)
  }
  toString(): string {
    return `toggleShownLayer(${this.index})`
  }
}

class UndoCommand implements fc.AsyncCommand<Model, typeof editor> {
  check(m: Readonly<Model>): boolean {
    return m.undoLen > 0
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    r.undo()
    finish(m, r, false)
  }
  toString(): string {
    return 'undo'
  }
}

class RedoCommand implements fc.AsyncCommand<Model, typeof editor> {
  check(m: Readonly<Model>): boolean {
    return m.redoLen > 0
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    r.redo()
    finish(m, r, false)
  }
  toString(): string {
    return 'redo'
  }
}

class DiscardDraftCommand implements fc.AsyncCommand<Model, typeof editor> {
  check(): boolean {
    return true
  }
  async run(m: Model, r: typeof editor): Promise<void> {
    await r.discardDraft()
    expect(keymapsAreEqual(r.draftKeymap!, r.baselineKeymap!)).toBe(true)
    expect(r.draftKeymap).toEqual(r.baselineKeymap)
    expect(r.layout).toEqual(r.baselineLayout)
    finish(m, r, false)
  }
  toString(): string {
    return 'discardDraft'
  }
}

const layerNat = fc.nat({ max: 8 })
const keyNat = fc.nat({ max: 4 })
const codeArb = fc.constantFrom('A', 'B', 'C', 'ESC', 'TAB')
const nameArb = fc.constantFrom('Base', 'Nav', 'Num', 'Fun', 'Extra')

const comboArb: fc.Arbitrary<ZmkCombo> = fc.record({
  id: fc.constantFrom('combo_a', 'combo_b', 'combo_c'),
  posA: keyNat,
  posB: keyNat,
  layer: layerNat
}).map(({ id, posA, posB, layer }) => ({
  id,
  keyPositions: [...new Set([posA, posB])].sort((a, b) => a - b),
  binding: esc,
  layers: [layer]
}))

const condArb: fc.Arbitrary<ZmkConditionalLayer> = fc.record({
  ifA: layerNat,
  ifB: layerNat,
  thenLayer: layerNat
}).map(({ ifA, ifB, thenLayer }) => ({
  id: 'cond_gen',
  ifLayers: [...new Set([ifA, ifB])],
  thenLayer
}))

const editCommands = [
  fc.tuple(layerNat, keyNat, codeArb).map(
    ([layer, index, code]) => new PatchBindingCommand(layer, index, code)
  ),
  fc.tuple(layerNat, keyNat, layerNat).map(
    ([layer, index, target]) => new PatchMoCommand(layer, index, target)
  ),
  fc.constant(new AddLayerCommand()),
  layerNat.map(index => new DeleteLayerCommand(index)),
  fc.constant(new DeleteLastLayerCommand()),
  fc.tuple(layerNat, nameArb).map(
    ([index, name]) => new RenameLayerCommand(index, name)
  ),
  fc.array(comboArb, { maxLength: 3 }).map(combos => {
    const seen = new Set<string>()
    const unique = combos.filter(c => {
      if (seen.has(c.id)) return false
      seen.add(c.id)
      return true
    })
    return new UpdateCombosCommand(unique)
  }),
  fc.tuple(layerNat, fc.constantFrom('C_VOL_UP', 'PG_UP', 'C_NEXT')).map(
    ([layer, up]) => new UpdateSensorBindingCommand(layer, 0, up)
  ),
  fc.oneof(
    fc.constant(new UpdateConditionalLayersCommand([])),
    condArb.map(rule => new UpdateConditionalLayersCommand([rule]))
  )
]

const allCommands = [
  ...editCommands,
  layerNat.map(index => new ToggleShownLayerCommand(index)),
  fc.constant(new UndoCommand()),
  fc.constant(new RedoCommand()),
  fc.constant(new DiscardDraftCommand())
]

describe('EditorState model commands', () => {
  beforeEach(() => {
    editor.resetForTests()
  })

  afterEach(() => {
    editor.resetForTests()
  })

  it('preserves indexes, dirty flag, and history on random commands', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.commands(allCommands, { maxCommands: 40 }),
        async cmds => {
          await selectFixture()
          const model = freshModel()
          assertInvariants(editor, false)
          await fc.asyncModelRun(() => ({ model, real: editor }), cmds)
        }
      ),
      FC
    )
  }, 20_000)

  it('drops a shown layer that redo or discard removes again', async () => {
    await selectFixture()
    editor.deleteLayer(3)
    editor.undo()
    editor.layerView = toggleShownLayer(editor.layerView, 3)
    editor.redo()
    assertInvariants(editor, false)

    editor.addLayer()
    editor.layerView = { shown: [0, 4], layer0Raw: false }
    await editor.discardDraft()
    assertInvariants(editor, false)
  })

  it('restores the baseline after N edits and N undos', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.commands(editCommands, { maxCommands: 20 }),
        async cmds => {
          await selectFixture()
          const model = freshModel()
          await fc.asyncModelRun(() => ({ model, real: editor }), cmds)
          const n = editor.undoStack.length
          for (let i = 0; i < n; i++) editor.undo()
          expect(keymapsAreEqual(editor.draftKeymap!, editor.baselineKeymap!)).toBe(
            true
          )
          expect(editor.draftKeymap).toEqual(editor.baselineKeymap)
          assertInvariants(editor, false)
        }
      ),
      FC
    )
  }, 20_000)
})
