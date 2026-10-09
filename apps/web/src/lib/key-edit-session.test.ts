import {
  encodeKeyBinding,
  getBehaviorCatalog,
  getKeycodeCatalog,
  HOLD_TAP_PRESETS,
  layerLegendSymbol,
  parseKeyBinding,
  type BehaviorDef,
  type KeyBindingNode
} from '@keymap-editor/keymap-core'
import { describe, expect, it, vi } from 'vitest'
import { buildSearchContext } from './search-context'
import { withKeyEditSession, type KeyEditSession } from './with-key-edit-session.svelte'

const catalog = getBehaviorCatalog()
const behaviorsWithParams = catalog.list.filter(
  behavior => (behavior.params?.length ?? 0) > 0
)

const autoshift = HOLD_TAP_PRESETS.find(preset => preset.code === '&as')
if (!autoshift) throw new Error('missing &as hold-tap preset')

const behaviours = {
  list: [
    ...catalog.list,
    {
      code: autoshift.code,
      name: autoshift.name,
      description: autoshift.description,
      params: [...autoshift.params]
    }
  ],
  byCode: {
    ...catalog.byCode,
    [autoshift.code]: {
      code: autoshift.code,
      name: autoshift.name,
      description: autoshift.description,
      params: [...autoshift.params]
    }
  }
}

const layers = [0, 1, 2].map(code => ({
  code,
  symbol: layerLegendSymbol(code),
  description: `Layer ${code}`
}))

const search = buildSearchContext(
  { keycodes: getKeycodeCatalog(), behaviours },
  layers
)

function expectedParamCount(behavior: BehaviorDef, binding: KeyBindingNode): number {
  const extra =
    behavior.params?.[0] === 'command'
      ? (behavior.commands?.find(command => command.code === String(binding.params[0]?.value))
          ?.additionalParams?.length ?? 0)
      : 0
  return (behavior.params?.length ?? 0) + extra
}

function fillSlotsFromFirstChoices(session: KeyEditSession) {
  const filled = new Set<number>()
  for (let step = 0; step < 8; step++) {
    const slot =
      session.activeSlot?.param !== 'behaviour'
        ? session.activeSlot
        : session.slots.find(candidate => candidate.param !== 'behaviour')
    if (!slot || slot.param === 'behaviour') return
    if (filled.has(slot.codeIndex)) return
    session.openEditor(slot.codeIndex)
    const choice = session.choices[0]
    if (choice?.code == null) {
      throw new Error(`no choices for ${String(session.slots[0]?.value)} slot ${String(slot.param)}`)
    }
    session.selectValue({ code: choice.code })
    filled.add(slot.codeIndex)
  }
}

function runSession(
  onUpdate: (keyIndex: number, layerIndex: number, binding: KeyBindingNode) => void,
  bindings: KeyBindingNode[],
  run: (session: KeyEditSession) => void
) {
  withKeyEditSession(
    {
      sources: () => search.sources,
      search: () => search,
      bindings: () => bindings,
      layerIndex: () => 0,
      keyIndex: () => 0,
      onUpdate
    },
    session => {
      session.openRow(0)
      run(session)
    }
  )
}

describe('createKeyEditSession catalog', () => {
  it.each(behaviorsWithParams.map(behavior => [behavior.code, behavior] as const))(
    'confirms %s with first catalog choices and round-trips the binding',
    (_code, behavior) => {
      const onUpdate = vi.fn()
      runSession(onUpdate, [{ value: '&none', params: [] }], session => {
        session.selectBehaviour({ code: behavior.code, params: behavior.params })
        fillSlotsFromFirstChoices(session)
        session.confirm()
      })

      expect(onUpdate).toHaveBeenCalledOnce()
      const binding = onUpdate.mock.calls[0][2] as KeyBindingNode
      expect(binding.value).toBe(behavior.code)
      expect(binding.params).toHaveLength(expectedParamCount(behavior, binding))
      expect(parseKeyBinding(encodeKeyBinding(binding))).toEqual(binding)
    }
  )
})

