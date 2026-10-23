import { describe, expect, it } from 'vitest'
import {
  clipShownLayers,
  effectiveShownLayers,
  remapShownLayersAfterDelete,
  standardLayerView,
  toggleShownLayer
} from './layer-view.js'
import type { LayerView } from './types.js'

describe('shown layers', () => {
  const standard = standardLayerView()

  it('evicts the earliest marked layer when a fifth is picked', () => {
    const next = toggleShownLayer(standard, 4)
    expect(next.shown).toEqual([0, 2, 3, 4])
  })

  it('never evicts layer0', () => {
    const afterFourth = toggleShownLayer(standard, 4)
    expect(afterFourth.shown).toContain(0)
    const afterFifth = toggleShownLayer(afterFourth, 5)
    expect(afterFifth.shown).toEqual([0, 3, 4, 5])
  })

  it('adds layer0 when exactly one non-zero layer is marked', () => {
    const view: LayerView = { shown: [2], layer0Raw: false }
    expect(effectiveShownLayers(view, 4)).toEqual([0, 2])
  })

  it('keeps a single layer0 mark as one row', () => {
    const view: LayerView = { shown: [0], layer0Raw: false }
    expect(effectiveShownLayers(view, 4)).toEqual([0])
  })

  it('returns to layer0 when the last eye is cleared', () => {
    expect(toggleShownLayer({ shown: [0], layer0Raw: false }, 0).shown).toEqual([0])
    expect(toggleShownLayer({ shown: [3], layer0Raw: false }, 3).shown).toEqual([0])
  })

  it('drops indices at or above layerCount', () => {
    expect(effectiveShownLayers(standard, 2)).toEqual([0, 1])
    const empty: LayerView = { shown: [], layer0Raw: false }
    expect(effectiveShownLayers(empty, 2)).toEqual([0, 1])
  })

  it('sorts the effective set in ascending order', () => {
    const view: LayerView = { shown: [3, 1, 0], layer0Raw: false }
    expect(effectiveShownLayers(view, 4)).toEqual([0, 1, 3])
  })

  it('shifts shown after a middle layer is deleted', () => {
    const view: LayerView = { shown: [0, 2, 3], layer0Raw: false }
    expect(remapShownLayersAfterDelete(view, 1, 3).shown).toEqual([0, 1, 2])
  })

  it('drops the deleted mark and resets layer0Raw when layer0 is removed', () => {
    const view: LayerView = { shown: [0, 2], layer0Raw: true }
    const next = remapShownLayersAfterDelete(view, 0, 3)
    expect(next.shown).toEqual([1])
    expect(next.layer0Raw).toBe(false)
  })

  it('falls back to layer0 when the last marked layer is deleted', () => {
    const view: LayerView = { shown: [2], layer0Raw: false }
    expect(remapShownLayersAfterDelete(view, 2, 2).shown).toEqual([0])
  })

  it('clips marks past the layer count and keeps a fitting view as is', () => {
    const view: LayerView = { shown: [0, 3, 1], layer0Raw: true }
    expect(clipShownLayers(view, 3)).toEqual({ shown: [0, 1], layer0Raw: true })
    expect(clipShownLayers(view, 4)).toBe(view)
    expect(clipShownLayers({ shown: [3], layer0Raw: false }, 3).shown).toEqual([0])
  })
})
