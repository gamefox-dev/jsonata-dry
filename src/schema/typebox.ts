import { Type } from '@sinclair/typebox'
import type { JSONSchema, JSONSchemaObject } from '../dry'

type Builder = typeof Type

export type TypeBoxResult = { ok: true; schema: JSONSchema } | { ok: false; error: string }

/**
 * Run a TypeBox program (e.g. `t.Object({ name: t.String() })`) and return its JSON Schema.
 *
 * `t` and `Type` are both bound to TypeBox's builder. The source may be a single expression or a
 * function body ending in `return`. It runs in the page with no sandbox, i.e. it is trusted the same
 * way the JSON you type into the app is.
 */
export function evalTypeBox(source: string): TypeBoxResult {
  const code = source
    .replace(/^\s*import\s[^;\n]*;?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/m, '')
    .trim()
  if (!code) return { ok: false, error: 'Write a TypeBox expression, e.g. t.Object({ name: t.String() })' }

  let value: unknown
  try {
    let runner: (t: Builder, Type: Builder) => unknown
    try {
      runner = new Function('t', 'Type', `"use strict"; return (\n${code}\n);`) as typeof runner
    } catch {
      runner = new Function('t', 'Type', `"use strict";\n${code}`) as typeof runner
    }
    value = runner(Type, Type)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'The program must evaluate to a TypeBox schema (got ' + typeof value + ').' }
  }
  // JSON round trip drops TypeBox's symbol-keyed metadata, leaving plain JSON Schema
  return { ok: true, schema: JSON.parse(JSON.stringify(value)) as JSONSchema }
}

const IDENT = /^[A-Za-z_$][\w$]*$/
const q = (s: string) => JSON.stringify(s)

/** Print a JSON Schema as TypeBox code (best effort; unknown keywords are dropped). */
export function schemaToTypeBox(schema: JSONSchema, indent = 0): string {
  const pad = '  '.repeat(indent + 1)
  const end = '  '.repeat(indent)
  const sub = (s: JSONSchema) => schemaToTypeBox(s, indent + 1)

  if (schema === true) return 't.Any()'
  if (schema === false) return 't.Never()'
  const s: JSONSchemaObject = schema
  if (typeof s.$ref === 'string') return `t.Ref(${q(s.$ref)})`
  if ('const' in s) return `t.Literal(${JSON.stringify(s.const)})`
  if (Array.isArray(s.enum)) {
    return s.enum.length === 1
      ? `t.Literal(${JSON.stringify(s.enum[0])})`
      : `t.Union([${s.enum.map((v) => `t.Literal(${JSON.stringify(v)})`).join(', ')}])`
  }
  const union = (list: JSONSchema[], fn: string) =>
    `t.${fn}([\n${list.map((x) => pad + sub(x)).join(',\n')},\n${end}])`
  if (s.anyOf) return union(s.anyOf, 'Union')
  if (s.oneOf) return union(s.oneOf, 'Union')
  if (s.allOf) return union(s.allOf, 'Intersect')
  if (Array.isArray(s.type)) {
    return union(
      s.type.map((type) => ({ ...s, type })),
      'Union',
    )
  }
  switch (s.type) {
    case 'string':
      return 't.String()'
    case 'number':
      return 't.Number()'
    case 'integer':
      return 't.Integer()'
    case 'boolean':
      return 't.Boolean()'
    case 'null':
      return 't.Null()'
    case 'array':
      return `t.Array(${s.items && !Array.isArray(s.items) ? sub(s.items) : 't.Any()'})`
    case 'object': {
      const props = Object.entries(s.properties ?? {})
      const ap = s.additionalProperties
      if (props.length === 0 && ap !== undefined && ap !== false) {
        return `t.Record(t.String(), ${ap === true ? 't.Any()' : sub(ap)})`
      }
      if (props.length === 0 && ap === undefined) return 't.Object({})'
      const required = new Set(s.required ?? [])
      const body = props
        .map(([k, v]) => {
          const code = sub(v)
          return `${pad}${IDENT.test(k) ? k : q(k)}: ${required.has(k) ? code : `t.Optional(${code})`},`
        })
        .join('\n')
      const opts = ap === false ? ', { additionalProperties: false }' : ''
      return `t.Object({\n${body}\n${end}}${opts})`
    }
  }
  if (s.properties) return schemaToTypeBox({ ...s, type: 'object' }, indent)
  if (s.items) return schemaToTypeBox({ ...s, type: 'array' }, indent)
  return 't.Any()'
}
