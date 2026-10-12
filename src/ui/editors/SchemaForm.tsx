import { useState } from 'react'
import type { JSONSchema, JSONSchemaObject } from '../../dry'

type S = JSONSchemaObject
type Kind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null'
  | 'any'
  | 'enum'
  | 'ref'
  | 'object'
  | 'array'
  | 'union'

const KIND_LABEL: Record<Kind, string> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  null: 'null',
  any: 'any',
  enum: 'enum (strings)',
  ref: 'named type',
  object: 'object',
  array: 'array',
  union: 'one of…',
}
const KINDS = Object.keys(KIND_LABEL) as Kind[]
const META = new Set(['title', 'description', 'default', 'examples', '$comment'])

const isObj = (s: JSONSchema | undefined): s is S => typeof s === 'object' && s !== null && !Array.isArray(s)
const isNullSchema = (s: JSONSchema) => isObj(s) && s.type === 'null' && Object.keys(s).length === 1

function unwrapNullable(s: S): { inner: S; nullable: boolean } {
  if (Array.isArray(s.anyOf) && s.anyOf.length === 2) {
    const [a, b] = s.anyOf
    if (isNullSchema(b) && !isNullSchema(a) && isObj(a)) return { inner: a, nullable: true }
    if (isNullSchema(a) && !isNullSchema(b) && isObj(b)) return { inner: b, nullable: true }
  }
  return { inner: s, nullable: false }
}

function kindOf(s: JSONSchema | undefined): Kind | 'raw' {
  if (s === undefined || s === true) return 'any'
  if (!isObj(s)) return 'raw'
  if (Object.keys(s).every((k) => META.has(k))) return 'any'
  if (typeof s.$ref === 'string') return 'ref'
  if (Array.isArray(s.enum) && s.enum.every((v) => typeof v === 'string')) return 'enum'
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) return 'union'
  switch (s.type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
    case 'object':
    case 'array':
      return s.type
  }
  if (s.properties) return 'object'
  return 'raw'
}

function make(kind: Kind, prev: S, refs: string[]): S {
  const meta: S = {}
  for (const k of META) if (k in prev) meta[k] = prev[k]
  switch (kind) {
    case 'any':
      return meta
    case 'enum':
      return { ...meta, enum: Array.isArray(prev.enum) ? prev.enum : ['a', 'b'] }
    case 'ref':
      return { ...meta, $ref: refs[0] ?? '' }
    case 'object':
      return { ...meta, type: 'object', properties: prev.properties ?? {}, required: prev.required ?? [] }
    case 'array':
      return { ...meta, type: 'array', items: (prev.items as JSONSchema) ?? { type: 'string' } }
    case 'union':
      return { ...meta, anyOf: [{ type: 'string' }, { type: 'null' }] }
    default:
      return { ...meta, type: kind }
  }
}

const inputCls =
  'rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-200 outline-none focus:border-indigo-500'

export function SchemaForm({
  value,
  onChange,
  typeNames,
}: {
  value: JSONSchema
  onChange: (next: JSONSchema) => void
  typeNames: string[]
}) {
  return (
    <div className="p-2">
      <SchemaNode value={value} onChange={onChange} typeNames={typeNames} depth={0} />
    </div>
  )
}

