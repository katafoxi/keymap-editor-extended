import { describe, expect, it } from 'vitest'
import { getBehaviorCatalog, getKeycodeCatalog } from '@keymap-editor/keymap-core'
import { hydrateTree, makeIndex } from './hydrate'

describe('hydrateTree', () => {
  it('keeps unknown behavior arguments as raw values without catalog guesses', () => {
    const tree = hydrateTree('&uc', [
      { value: 'UC_DE_AE', params: [] },
      { value: 'PAIR', params: [{ value: 1, params: [] }, { value: 2, params: [] }] }
    ], {})
    expect(tree.source).toBeNull()
    expect(tree.params).toHaveLength(2)
    expect(tree.params[0]).toMatchObject({ value: 'UC_DE_AE', source: { code: 'UC_DE_AE' } })
    expect(tree.params[1]?.params.map(node => node.value)).toEqual([1, 2])
  })

  it('does not treat prototype keys as catalogue entries', () => {
    const tree = hydrateTree('constructor', [], {})
    expect(tree.source).toBeNull()
    expect(tree.params).toEqual([])
  })

  it('looks up only own keys on untrusted source maps', () => {
    const tree = hydrateTree('&kp', [{ value: 'constructor', params: [] }], {
      code: {}
    })
    expect(tree.params[0]?.source).toBeNull()
  })

  it('keeps LC(TAB) nests when sources use the code map', () => {
    const tree = hydrateTree(
      '&kp',
      [{ value: 'LC', params: [{ value: 'TAB', params: [] }] }],
      {
        code: getKeycodeCatalog().byCode as Record<string, unknown>,
        behaviours: getBehaviorCatalog().byCode as Record<string, unknown>
      }
    )
    expect(tree.params[0]?.value).toBe('LC')
    expect(tree.params[0]?.params[0]?.value).toBe('TAB')
    expect(makeIndex(tree).map(node => node.value)).toEqual(['&kp', 'LC', 'TAB'])
  })

  it('keeps nested children even when the wrap is missing from sources', () => {
    const tree = hydrateTree(
      '&kp',
      [{ value: 'LC', params: [{ value: 'TAB', params: [] }] }],
      {
        code: {},
        behaviours: getBehaviorCatalog().byCode as Record<string, unknown>
      }
    )
    expect(tree.params[0]?.value).toBe('LC')
    expect(tree.params[0]?.params[0]?.value).toBe('TAB')
  })
})
