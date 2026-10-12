/**
 * Internal type model for the JSONata dry-run.
 *
 * It is deliberately close to JSON Schema, but adds the things JSON Schema
 * cannot say and JSONata cares about:
 *  - `undef`: "no value" (a path that matched nothing). JSONata silently
 *    propagates it, so it is a first-class member of unions.
 *  - literal types (`str`/`num`/`bool` with `v`) for constant folding, which
 *    is what makes dead branches detectable.
 *  - function types (lambdas keep their AST so call sites are re-inferred).
 */

export type Ty =
  | { k: 'any' }
  | { k: 'never' }
  | { k: 'undef' }
  | { k: 'null' }
  | { k: 'bool'; v?: boolean }
  | { k: 'num'; int?: boolean; v?: number }
  | { k: 'str'; v?: string }
  | { k: 'arr'; item: Ty }
  | {
      k: 'obj'
      props: Record<string, Ty>
      req: string[]
      /** undefined = not declared (open, but unknown keys are suspicious); false = closed */
      extra?: Ty | false
    }
  | FnTy
  | { k: 'union'; of: Ty[] }

export interface FnTy {
  k: 'fn'
  id: number
  params: Ty[]
  ret: Ty
  /** builtin name, resolved by the inferer */
  builtin?: string
  /** lambda captured with its definition environment (opaque to this module) */
  lambda?: { node: unknown; env: unknown }
  /** result has the same type as the (first) argument, used for `|a|b|` transforms */
  sameAsArg?: boolean
  name?: string
}

export const ANY: Ty = { k: 'any' }
export const NEVER: Ty = { k: 'never' }
export const UNDEF: Ty = { k: 'undef' }
export const NULL: Ty = { k: 'null' }
export const BOOL: Ty = { k: 'bool' }
export const NUM: Ty = { k: 'num' }
export const INT: Ty = { k: 'num', int: true }
export const STR: Ty = { k: 'str' }

export const str = (v: string): Ty => ({ k: 'str', v })
export const num = (v: number): Ty => ({ k: 'num', v, int: Number.isInteger(v) })
export const bool = (v: boolean): Ty => ({ k: 'bool', v })
export const arr = (item: Ty): Ty => ({ k: 'arr', item })
export const obj = (
  props: Record<string, Ty> = {},
  req: string[] = Object.keys(props),
  extra?: Ty | false,
): Ty => ({ k: 'obj', props, req, extra })

let fnId = 0
export const fn = (params: Ty[], ret: Ty, rest: Partial<FnTy> = {}): FnTy => ({
  k: 'fn',
  id: ++fnId,
  params,
  ret,
  ...rest,
})

/** Stable structural key; also used for equality. */
export function key(t: Ty): string {
  switch (t.k) {
    case 'any':
    case 'never':
    case 'undef':
    case 'null':
      return t.k
    case 'bool':
      return t.v === undefined ? 'bool' : `bool:${t.v}`
    case 'num':
      return t.v !== undefined ? `num:${t.v}` : t.int ? 'int' : 'num'
    case 'str':
      return t.v === undefined ? 'str' : `str:${JSON.stringify(t.v)}`
    case 'arr':
      return `[${key(t.item)}]`
    case 'obj': {
      const ks = Object.keys(t.props).sort()
      const body = ks
        .map((k) => `${JSON.stringify(k)}${t.req.includes(k) ? '' : '?'}:${key(t.props[k])}`)
        .join(',')
      const extra = t.extra === undefined ? '' : t.extra === false ? ',-' : `,*${key(t.extra)}`
      return `{${body}${extra}}`
    }
    case 'fn':
      return `fn#${t.id}`
    case 'union':
      return `(${t.of.map(key).sort().join('|')})`
  }
}

export const equals = (a: Ty, b: Ty) => key(a) === key(b)

/** Smart union: flattens, de-duplicates, absorbs literals into their base type. */
export function union(...input: Ty[]): Ty {
  const flat: Ty[] = []
  const push = (t: Ty) => {
    if (t.k === 'union') t.of.forEach(push)
    else if (t.k !== 'never') flat.push(t)
  }
  input.forEach(push)

  let hasAny = false
  let hasUndef = false
  let plainStr = false
  let plainNum = false
  let plainInt = false
  let plainBool = false
  let sawTrue = false
  let sawFalse = false
  for (const t of flat) {
    if (t.k === 'any') hasAny = true
    else if (t.k === 'undef') hasUndef = true
    else if (t.k === 'str' && t.v === undefined) plainStr = true
    else if (t.k === 'num' && t.v === undefined) {
      if (t.int) plainInt = true
      else plainNum = true
    } else if (t.k === 'bool') {
      if (t.v === undefined) plainBool = true
      else if (t.v) sawTrue = true
      else sawFalse = true
    }
  }
  if (sawTrue && sawFalse) plainBool = true
  if (plainNum) plainInt = false

  const out: Ty[] = []
  const seen = new Set<string>()
  const add = (t: Ty) => {
    const k = key(t)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(t)
    }
  }
  if (hasAny) add(ANY)
  for (const t of flat) {
    switch (t.k) {
      case 'any':
      case 'undef':
        break
      case 'str':
        if (t.v === undefined) add(STR)
        else if (!plainStr && !hasAny) add(t)
        break
      case 'num':
        if (hasAny) break
        if (t.v === undefined) {
          if (t.int ? plainInt : plainNum) add(t)
        } else if (plainNum || (plainInt && Number.isInteger(t.v))) {
          // absorbed
        } else add(t)
        break
      case 'bool':
        if (hasAny) break
        if (plainBool) add(BOOL)
        else add(t)
        break
      default:
        if (!hasAny) add(t)
    }
  }
  if (hasUndef) out.push(UNDEF)
  if (out.length === 0) return NEVER
  if (out.length === 1) return out[0]
  return { k: 'union', of: out }
}

