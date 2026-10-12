import { useMemo } from 'react'
import { fromSchema, show } from '../dry'
import type { NodeKind } from '../flow/model'
import { useStore } from '../store'
import { KIND_STYLE } from './nodes/kinds'

const PALETTE: { kind: NodeKind; hint: string }[] = [
  { kind: 'transform', hint: 'JSONata transform: typed object in, typed object out' },
  { kind: 'condition', hint: 'JSONata expression that must produce a boolean' },
  { kind: 'branch', hint: 'Takes a boolean; its yes / no gates trigger what follows' },
  { kind: 'loop', hint: 'Iterate an array (map or reduce); the body hangs off the "each" gate' },
  { kind: 'call', hint: 'Call a function from the list below (sync, or async fire-and-forget)' },
  { kind: 'return', hint: 'Return a value; all reachable returns must agree on a type' },
]

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{children}</h3>
      {action}
    </div>
  )
}

export function LeftPanel() {
  const types = useStore((s) => s.doc.types)
  const functions = useStore((s) => s.doc.functions)
  const selection = useStore((s) => s.selection)
  const addNode = useStore((s) => s.addNode)
  const addType = useStore((s) => s.addType)
  const addFunction = useStore((s) => s.addFunction)
  const removeType = useStore((s) => s.removeType)
  const removeFunction = useStore((s) => s.removeFunction)
  const setSelection = useStore((s) => s.setSelection)

  const defs = useMemo(() => Object.fromEntries(types.map((t) => [t.name, t.spec.schema])), [types])
  const summarize = (schema: Parameters<typeof fromSchema>[0]) => show(fromSchema(schema, { defs }))

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-y-auto bg-zinc-950">
      <SectionTitle>Add node</SectionTitle>
      <div className="grid grid-cols-2 gap-1.5 px-3">
        {PALETTE.map(({ kind, hint }) => (
          <button
            key={kind}
            type="button"
            title={hint}
            onClick={() => addNode(kind)}
            className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left text-xs text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800"
          >
            <span
              className="flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-bold text-zinc-950"
              style={{ background: KIND_STYLE[kind].accent }}
            >
              {KIND_STYLE[kind].glyph}
            </span>
            {KIND_STYLE[kind].name}
          </button>
        ))}
      </div>

      <SectionTitle
        action={
          <button
            type="button"
            className="rounded bg-zinc-800 px-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
            onClick={addType}
            title="Define a named type"
          >
            +
          </button>
        }
      >
        Types
      </SectionTitle>
      <ul className="px-2">
        {types.length === 0 && <li className="px-1 py-1 text-[11px] text-zinc-600">No named types yet.</li>}
        {types.map((t) => {
          const active = selection?.kind === 'type' && selection.id === t.id
          return (
            <li key={t.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => setSelection({ kind: 'type', id: t.id })}
                onKeyDown={(e) => e.key === 'Enter' && setSelection({ kind: 'type', id: t.id })}
                className={`group flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 ${
                  active ? 'bg-indigo-500/15' : 'hover:bg-zinc-900'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-violet-300">{t.name}</div>
                  <div className="truncate font-mono text-[10px] text-zinc-500" title={summarize(t.spec.schema)}>
                    {summarize(t.spec.schema)}
                  </div>
                </div>
                <button
                  type="button"
                  className="hidden rounded px-1 text-zinc-500 hover:text-red-400 group-hover:block"
                  title="Delete type"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeType(t.id)
                  }}
                >
                  ✕
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <SectionTitle
        action={
          <button
            type="button"
            className="rounded bg-zinc-800 px-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
            onClick={addFunction}
            title="Define a function (input type → output type)"
          >
            +
          </button>
        }
      >
        Functions
      </SectionTitle>
      <ul className="px-2 pb-4">
        {functions.length === 0 && <li className="px-1 py-1 text-[11px] text-zinc-600">No functions yet.</li>}
        {functions.map((f) => {
          const active = selection?.kind === 'function' && selection.id === f.id
          return (
            <li key={f.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => setSelection({ kind: 'function', id: f.id })}
                onKeyDown={(e) => e.key === 'Enter' && setSelection({ kind: 'function', id: f.id })}
                className={`group flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 ${
                  active ? 'bg-indigo-500/15' : 'hover:bg-zinc-900'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-rose-300">{f.name}</div>
                  <div
                    className="truncate font-mono text-[10px] text-zinc-500"
                    title={`${summarize(f.input.schema)} → ${summarize(f.output.schema)}`}
                  >
                    {summarize(f.input.schema)} → {summarize(f.output.schema)}
                  </div>
                </div>
                <button
                  type="button"
                  className="hidden rounded px-1 text-zinc-500 hover:text-red-400 group-hover:block"
                  title="Delete function"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeFunction(f.id)
                  }}
                >
                  ✕
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
