import { describe, expect, it } from 'vitest'
import {
  absentLayoutIndexes,
  acceptNamedLayoutInfo,
  bindingColumnWidths,
  buildKeymapCode,
  inferRectangularLayout,
  InfoValidationError,
  KeymapValidationError,
  parseKeymap,
  promoteAbsentLayoutKey,
  renderTable,
  validateInfoJson
} from './index.js'
import type { LayoutKey } from './types.js'

/** Thumb-cluster style: physical row 1 unused in matrix numbering. */
const GAPPED_LAYOUT: LayoutKey[] = [
  { x: 0, y: 0, row: 0, col: 0 },
  { x: 1, y: 0, row: 0, col: 1 },
  { x: 0, y: 2, row: 2, col: 0 },
  { x: 1, y: 2, row: 2, col: 1 }
]

describe('renderTable', () => {
  it('keeps all bindings when layout row indices are non-contiguous', () => {
    const layer = ['&kp A', '&kp B', '&kp C', '&kp D']
    const rendered = renderTable(GAPPED_LAYOUT, layer, { columnSeparator: ' ' })

    expect(rendered).toContain('&kp A')
    expect(rendered).toContain('&kp B')
    expect(rendered).toContain('&kp C')
    expect(rendered).toContain('&kp D')
    expect(rendered.trim()).not.toBe('')
  })

  it('renders contiguous rows as before', () => {
    const layout: LayoutKey[] = [
      { x: 0, y: 0, row: 0, col: 0 },
      { x: 1, y: 0, row: 0, col: 1 },
      { x: 0, y: 1, row: 1, col: 0 },
      { x: 1, y: 1, row: 1, col: 1 }
    ]
    const rendered = renderTable(layout, ['&kp A', '&kp B', '&kp C', '&kp D'], {
      columnSeparator: ' '
    })
    const lines = rendered.split('\n').map(l => l.trim()).filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/&kp A\s+&kp B/)
    expect(lines[1]).toMatch(/&kp C\s+&kp D/)
  })

  it('still emits bindings for absent matrix slots', () => {
    const layout: LayoutKey[] = [
      { x: 0, y: 0, row: 0, col: 0, absent: true },
      { x: 1, y: 0, row: 0, col: 1 }
    ]
    const rendered = renderTable(layout, ['&none', '&kp A'], { columnSeparator: ' ' })
    expect(rendered).toContain('&none')
    expect(rendered).toContain('&kp A')
  })

  it('aligns the same matrix column across layers when widths are shared', () => {
    const layout: LayoutKey[] = [
      { x: 0, y: 0, row: 0, col: 0 },
      { x: 1, y: 0, row: 0, col: 1 },
      { x: 2, y: 0, row: 0, col: 2 }
    ]
    const layers = [
      ['&kp A', '&kp B', '&kp C'],
      ['&trans', '&mt LCTRL J', '&kp D']
    ]
    const columnWidths = bindingColumnWidths(layout, layers, { columnSeparator: ' ' })
    const [shortLayer, longLayer] = layers.map(layer =>
      renderTable(layout, layer, { columnSeparator: ' ', columnWidths })
    )
    // padEnd: left edges of the same matrix column line up across layers.
    expect(shortLayer.indexOf('&kp B')).toBe(longLayer.indexOf('&mt LCTRL J'))
    expect(shortLayer.indexOf('&kp C')).toBe(longLayer.indexOf('&kp D'))
  })

  it('throws KeymapValidationError for an empty encoded binding', () => {
    const layout: LayoutKey[] = [
      { x: 0, y: 0, row: 0, col: 0 },
      { x: 1, y: 0, row: 0, col: 1 }
    ]
    expect(() => renderTable(layout, ['', '&kp A'], { columnSeparator: ' ' })).toThrow(
      KeymapValidationError
    )
    try {
      renderTable(layout, ['', '&kp A'], { columnSeparator: ' ' })
      expect.unreachable('expected empty encoded binding to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(KeymapValidationError)
      expect((e as KeymapValidationError).errors[0]).toMatch(/empty encoded binding/i)
    }
  })

  it('throws KeymapValidationError when two keys share the same (row, col)', () => {
    const layout: LayoutKey[] = [
      { x: 0, y: 0, row: 0, col: 0 },
      { x: 1, y: 0, row: 0, col: 0 }
    ]
    const layer = ['&kp A', '&kp B']
    expect(() => renderTable(layout, layer, { columnSeparator: ' ' })).toThrow(
      KeymapValidationError
    )
    expect(() => bindingColumnWidths(layout, [layer], { columnSeparator: ' ' })).toThrow(
      KeymapValidationError
    )
    try {
      renderTable(layout, layer, { columnSeparator: ' ' })
      expect.unreachable('expected duplicate cell to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(KeymapValidationError)
      const err = e as KeymapValidationError
      expect(err.errors[0]).toMatch(/duplicate matrix cell/i)
      expect(err.errors[0]).toMatch(/row 0/)
      expect(err.errors[0]).toMatch(/col 0/)
    }
  })

  it('joins matrix rows with an explicit CRLF when requested', () => {
    const layout: LayoutKey[] = [
      { x: 0, y: 0, row: 0, col: 0 },
      { x: 1, y: 0, row: 0, col: 1 },
      { x: 0, y: 1, row: 1, col: 0 },
      { x: 1, y: 1, row: 1, col: 1 }
    ]
    const rendered = renderTable(layout, ['&kp A', '&kp B', '&kp C', '&kp D'], {
      columnSeparator: ' ',
      eol: '\r\n'
    })
    expect(rendered).toContain('\r\n')
    expect(rendered.split('\r\n')).toHaveLength(2)
  })
})

describe('inferRectangularLayout', () => {
  it('builds a 12-column board when the count divides evenly', () => {
    const layout = inferRectangularLayout(84)
    expect(layout).toHaveLength(84)
    expect(layout[0]).toMatchObject({ row: 0, col: 0, x: 0, y: 0 })
    expect(layout[12]).toMatchObject({ row: 1, col: 0, x: 0, y: 1 })
    expect(layout[83]).toMatchObject({ row: 6, col: 11 })
  })

  it('throws KeymapValidationError for a non-positive key count', () => {
    expect(() => inferRectangularLayout(0)).toThrow(KeymapValidationError)
    expect(() => inferRectangularLayout(12, { columns: 0 })).toThrow(
      KeymapValidationError
    )
  })

  it('uses a single row for a small board', () => {
    const layout = inferRectangularLayout(5)
    expect(layout).toHaveLength(5)
    expect(layout.every((key, i) => key.row === 0 && key.col === i)).toBe(true)
  })
})

describe('absentLayoutIndexes', () => {
  it('lists only slots marked absent', () => {
    const layout: LayoutKey[] = [
      { x: 0, y: 0, row: 0, col: 0, absent: true },
      { x: 1, y: 0, row: 0, col: 1 },
      { x: 2, y: 0, row: 0, col: 2, absent: true }
    ]
    expect(absentLayoutIndexes(layout)).toEqual([0, 2])
  })
})

describe('promoteAbsentLayoutKey', () => {
  it('clears absent on the edited slot and leaves others alone', () => {
    const layout: LayoutKey[] = [
      { x: 0, y: 0, row: 0, col: 0, absent: true, label: '0,0' },
      { x: 1, y: 0, row: 0, col: 1, absent: true, label: '0,1' }
    ]
    const next = promoteAbsentLayoutKey(layout, 0)
    expect(next[0]).toEqual({ x: 0, y: 0, row: 0, col: 0, label: '0,0' })
    expect(next[1]?.absent).toBe(true)
  })

  it('returns the same array when the slot is already present', () => {
    const layout: LayoutKey[] = [{ x: 0, y: 0, row: 0, col: 0 }]
    expect(promoteAbsentLayoutKey(layout, 0)).toBe(layout)
  })
})

describe('validateInfoJson absent', () => {
  it('accepts boolean absent on a key', () => {
    expect(() =>
      validateInfoJson({
        layouts: {
          LAYOUT: {
            layout: [{ x: 0, y: 0, row: 0, col: 0, absent: true }]
          }
        }
      })
    ).not.toThrow()
  })

  it('rejects a non-boolean absent flag', () => {
    expect(() =>
      validateInfoJson({
        layouts: {
          LAYOUT: {
            layout: [{ x: 0, y: 0, row: 0, col: 0, absent: 'yes' }]
          }
        }
      })
    ).toThrow(/absent/)
  })
})

describe('acceptNamedLayoutInfo', () => {
  const layout = {
    layouts: {
      LAYOUT: { layout: [{ x: 0, y: 0, row: 0, col: 0 }] }
    }
  }

  it('keeps a file that has a valid layouts object', () => {
    expect(acceptNamedLayoutInfo(layout)).toEqual(layout)
  })

  it('ignores JSON that is not a physical layout', () => {
    expect(acceptNamedLayoutInfo({ layers: [['&kp A']] })).toBeNull()
    expect(acceptNamedLayoutInfo({ note: 'not a board' })).toBeNull()
    expect(acceptNamedLayoutInfo(null)).toBeNull()
  })

  it('rejects a layouts object that is not a valid info.json layout', () => {
    expect(() => acceptNamedLayoutInfo({ layouts: { LAYOUT: { layout: 'nope' } } })).toThrow(
      InfoValidationError
    )
  })
})

describe('buildKeymapCode with gapped rows', () => {
  it('splices a full bindings block instead of an empty one', () => {
    const original = `/ {
    keymap {
        compatible = "zmk,keymap";
        default_layer {
            bindings = <
&kp A &kp B
&kp C &kp D
            >;
        };
    };
};
`
    const result = buildKeymapCode(
      GAPPED_LAYOUT,
      parseKeymap({
        layers: [['&kp Z', '&kp B', '&kp C', '&kp D']],
        layer_names: ['default']
      }),
      { originalSource: original }
    )

    expect(result.mode).toBe('splice')
    expect(result.code).toContain('&kp Z')
    expect(result.code).toContain('&kp B')
    expect(result.code).toContain('&kp C')
    expect(result.code).toContain('&kp D')
    expect(result.json).toContain('&kp Z')
  })
})