export const members = (t: Ty): Ty[] => (t.k === 'union' ? t.of : t.k === 'never' ? [] : [t])

export const hasUndef = (t: Ty) => members(t).some((m) => m.k === 'undef')
export const removeUndef = (t: Ty): Ty => union(...members(t).filter((m) => m.k !== 'undef'))
export const isUndefOnly = (t: Ty) => t.k === 'undef'
export const mapMembers = (t: Ty, f: (m: Ty) => Ty): Ty => union(...members(t).map(f))

/** JSONata flattens arrays one level when collecting path results. */
export function elems(t: Ty): Ty {
  return union(
    ...members(t).map((m): Ty => {
      if (m.k === 'arr') return m.item
      if (m.k === 'undef') return NEVER
      return m
    }),
  )
}

/** Package a collected sequence the way JSONata does: empty -> undefined, one -> itself, many -> array. */
export function seq(elem: Ty, opts: { empty?: boolean } = {}): Ty {
  const e = removeUndef(elem)
  if (e.k === 'never') return UNDEF
  return union(opts.empty === false ? NEVER : UNDEF, e, arr(e))
}

/**
 * Drop literal-ness (`"a"` -> string), like TypeScript does for mutable positions.
 * With `keepInteger: false`, numeric literals become `number` rather than `integer` (accumulators).
 */
export function widen(t: Ty, keepInteger = true): Ty {
  return union(
    ...members(t).map((m): Ty => {
      switch (m.k) {
        case 'str':
          return STR
        case 'num':
          if (m.v === undefined) return m
          return keepInteger && Number.isInteger(m.v) ? INT : NUM
        case 'bool':
          return BOOL
        default:
          return m
      }
    }),
  )
}

export const canBeArray = (t: Ty) => members(t).some((m) => m.k === 'arr' || m.k === 'any')

/** true when every value of `from` is acceptable where `to` is expected. `any` is bidirectional. */
export function assignable(from: Ty, to: Ty): boolean {
  if (to.k === 'any' || from.k === 'any') return true
  if (from.k === 'never') return true
  if (from.k === 'union') return from.of.every((f) => assignable(f, to))
  if (to.k === 'union') return to.of.some((t) => assignable(from, t))
  switch (from.k) {
    case 'undef':
      return to.k === 'undef'
    case 'null':
      return to.k === 'null'
    case 'bool':
      return to.k === 'bool' && (to.v === undefined || to.v === from.v)
    case 'num':
      if (to.k !== 'num') return false
      if (to.v !== undefined) return from.v === to.v
      return !to.int || !!from.int || (from.v !== undefined && Number.isInteger(from.v))
    case 'str':
      return to.k === 'str' && (to.v === undefined || to.v === from.v)
    case 'arr':
      return to.k === 'arr' && assignable(from.item, to.item)
    case 'obj':
      return to.k === 'obj' && objAssignable(from, to)
    case 'fn':
      return to.k === 'fn'
    default:
      return false
  }
}

function objAssignable(from: Extract<Ty, { k: 'obj' }>, to: Extract<Ty, { k: 'obj' }>): boolean {
  for (const k of Object.keys(to.props)) {
    const want = to.props[k]
    const have = from.props[k]
    const wantReq = to.req.includes(k)
    if (have === undefined) {
      if (wantReq) return false
      continue
    }
    if (wantReq && !from.req.includes(k)) return false
    if (!assignable(removeUndef(have), removeUndef(want))) return false
  }
  if (to.extra === false) {
    if (Object.keys(from.props).some((k) => !(k in to.props))) return false
    if (from.extra !== false) return false
  } else if (to.extra !== undefined && to.extra.k !== 'any') {
    for (const k of Object.keys(from.props)) {
      if (!(k in to.props) && !assignable(removeUndef(from.props[k]), to.extra)) return false
    }
    if (from.extra && from.extra.k !== 'any' && !assignable(from.extra, to.extra)) return false
  }
  return true
}

