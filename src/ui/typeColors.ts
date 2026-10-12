import { members, type Ty } from '../dry'

/** one color per structural kind, so types are recognisable at a glance on handles and edges */
const COLORS = {
  any: '#a1a1aa',
  never: '#52525b',
  nullish: '#71717a',
  bool: '#fbbf24',
  num: '#38bdf8',
  str: '#34d399',
  arr: '#f472b6',
  obj: '#a78bfa',
  fn: '#fb923c',
  mixed: '#e879f9',
} as const

export function tyColor(t: Ty | undefined): string {
  if (!t) return COLORS.any
  const ms = members(t).filter((m) => m.k !== 'undef')
  if (ms.length === 0) return COLORS.never
  const kinds = new Set(ms.map((m) => m.k))
  if (kinds.size > 1) return kinds.has('any') ? COLORS.any : COLORS.mixed
  switch (ms[0].k) {
    case 'any':
      return COLORS.any
    case 'null':
      return COLORS.nullish
    case 'bool':
      return COLORS.bool
    case 'num':
      return COLORS.num
    case 'str':
      return COLORS.str
    case 'arr':
      return COLORS.arr
    case 'obj':
      return COLORS.obj
    case 'fn':
      return COLORS.fn
    default:
      return COLORS.never
  }
}

export const TRIGGER_COLOR = '#f59e0b'
export const ERROR_COLOR = '#ef4444'
export const WARN_COLOR = '#f59e0b'
