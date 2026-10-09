import { parseKeycodeOsSupport } from './keycode-os.js'
import type { KeycodeDef, NormalizedKeycode } from './types.js'

function shortestAlias(aliases: string[]): string {
  return [...aliases].sort((a, b) => a.length - b.length)[0].replace(/^KC_/, '')
}

/** Normalize raw ZMK keycode catalog for the editor UI. */
export function normalizeZmkKeycodes(keycodes: KeycodeDef[]): NormalizedKeycode[] {
  const fnPattern = /^(.+?)\((code)\)$/

  return keycodes.reduce<NormalizedKeycode[]>((acc, keycode) => {
    const { description, context, symbol, faIcon } = keycode
    const os = parseKeycodeOsSupport(keycode.os)
    const aliases = keycode.names.filter(name => !name.match(fnPattern))
    const fnCode = keycode.names.map(name => name.match(fnPattern)).find(v => !!v)
    const base = {
      aliases,
      description,
      context,
      faIcon,
      ...(os ? { os } : {}),
      symbol: symbol || shortestAlias(aliases),
      params: [] as string[]
    }

    for (const code of aliases) {
      acc.push({
        ...base,
        code,
        isModifier: !!fnCode
      })
    }

    if (fnCode) {
      acc.push({
        ...base,
        code: fnCode[1],
        params: fnCode[2].split(','),
        isModifier: false
      })
    }

    return acc
  }, [])
}

export function getBehaviourParams(
  parsedParams: Array<{ value?: string | number }>,
  behaviour: { params?: unknown[]; commands?: Array<{ code: string; additionalParams?: unknown[] }> } | undefined
): unknown[] {
  // Unknown external behaviors have no schema; retain their existing arguments
  // as raw values instead of treating them as parameterless bindings.
  if (!behaviour) return parsedParams.map(() => 'raw')
  const firstParsedParam = parsedParams?.[0] ?? {}
  const commands = Object.fromEntries((behaviour.commands ?? []).map(c => [c.code, c]))
  const firstValue = (firstParsedParam as { value?: string }).value
  return [
    ...(behaviour.params ?? []),
    ...(behaviour.params?.[0] === 'command'
      ? (commands[String(firstValue)]?.additionalParams ?? [])
      : [])
  ]
}