/** Could one value be both `a` and `b`? Used to tell "always wrong" from "maybe wrong". */
export function overlaps(a: Ty, b: Ty): boolean {
  if (a.k === 'any' || b.k === 'any') return true
  if (a.k === 'never' || b.k === 'never') return false
  if (a.k === 'union') return a.of.some((m) => overlaps(m, b))
  if (b.k === 'union') return b.of.some((m) => overlaps(a, m))
  if (a.k !== b.k) return false
  switch (a.k) {
    case 'bool':
      return (b as typeof a).v === undefined || a.v === undefined || a.v === (b as typeof a).v
    case 'num': {
      const o = b as typeof a
      if (a.v !== undefined && o.v !== undefined) return a.v === o.v
      if (a.v !== undefined) return !o.int || Number.isInteger(a.v)
      if (o.v !== undefined) return !a.int || Number.isInteger(o.v)
      return true
    }
    case 'str': {
      const o = b as typeof a
      return a.v === undefined || o.v === undefined || a.v === o.v
    }
    default:
      return true
  }
}

const IDENT = /^[A-Za-z_$][\w$]*$/

/** TypeScript-flavoured pretty printer, used in diagnostics and node badges. */
export function show(t: Ty, depth = 0): string {
  switch (t.k) {
    case 'any':
      return 'any'
    case 'never':
      return 'never'
    case 'undef':
      return 'undefined'
    case 'null':
      return 'null'
    case 'bool':
      return t.v === undefined ? 'boolean' : String(t.v)
    case 'num':
      return t.v !== undefined ? String(t.v) : t.int ? 'integer' : 'number'
    case 'str':
      return t.v === undefined ? 'string' : JSON.stringify(t.v)
    case 'arr': {
      const inner = show(t.item, depth + 1)
      return t.item.k === 'union' || t.item.k === 'fn' ? `(${inner})[]` : `${inner}[]`
    }
    case 'fn':
      return t.name ? `function ${t.name}` : 'function'
    case 'union':
      return t.of.map((m) => show(m, depth + 1)).join(' | ')
    case 'obj': {
      const ks = Object.keys(t.props)
      if (ks.length === 0 && t.extra === undefined) return 'object'
      if (depth >= 3) return '{…}'
      const parts = ks.map((k) => {
        const name = IDENT.test(k) ? k : JSON.stringify(k)
        return `${name}${t.req.includes(k) ? '' : '?'}: ${show(t.props[k], depth + 1)}`
      })
      if (t.extra && t.extra.k !== 'any') parts.push(`[key: string]: ${show(t.extra, depth + 1)}`)
      else if (t.extra && t.extra.k === 'any') parts.push('[key: string]: any')
      return `{ ${parts.join('; ')} }`
    }
  }
}

/** Does a concrete JSON value conform to the type? (used by tests and by the fuzzer) */
export function matches(v: unknown, t: Ty): boolean {
  switch (t.k) {
    case 'any':
      return true
    case 'never':
      return false
    case 'undef':
      return v === undefined
    case 'null':
      return v === null
    case 'bool':
      return typeof v === 'boolean' && (t.v === undefined || t.v === v)
    case 'num':
      return (
        typeof v === 'number' && (t.v === undefined || t.v === v) && (!t.int || Number.isInteger(v))
      )
    case 'str':
      return typeof v === 'string' && (t.v === undefined || t.v === v)
    case 'arr':
      return Array.isArray(v) && v.every((x) => matches(x, t.item))
    case 'obj': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
      const o = v as Record<string, unknown>
      for (const k of t.req) if (!(k in o)) return false
      for (const k of Object.keys(o)) {
        if (k in t.props) {
          if (!matches(o[k], removeUndef(t.props[k]))) return false
        } else if (t.extra === false) return false
        else if (t.extra && !matches(o[k], t.extra)) return false
      }
      return true
    }
    case 'fn':
      return typeof v === 'function'
    case 'union':
      return t.of.some((m) => matches(v, m))
  }
}

/** Human-readable reason why `from` is not assignable to `to`, or null when it is. */
export function explain(from: Ty, to: Ty): string | null {
  if (assignable(from, to)) return null
  if (from.k === 'union') {
    for (const m of from.of) {
      const r = explain(m, to)
      if (r) return from.of.length > 1 && m.k === 'undef' ? 'the value may be undefined' : r
    }
  }
  if (from.k === 'undef') return 'the value may be undefined'
  if (from.k === 'obj' && to.k === 'obj') {
    for (const k of Object.keys(to.props)) {
      const have = from.props[k]
      const wantReq = to.req.includes(k)
      if (have === undefined) {
        if (wantReq) return `missing property "${k}"`
        continue
      }
      if (wantReq && !from.req.includes(k)) return `property "${k}" is optional but required here`
      const r = explain(removeUndef(have), removeUndef(to.props[k]))
      if (r) return `property "${k}": ${r}`
    }
    if (to.extra === false) return 'unexpected extra properties (target object is closed)'
  }
  if (from.k === 'arr' && to.k === 'arr') {
    const r = explain(from.item, to.item)
    if (r) return `array items: ${r}`
  }
  return `${show(from)} is not assignable to ${show(to)}`
}
