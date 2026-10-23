import type { LayerView } from './types.js'

const DEFAULT_SHOWN = [0, 1, 2, 3]

export function standardLayerView(): LayerView {
  return { shown: [...DEFAULT_SHOWN], layer0Raw: false }
}

function markedShown(view: LayerView): number[] {
  return view.shown.length > 0 ? [...view.shown] : [...DEFAULT_SHOWN]
}

/**
 * Toggle a layer in inclusion order. A fifth pick evicts the earliest
 * marked layer; layer0 is never evicted. Clearing the last eye returns [0].
 */
export function toggleShownLayer(view: LayerView, index: number, limit = 4): LayerView {
  const current = markedShown(view)
  const pos = current.indexOf(index)
  let next: number[]
  if (pos >= 0) {
    next = current.filter((_, i) => i !== pos)
    if (next.length === 0) next = [0]
  } else {
    next = [...current, index]
    while (next.length > limit) {
      const evictAt = next.findIndex(layer => layer !== 0)
      if (evictAt < 0) break
      next.splice(evictAt, 1)
    }
  }
  return { ...view, shown: next }
}

/**
 * Shift `shown` after a keymap layer is removed. Layer0 raw view
 * resets when the old layer0 is gone. An empty mark set falls back to [0].
 */
export function remapShownLayersAfterDelete(
  view: LayerView,
  deletedIndex: number,
  nextLayerCount: number
): LayerView {
  let remapped = markedShown(view)
    .filter(index => index !== deletedIndex)
    .map(index => (index > deletedIndex ? index - 1 : index))
    .filter(index => index >= 0 && index < nextLayerCount)
  if (remapped.length === 0 && nextLayerCount > 0) remapped = [0]
  return {
    ...view,
    shown: remapped,
    layer0Raw: deletedIndex === 0 ? false : view.layer0Raw
  }
}

/**
 * Drop marks past `layerCount`, e.g. after undo/redo shrinks the keymap.
 * Returns `view` itself when every mark still fits.
 */
export function clipShownLayers(view: LayerView, layerCount: number): LayerView {
  const kept = view.shown.filter(index => index >= 0 && index < layerCount)
  if (kept.length === view.shown.length) return view
  return { ...view, shown: kept.length > 0 || layerCount === 0 ? kept : [0] }
}

/**
 * Layers drawn on the keycap: section-6 rules, clipped to `layerCount`,
 * sorted ascending. An empty `shown` defaults to [0, 1, 2, 3].
 */
export function effectiveShownLayers(view: LayerView, layerCount: number): number[] {
  const raw = view.shown.length > 0 ? view.shown : DEFAULT_SHOWN
  const seen = new Set<number>()
  const marked: number[] = []
  for (const index of raw) {
    if (index < 0 || index >= layerCount || seen.has(index)) continue
    seen.add(index)
    marked.push(index)
  }
  if (marked.length === 0) return layerCount > 0 ? [0] : []
  if (marked.length === 1 && marked[0] !== 0) return [0, marked[0]]
  return [...marked].sort((a, b) => a - b)
}
