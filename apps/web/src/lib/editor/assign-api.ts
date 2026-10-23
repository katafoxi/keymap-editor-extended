/** Attach mixin methods/getters onto EditorState.prototype. */

export const GETTER_NAMES = [
  'isDirty',
  'changes',
  'statusText',
  'canUndo',
  'canRedo',
  'hostLegendLayerNames',
  'isPublishDirty',
  'isHostDirty',
  'hostDeliverableLayoutIds',
  'hostDeliverableFingerprint',
  'canAlignHostSymbols',
  'symbolAlignShowsWinAltGr',
  'multilangViewOn',
  'unicodeKeyCount'
] as const

export type GetterName = (typeof GETTER_NAMES)[number]

type ModuleFn = (...args: never[]) => unknown

/**
 * Instance types for a mixin module: `GETTER_NAMES` become readonly values,
 * other functions become methods (`OmitThisParameter<typeof documentApi.undo>`).
 */
export type BoundMixin<T> = {
  readonly [K in keyof T as K extends GetterName
    ? T[K] extends ModuleFn
      ? K
      : never
    : never]: T[K] extends (...args: never[]) => infer R ? R : never
} & {
  [K in keyof T as K extends GetterName
    ? never
    : T[K] extends ModuleFn
      ? K
      : never]: OmitThisParameter<Extract<T[K], ModuleFn>>
}

export function assignEditorApi(
  proto: object,
  mod: Record<string, unknown>,
  getterNames: readonly string[]
) {
  const getters = new Set(getterNames)
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== 'function') continue
    if (getters.has(name)) {
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: false,
        get: function (this: unknown) {
          return (value as (this: unknown) => unknown).call(this)
        }
      })
    } else {
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value
      })
    }
  }
}
