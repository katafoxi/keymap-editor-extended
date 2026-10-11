import type { LayoutKey } from './types.js'
import type { LineEnding } from './eol.js'
import { InfoValidationError, KeymapValidationError } from './errors.js'

export { InfoValidationError } from './errors.js'

export interface RenderTableOpts {
  useQuotes?: boolean
  linePrefix?: string
  columnSeparator?: string
  /**
   * Shared column widths (characters including separator). When omitted, widths
   * come from this layer only. Pass {@link bindingColumnWidths} so every layer
   * lines up the same matrix column.
   */
  columnWidths?: number[]
  /** Newline used between matrix rows. Defaults to LF. */
  eol?: LineEnding
}

/** Place bindings into physical rows/cols from the layout. */
function layerBindingGrid(
  layout: LayoutKey[],
  layer: string[]
): (string | undefined)[][] {
  // Dense Map — sparse `row` indices (e.g. 0,2 with 1 unused) must not create
  // holes in a JS array. Spreading those holes into Math.max yields NaN and an
  // empty bindings block on save.
  const rowsByIndex = new Map<number, (string | undefined)[]>()
  // First layout index that claimed each (row,col); detect silent overwrites.
  const claimed = new Map<string, number>()

  layer.forEach((code, i) => {
    if (layout[i]) {
      if (code.trim() === '') {
        throw new KeymapValidationError([`Empty encoded binding at layout index ${i}`])
      }
      const { row = 0, col } = layout[i]
      const rowCells = rowsByIndex.get(row) ?? []
      const colIndex = col ?? rowCells.length
      const cellKey = `${row},${colIndex}`
      const prior = claimed.get(cellKey)
      if (prior !== undefined) {
        throw new KeymapValidationError([
          `Duplicate matrix cell at row ${row}, col ${colIndex} (layout indexes ${prior} and ${i})`
        ])
      }
      claimed.set(cellKey, i)
      rowCells[colIndex] = code
      rowsByIndex.set(row, rowCells)
    }
  })

  return [...rowsByIndex.keys()]
    .sort((a, b) => a - b)
    .map(row => rowsByIndex.get(row)!)
}

function columnCount(table: (string | undefined)[][]): number {
  return table.reduce((max, row) => Math.max(max, row.length), 0)
}

function widthsForGrid(
  table: (string | undefined)[][],
  opts: Pick<RenderTableOpts, 'useQuotes' | 'columnSeparator'>
): number[] {
  const useQuotes = opts.useQuotes ?? false
  const columnSeparator = opts.columnSeparator ?? ','
  const minWidth = useQuotes ? 9 : 7
  const columns = columnCount(table)
  return Array.from({ length: columns }, (_, i) =>
    Math.max(
      minWidth,
      ...table.map(
        row =>
          ((row[i] || '') as string).length +
          columnSeparator.length +
          (useQuotes ? 2 : 0)
      )
    )
  )
}

/**
 * Max width per matrix column across every layer so `.keymap` / `keymap.json`
 * tables share one horizontal grid.
 */
export function bindingColumnWidths(
  layout: LayoutKey[],
  layers: string[][],
  opts: Pick<RenderTableOpts, 'useQuotes' | 'columnSeparator'> = {}
): number[] {
  const grids = layers.map(layer => layerBindingGrid(layout, layer))
  const columns = grids.reduce((max, table) => Math.max(max, columnCount(table)), 0)
  const perLayer = grids.map(table => widthsForGrid(table, opts))
  return Array.from({ length: columns }, (_, i) =>
    Math.max(0, ...perLayer.map(widths => widths[i] ?? 0))
  )
}

export function renderTable(
  layout: LayoutKey[],
  layer: string[],
  opts: RenderTableOpts = {}
): string {
  const {
    useQuotes = false,
    linePrefix = '',
    columnSeparator = ',',
    eol = '\n'
  } = opts
  const minWidth = useQuotes ? 9 : 7

  const table = layerBindingGrid(layout, layer)
  const columns = columnCount(table)
  const columnIndices = Array.from({ length: columns }, (_, i) => i)
  const computed = widthsForGrid(table, { useQuotes, columnSeparator })
  const columnWidths = columnIndices.map(i =>
    Math.max(minWidth, opts.columnWidths?.[i] ?? computed[i] ?? minWidth)
  )

  return table
    .map((row, rowIndex) => {
      const isLastRow = rowIndex === table.length - 1
      return (
        linePrefix +
        columnIndices
          .map(i => {
            const noMoreValues = row.slice(i).every(col => col === undefined)
            const noFollowingValues = row.slice(i + 1).every(col => col === undefined)
            const padding = columnWidths[i] ?? minWidth

            if (noMoreValues) return ''
            if (!row[i]) return ' '.repeat(padding + 1)
            // Left-align so the same matrix column starts at one x across layers.
            const column = (useQuotes ? `"${row[i]}"` : row[i]!).padEnd(padding)
            const suffix = isLastRow && noFollowingValues ? '' : columnSeparator
            return column + suffix
          })
          .join('')
      )
    })
    .join(eol)
}

function isNumber(val: unknown): val is number {
  return typeof val === 'number' && !Number.isNaN(val)
}

/**
 * Pick a column count for an inferred board: prefer a divisor of `keyCount`,
 * else 12 (last row may be short).
 */
