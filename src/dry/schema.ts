import {
  ANY,
  BOOL,
  INT,
  NEVER,
  NULL,
  NUM,
  STR,
  arr,
  bool,
  members,
  num,
  obj,
  removeUndef,
  str,
  union,
  assignable,
  type Ty,
} from './ty'

export interface JSONSchemaObject {
  $schema?: string
  $id?: string
  $ref?: string
  $defs?: Record<string, JSONSchema>
  definitions?: Record<string, JSONSchema>
  type?: string | string[]
  title?: string
  description?: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  additionalProperties?: JSONSchema
  patternProperties?: Record<string, JSONSchema>
  items?: JSONSchema | JSONSchema[]
  prefixItems?: JSONSchema[]
  enum?: unknown[]
  const?: unknown
  anyOf?: JSONSchema[]
  oneOf?: JSONSchema[]
  allOf?: JSONSchema[]
  nullable?: boolean
  [k: string]: unknown
}
export type JSONSchema = JSONSchemaObject | boolean

export interface SchemaContext {
  /** named types, referenced as `{ "$ref": "Name" }` or `#/$defs/Name` */
  defs?: Record<string, JSONSchema>
  onUnresolved?: (ref: string) => void
}

const REF_PREFIXES = ['#/$defs/', '#/definitions/', '#/components/schemas/']

export function refName(ref: string): string {
  for (const p of REF_PREFIXES) if (ref.startsWith(p)) return ref.slice(p.length)
  return ref
}

/** Type of a concrete JSON value (used for `const` / `enum`). */
export function fromValue(v: unknown): Ty {
  if (v === null) return NULL
  switch (typeof v) {
    case 'string':
      return str(v)
    case 'number':
      return num(v)
    case 'boolean':
      return bool(v)
    case 'object':
      if (Array.isArray(v)) return arr(union(...v.map(fromValue)))
      return obj(Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, fromValue(x)])))
    default:
      return ANY
  }
}

function intersect(a: Ty, b: Ty): Ty {
  if (a.k === 'obj' && b.k === 'obj') {
    const props: Record<string, Ty> = { ...a.props }
    for (const [k, t] of Object.entries(b.props)) {
      props[k] = k in props ? intersect(props[k], t) : t
    }
    const req = [...new Set([...a.req, ...b.req])]
    return obj(props, req, a.extra === false || b.extra === false ? false : (a.extra ?? b.extra))
  }
  if (a.k === 'any') return b
  if (b.k === 'any') return a
  if (assignable(a, b)) return a
  if (assignable(b, a)) return b
  return a
}

export function fromSchema(
  s: JSONSchema | undefined,
  ctx: SchemaContext = {},
  stack: string[] = [],
): Ty {
  if (s === undefined || s === true) return ANY
  if (s === false) return NEVER
  if (typeof s !== 'object' || s === null) return ANY

  if (typeof s.$ref === 'string') {
    const name = refName(s.$ref)
    const target = ctx.defs?.[name]
    if (target === undefined) {
      ctx.onUnresolved?.(s.$ref)
      return ANY
    }
    if (stack.includes(name)) return ANY // recursive type: give up gracefully
    return fromSchema(target, ctx, [...stack, name])
  }

  const sub = (x: JSONSchema | undefined) => fromSchema(x, ctx, stack)
  let base: Ty | undefined

  if (s.const !== undefined) base = fromValue(s.const)
  else if (Array.isArray(s.enum)) base = union(...s.enum.map(fromValue))
  else if (Array.isArray(s.anyOf)) base = union(...s.anyOf.map(sub))
  else if (Array.isArray(s.oneOf)) base = union(...s.oneOf.map(sub))
  else if (Array.isArray(s.allOf)) base = s.allOf.map(sub).reduce((a, b) => intersect(a, b), ANY)
  else if (Array.isArray(s.type)) base = union(...s.type.map((t) => fromType(t, s, ctx, stack)))
  else if (typeof s.type === 'string') base = fromType(s.type, s, ctx, stack)
  else if (s.properties || s.required) base = fromType('object', s, ctx, stack)
  else if (s.items || s.prefixItems) base = fromType('array', s, ctx, stack)
  else base = ANY

  if (s.nullable === true) base = union(base, NULL)
  return base
}