function SchemaNode({
  value,
  onChange,
  typeNames,
  depth,
}: {
  value: JSONSchema
  onChange: (next: JSONSchema) => void
  typeNames: string[]
  depth: number
}) {
  const obj: S = isObj(value) ? value : value === true ? {} : { not: {} }
  const { inner, nullable } = unwrapNullable(obj)
  const kind = kindOf(inner)
  const emit = (next: S) => onChange(nullable ? { anyOf: [next, { type: 'null' }] } : next)

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={inputCls}
          value={kind === 'raw' ? 'raw' : kind}
          onChange={(e) => {
            const k = e.target.value as Kind
            const next = make(k, inner, typeNames)
            onChange(nullable && k !== 'null' && k !== 'any' ? { anyOf: [next, { type: 'null' }] } : next)
          }}
        >
          {kind === 'raw' && <option value="raw">advanced…</option>}
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        {kind !== 'null' && kind !== 'any' && kind !== 'raw' && (
          <label className="flex items-center gap-1 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              checked={nullable}
              onChange={(e) => onChange(e.target.checked ? { anyOf: [inner, { type: 'null' }] } : inner)}
            />
            nullable
          </label>
        )}
        {kind === 'enum' && (
          <input
            className={`${inputCls} min-w-40 flex-1`}
            placeholder="comma, separated, values"
            defaultValue={(inner.enum as string[]).join(', ')}
            key={(inner.enum as string[]).join('|')}
            onBlur={(e) =>
              emit({
                ...inner,
                enum: e.target.value
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        )}
        {kind === 'ref' && (
          <select
            className={inputCls}
            value={String(inner.$ref)}
            onChange={(e) => emit({ ...inner, $ref: e.target.value })}
          >
            {!typeNames.includes(String(inner.$ref)) && <option value={String(inner.$ref)}>{String(inner.$ref) || '(none)'} ⚠</option>}
            {typeNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
        {kind === 'raw' && (
          <span className="font-mono text-[10px] text-zinc-500" title={JSON.stringify(inner, null, 2)}>
            {JSON.stringify(inner).slice(0, 60)} — edit in JSON or TypeBox
          </span>
        )}
      </div>

      {kind === 'object' && <ObjectBody schema={inner} emit={emit} typeNames={typeNames} depth={depth} />}

      {kind === 'array' && (
        <div className="ml-2 border-l border-zinc-800 pl-3">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">items</div>
          <SchemaNode
            value={(Array.isArray(inner.items) ? inner.items[0] : inner.items) ?? {}}
            onChange={(items) => emit({ ...inner, items })}
            typeNames={typeNames}
            depth={depth + 1}
          />
        </div>
      )}

      {kind === 'union' && (
        <UnionBody schema={inner} emit={emit} typeNames={typeNames} depth={depth} />
      )}
    </div>
  )
}

function ObjectBody({
  schema,
  emit,
  typeNames,
  depth,
}: {
  schema: S
  emit: (s: S) => void
  typeNames: string[]
  depth: number
}) {
  const props = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const [draft, setDraft] = useState('')

  const setProps = (next: Record<string, JSONSchema>, req = required) =>
    emit({ ...schema, properties: next, required: Object.keys(next).filter((k) => req.has(k)) })

  const rename = (from: string, to: string) => {
    const name = to.trim()
    if (!name || name === from || name in props) return
    const next: Record<string, JSONSchema> = {}
    for (const [k, v] of Object.entries(props)) next[k === from ? name : k] = v
    const req = new Set([...required].map((k) => (k === from ? name : k)))
    setProps(next, req)
  }

  const add = () => {
    let name = draft.trim()
    if (!name) {
      let i = Object.keys(props).length + 1
      while (`field${i}` in props) i++
      name = `field${i}`
    }
    if (name in props) return
    setDraft('')
    setProps({ ...props, [name]: { type: 'string' } }, new Set([...required, name]))
  }

  return (
    <div className="ml-2 space-y-1.5 border-l border-zinc-800 pl-3">
      {Object.entries(props).map(([name, sub]) => (
        <div key={name} className="rounded border border-zinc-800/80 bg-zinc-900/40 p-1.5">
          <div className="mb-1 flex items-center gap-2">
            <input
              className={`${inputCls} w-36 font-mono`}
              defaultValue={name}
              key={name}
              onBlur={(e) => rename(name, e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <label className="flex items-center gap-1 text-[11px] text-zinc-400">
              <input
                type="checkbox"
                checked={required.has(name)}
                onChange={(e) => {
                  const req = new Set(required)
                  if (e.target.checked) req.add(name)
                  else req.delete(name)
                  setProps(props, req)
                }}
              />
              required
            </label>
            <button
              type="button"
              className="ml-auto rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
              title="Remove property"
              onClick={() => {
                const next = { ...props }
                delete next[name]
                setProps(next)
              }}
            >
              ✕
            </button>
          </div>
          <SchemaNode
            value={sub}
            onChange={(v) => setProps({ ...props, [name]: v })}
            typeNames={typeNames}
            depth={depth + 1}
          />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          className={`${inputCls} w-36 font-mono`}
          placeholder="new property"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button type="button" className="rounded bg-zinc-800 px-2 py-0.5 text-xs hover:bg-zinc-700" onClick={add}>
          + property
        </button>
        <label className="ml-auto flex items-center gap-1 text-[11px] text-zinc-400" title="additionalProperties">
          extra keys
          <select
            className={inputCls}
            value={schema.additionalProperties === false ? 'no' : schema.additionalProperties === undefined ? 'unset' : 'yes'}
            onChange={(e) => {
              const next: S = { ...schema }
              if (e.target.value === 'unset') delete next.additionalProperties
              else next.additionalProperties = e.target.value === 'no' ? false : true
              emit(next)
            }}
          >
            <option value="unset">unspecified</option>
            <option value="no">forbidden</option>
            <option value="yes">allowed (any)</option>
          </select>
        </label>
      </div>
    </div>
  )
}

function UnionBody({
  schema,
  emit,
  typeNames,
  depth,
}: {
  schema: S
  emit: (s: S) => void
  typeNames: string[]
  depth: number
}) {
  const key = Array.isArray(schema.anyOf) ? 'anyOf' : 'oneOf'
  const list = (schema[key] as JSONSchema[]) ?? []
  const set = (next: JSONSchema[]) => emit({ ...schema, [key]: next })
  return (
    <div className="ml-2 space-y-1.5 border-l border-zinc-800 pl-3">
      {list.map((v, i) => (
        <div key={i} className="flex gap-2 rounded border border-zinc-800/80 bg-zinc-900/40 p-1.5">
          <div className="min-w-0 flex-1">
            <SchemaNode
              value={v}
              onChange={(nv) => set(list.map((x, j) => (j === i ? nv : x)))}
              typeNames={typeNames}
              depth={depth + 1}
            />
          </div>
          <button
            type="button"
            className="h-6 rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
            onClick={() => set(list.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="rounded bg-zinc-800 px-2 py-0.5 text-xs hover:bg-zinc-700"
        onClick={() => set([...list, { type: 'string' }])}
      >
        + variant
      </button>
    </div>
  )
}