function inferRectangularColumns(keyCount: number): number {
  if (!Number.isInteger(keyCount) || keyCount <= 0) {
    throw new KeymapValidationError(['keyCount must be a positive integer'])
  }
  if (keyCount <= 12) {
    for (const cols of [12, 10, 8, 7, 6, 5, 4, 3, 2]) {
      if (cols <= keyCount && keyCount % cols === 0) return cols
    }
    return keyCount
  }
  for (const cols of [12, 10, 8, 6]) {
    if (keyCount % cols === 0) return cols
  }
  return 12
}

/**
 * Flat rectangular layout for Clipboard when the user has no info.json.
 * Keys are row-major in binding order; no angles or staggered offsets.
 */
export function inferRectangularLayout(
  keyCount: number,
  options?: { columns?: number }
): LayoutKey[] {
  const columns = options?.columns ?? inferRectangularColumns(keyCount)
  if (!Number.isInteger(columns) || columns <= 0) {
    throw new KeymapValidationError(['columns must be a positive integer'])
  }
  if (!Number.isInteger(keyCount) || keyCount <= 0) {
    throw new KeymapValidationError(['keyCount must be a positive integer'])
  }
  return Array.from({ length: keyCount }, (_, i) => {
    const row = Math.floor(i / columns)
    const col = i % columns
    return {
      row,
      col,
      x: col,
      y: row,
      label: `${row},${col}`
    }
  })
}

/** True when the layout slot exists only to hold a matrix/keymap index. */
function isAbsentLayoutKey(key: LayoutKey): boolean {
  return key.absent === true
}

/** Indexes of matrix slots that must not be drawn. */
export function absentLayoutIndexes(layout: LayoutKey[]): number[] {
  return layout.flatMap((key, index) => (isAbsentLayoutKey(key) ? [index] : []))
}

/**
 * Clear `absent` so the matrix slot is drawn as a physical key.
 * Returns the same array when the slot is already present.
 */
export function promoteAbsentLayoutKey(
  layout: LayoutKey[],
  keyIndex: number
): LayoutKey[] {
  const key = layout[keyIndex]
  if (!key?.absent) return layout
  return layout.map((entry, index) => {
    if (index !== keyIndex) return entry
    const { absent: _omit, ...rest } = entry
    return rest
  })
}

export function validateInfoJson(info: unknown): void {
  const errors: string[] = []

  if (typeof info !== 'object' || info === null) {
    errors.push('info.json root must be an object')
  } else {
    const root = info as Record<string, unknown>
    if (!('layouts' in root) || root.layouts === undefined) {
      errors.push('info must define "layouts"')
    } else if (typeof root.layouts !== 'object' || root.layouts === null) {
      errors.push('layouts must be an object')
    } else {
      const layouts = root.layouts as Record<string, unknown>
      if (Object.values(layouts).length === 0) {
        errors.push('layouts must define at least one layout')
      } else {
        for (const name in layouts) {
          const layout = layouts[name] as Record<string, unknown> | null
          if (typeof layout !== 'object' || layout === null) {
            errors.push(`layout ${name} must be an object`)
          } else if (!Array.isArray(layout.layout)) {
            errors.push(`layout ${name} must define "layout" array`)
          } else {
            const keys = layout.layout as Record<string, unknown>[]
            const anyKeyHasPosition = keys.some(
              key => key?.row !== undefined || key?.col !== undefined
            )

            for (let i = 0; i < keys.length; i++) {
              const key = keys[i]
              const keyPath = `layouts[${name}].layout[${i}]`

              if (typeof key !== 'object' || key === null) {
                errors.push(`Key definition at ${keyPath} must be an object`)
              } else {
                const optionalNumberProps = ['u', 'h', 'r', 'rx', 'ry']
                if (!isNumber(key.x)) {
                  errors.push(`Key definition at ${keyPath} must include "x" position`)
                }
                if (!isNumber(key.y)) {
                  errors.push(`Key definition at ${keyPath} must include "y" position`)
                }
                for (const prop of optionalNumberProps) {
                  if (prop in key && !isNumber(key[prop])) {
                    errors.push(`Key definition at ${keyPath} optional "${prop}" must be number`)
                  }
                }
                if ('absent' in key && typeof key.absent !== 'boolean') {
                  errors.push(`Key definition at ${keyPath} optional "absent" must be boolean`)
                }
                for (const prop of ['row', 'col'] as const) {
                  if (anyKeyHasPosition && !(prop in key)) {
                    errors.push(`Key definition at ${keyPath} is missing "${prop}"`)
                  } else if (
                    prop in key &&
                    (!Number.isInteger(key[prop]) || (key[prop] as number) < 0)
                  ) {
                    errors.push(
                      `Key definition at ${keyPath} "${prop}" must be a non-negative integer`
                    )
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  if (errors.length) {
    throw new InfoValidationError(errors)
  }
}

function hasLayoutsField(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'layouts' in value &&
    (value as { layouts?: unknown }).layouts !== undefined
  )
}

/**
 * A named `config/<keymap>.json` is a physical layout only when it has `layouts`.
 * Other JSON is ignored. A present `layouts` value must pass {@link validateInfoJson}.
 */
export function acceptNamedLayoutInfo(value: unknown): unknown | null {
  if (!hasLayoutsField(value)) return null
  validateInfoJson(value)
  return value
}