describe('createKeyEditSession extra cases', () => {
  it.each(['&uc UC_DE_AE', '&uc 0xE4 0xC4', '&custom WRAP(1,2) 3'])(
    'preserves unknown binding parameters when Apply is pressed: %s',
    code => {
      const onUpdate = vi.fn()
      const binding = parseKeyBinding(code)
      runSession(onUpdate, [binding], session => {
        session.confirm()
      })
      expect(onUpdate).toHaveBeenCalledOnce()
      expect(onUpdate.mock.calls[0][2]).toEqual(binding)
    }
  )

  it('builds &as A as autoshift LS(A) A', () => {
    const onUpdate = vi.fn()
    runSession(onUpdate, [{ value: '&none', params: [] }], session => {
      session.selectBehaviour({ code: '&as', params: autoshift.params })
      session.selectValue({ code: 'A' })
      session.confirm()
    })

    expect(onUpdate).toHaveBeenCalledOnce()
    const binding = onUpdate.mock.calls[0][2] as KeyBindingNode
    expect(encodeKeyBinding(binding)).toBe('&as LS(A) A')
    expect(parseKeyBinding(encodeKeyBinding(binding))).toEqual(binding)
  })

  it('assigns &mo to layer 2 and ignores toggleHold without a keycode root', () => {
    const onUpdate = vi.fn()
    runSession(onUpdate, [{ value: '&none', params: [] }], session => {
      session.selectBehaviour({ code: '&mo' })
      session.selectValue({ code: 2 })
      session.toggleHold('LS')
      session.confirm()
    })

    expect(onUpdate).toHaveBeenCalledOnce()
    const binding = onUpdate.mock.calls[0][2] as KeyBindingNode
    expect(encodeKeyBinding(binding)).toBe('&mo 2')
    expect(parseKeyBinding(encodeKeyBinding(binding))).toEqual(binding)
  })

  it('assigns &bt BT_SEL 1 including the command extra index', () => {
    const onUpdate = vi.fn()
    runSession(onUpdate, [{ value: '&none', params: [] }], session => {
      session.selectBehaviour({ code: '&bt' })
      session.selectValue({ code: 'BT_SEL' })
      const extra = session.slots.find(
        slot => slot.param !== 'behaviour' && (slot.value == null || slot.value === '')
      )
      if (!extra) throw new Error('expected BT_SEL index slot')
      session.openEditor(extra.codeIndex)
      session.selectValue({ code: 1 })
      session.confirm()
    })

    expect(onUpdate).toHaveBeenCalledOnce()
    const binding = onUpdate.mock.calls[0][2] as KeyBindingNode
    expect(binding.params).toHaveLength(2)
    expect(encodeKeyBinding(binding)).toBe('&bt BT_SEL 1')
    expect(parseKeyBinding(encodeKeyBinding(binding))).toEqual(binding)
  })

  it('toggles LS hold on &kp A and off again', () => {
    const onUpdate = vi.fn()
    runSession(
      onUpdate,
      [{ value: '&kp', params: [{ value: 'A', params: [] }] }],
      session => {
        session.toggleHold('LS')
        session.confirm()
      }
    )
    expect(encodeKeyBinding(onUpdate.mock.calls[0][2] as KeyBindingNode)).toBe(
      '&kp LS(A)'
    )

    onUpdate.mockClear()
    runSession(
      onUpdate,
      [{ value: '&kp', params: [{ value: 'LS', params: [{ value: 'A', params: [] }] }] }],
      session => {
        session.toggleHold('LS')
        session.confirm()
      }
    )
    expect(encodeKeyBinding(onUpdate.mock.calls[0][2] as KeyBindingNode)).toBe(
      '&kp A'
    )
  })

  it('closes the editor on corrupt paramsJson and does not call onUpdate', () => {
    const onUpdate = vi.fn()
    let editingAfterConfirm: { rowKey: string; slotCodeIndex: number } | null =
      null
    runSession(onUpdate, [{ value: '&kp', params: [{ value: 'A', params: [] }] }], session => {
      const draft = session.draftByRow[session.editing?.rowKey ?? '']
      if (!draft) throw new Error('expected an open draft')
      draft.paramsJson = '{not-json'
      session.confirm()
      editingAfterConfirm = session.editing
    })

    expect(editingAfterConfirm).toBeNull()
    expect(onUpdate).not.toHaveBeenCalled()
  })
})
