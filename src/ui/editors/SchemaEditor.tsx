import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSONSchema } from '../../dry'
import type { SchemaMode, SchemaSpec } from '../../flow/model'
import { evalTypeBox, schemaToTypeBox } from '../../schema/typebox'
import { LazyCode } from './LazyCode'
import { SchemaForm } from './SchemaForm'

const TABS: { id: SchemaMode; label: string; hint: string }[] = [
  { id: 'json', label: 'JSON Schema', hint: 'Edit the schema as JSON (Monaco)' },
  { id: 'form', label: 'Form', hint: 'Edit visually' },
  { id: 'typebox', label: 'TypeBox', hint: 'Write @sinclair/typebox code, e.g. t.Object({ … })' },
]

/**
 * One schema, three ways to edit it. JSON Schema is always the canonical form: the other two
 * modes read from / write to it, and TypeBox additionally keeps its source text.
 */
export function SchemaEditor({
  spec,
  onChange,
  typeNames,
  pathKey,
}: {
  spec: SchemaSpec
  onChange: (next: SchemaSpec) => void
  /** names of the defined types, offered as `$ref` targets */
  typeNames: string[]
  /** unique id so every editor gets its own Monaco model */
  pathKey: string
}) {
  const mode = spec.mode

  const switchTo = (next: SchemaMode) => {
    if (next === mode) return
    if (next === 'typebox' && spec.typebox === undefined) {
      onChange({ ...spec, mode: next, typebox: schemaToTypeBox(spec.schema) })
    } else onChange({ ...spec, mode: next })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.hint}
            onClick={() => switchTo(t.id)}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              mode === t.id ? 'bg-indigo-500/20 text-indigo-200' : 'text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {mode === 'json' && <JsonPane spec={spec} onChange={onChange} path={`schema-${pathKey}.json`} typeNames={typeNames} />}
        {mode === 'form' && (
          <div className="h-full overflow-auto">
            <SchemaForm
              value={spec.schema}
              typeNames={typeNames}
              onChange={(schema) => onChange({ schema, mode: 'form' })}
            />
          </div>
        )}
        {mode === 'typebox' && <TypeBoxPane spec={spec} onChange={onChange} path={`typebox-${pathKey}.ts`} typeNames={typeNames} />}
      </div>
    </div>
  )
}

function Status({ error, okText }: { error: string | null; okText: string }) {
  return (
    <div
      className={`shrink-0 truncate border-t border-zinc-800 px-3 py-1 text-[11px] ${
        error ? 'text-red-400' : 'text-emerald-400/80'
      }`}
      title={error ?? undefined}
    >
      {error ?? okText}
    </div>
  )
}

function JsonPane({
  spec,
  onChange,
  path,
  typeNames,
}: {
  spec: SchemaSpec
  onChange: (s: SchemaSpec) => void
  path: string
  typeNames: string[]
}) {
  const canonical = useMemo(() => JSON.stringify(spec.schema, null, 2), [spec.schema])
  const [text, setText] = useState(canonical)
  const [error, setError] = useState<string | null>(null)
  const emitted = useRef(canonical)

  // pick up changes made elsewhere (form, another tab) without clobbering the user's own typing
  useEffect(() => {
    if (canonical !== emitted.current) {
      emitted.current = canonical
      setText(canonical)
      setError(null)
    }
  }, [canonical])

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <LazyCode
          language="json"
          typeNames={typeNames}
          path={path}
          value={text}
          onChange={(v) => {
            setText(v)
            try {
              const parsed = JSON.parse(v) as JSONSchema
              emitted.current = JSON.stringify(parsed, null, 2)
              setError(null)
              onChange({ schema: parsed, mode: 'json' })
            } catch (e) {
              setError((e as Error).message)
            }
          }}
        />
      </div>
      <Status error={error} okText="Valid JSON" />
    </div>
  )
}

function TypeBoxPane({
  spec,
  onChange,
  path,
  typeNames,
}: {
  spec: SchemaSpec
  onChange: (s: SchemaSpec) => void
  path: string
  typeNames: string[]
}) {
  const source = spec.typebox ?? schemaToTypeBox(spec.schema)
  const [text, setText] = useState(source)
  const [error, setError] = useState<string | null>(() => {
    const r = evalTypeBox(source)
    return r.ok ? null : r.error
  })
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <LazyCode
          language="typescript"
          typeNames={typeNames}
          path={path}
          value={text}
          onChange={(v) => {
            setText(v)
            const r = evalTypeBox(v)
            if (r.ok) {
              setError(null)
              onChange({ schema: r.schema, mode: 'typebox', typebox: v })
            } else {
              setError(r.error)
              // keep the draft, keep the last good schema
              onChange({ schema: spec.schema, mode: 'typebox', typebox: v })
            }
          }}
        />
      </div>
      <Status error={error} okText="Compiles to JSON Schema" />
    </div>
  )
}