function fromType(type: string, s: JSONSchemaObject, ctx: SchemaContext, stack: string[]): Ty {
  switch (type) {
    case 'string':
      return STR
    case 'number':
      return NUM
    case 'integer':
      return INT
    case 'boolean':
      return BOOL
    case 'null':
      return NULL
    case 'array': {
      if (Array.isArray(s.items)) return arr(union(...s.items.map((i) => fromSchema(i, ctx, stack))))
      if (Array.isArray(s.prefixItems)) {
        const rest = s.items === undefined ? ANY : fromSchema(s.items as JSONSchema, ctx, stack)
        return arr(union(...s.prefixItems.map((i) => fromSchema(i, ctx, stack)), rest))
      }
      return arr(s.items === undefined ? ANY : fromSchema(s.items, ctx, stack))
    }
    case 'object': {
      const props: Record<string, Ty> = {}
      for (const [k, v] of Object.entries(s.properties ?? {})) props[k] = fromSchema(v, ctx, stack)
      const required = (s.required ?? []).filter((k) => typeof k === 'string')
      for (const k of required) if (!(k in props)) props[k] = ANY
      let extra: Ty | false | undefined
      if (s.additionalProperties === false) extra = false
      else if (s.additionalProperties === true) extra = ANY
      else if (s.additionalProperties !== undefined)
        extra = fromSchema(s.additionalProperties, ctx, stack)
      else if (s.patternProperties)
        extra = union(...Object.values(s.patternProperties).map((p) => fromSchema(p, ctx, stack)))
      return obj(props, required, extra)
    }
    default:
      return ANY
  }
}

/** Convert back to JSON Schema. `undef` members are dropped (callers track optionality). */
export function toSchema(t: Ty): JSONSchema {
  switch (t.k) {
    case 'any':
      return {}
    case 'never':
    case 'undef':
      return { not: {} }
    case 'null':
      return { type: 'null' }
    case 'bool':
      return t.v === undefined ? { type: 'boolean' } : { const: t.v }
    case 'num':
      return t.v !== undefined ? { const: t.v } : { type: t.int ? 'integer' : 'number' }
    case 'str':
      return t.v === undefined ? { type: 'string' } : { const: t.v }
    case 'arr':
      return { type: 'array', items: toSchema(removeUndef(t.item)) }
    case 'fn':
      return { 'x-jsonata-function': true }
    case 'obj': {
      const properties: Record<string, JSONSchema> = {}
      for (const [k, v] of Object.entries(t.props)) properties[k] = toSchema(removeUndef(v))
      const out: JSONSchemaObject = { type: 'object', properties }
      const req = t.req.filter((k) => k in t.props)
      if (req.length) out.required = req
      if (t.extra === false) out.additionalProperties = false
      else if (t.extra) out.additionalProperties = t.extra.k === 'any' ? true : toSchema(t.extra)
      return out
    }
    case 'union': {
      const ms = members(t).filter((m) => m.k !== 'undef')
      if (ms.length === 0) return { not: {} }
      if (ms.length === 1) return toSchema(ms[0])
      const lits = ms.filter(
        (m) => (m.k === 'str' || m.k === 'num' || m.k === 'bool') && m.v !== undefined,
      )
      const rest = ms.filter((m) => !lits.includes(m))
      const parts: JSONSchema[] = []
      if (lits.length > 1) {
        parts.push({ enum: lits.map((l) => (l as { v: unknown }).v) })
      } else lits.forEach((l) => parts.push(toSchema(l)))
      // collapse plain primitives into a `type` array
      const prim = rest.filter(
        (m) => m.k === 'str' || m.k === 'null' || m.k === 'bool' || (m.k === 'num' && !m.v),
      )
      const complex = rest.filter((m) => !prim.includes(m))
      if (prim.length > 1) {
        parts.push({ type: prim.map((p) => (toSchema(p) as { type: string }).type) })
      } else prim.forEach((p) => parts.push(toSchema(p)))
      complex.forEach((c) => parts.push(toSchema(c)))
      return parts.length === 1 ? parts[0] : { anyOf: parts }
    }
  }
}

/**
 * Rewrite `$ref: "Name"` (how named types are referenced in the app) to standard
 * `#/$defs/Name` pointers and attach the definitions, so generic JSON Schema tooling can use it.
 */
export function standardizeRefs(schema: JSONSchema, defs: Record<string, JSONSchema>): JSONSchema {
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk)
    if (s === null || typeof s !== 'object') return s
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s)) {
      if (k === '$ref' && typeof v === 'string') {
        const name = refName(v)
        out[k] = name in defs ? `#/$defs/${name}` : v
      } else out[k] = walk(v)
    }
    return out
  }
  const base = walk(schema)
  const $defs = Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, walk(v)]))
  return typeof base === 'object' && base !== null && !Array.isArray(base)
    ? ({ ...(base as object), $defs } as JSONSchema)
    : (base as JSONSchema)
}
