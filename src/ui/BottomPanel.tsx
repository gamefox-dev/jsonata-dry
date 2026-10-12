import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ANY, fromSchema, show } from '../dry'
import type { Diagnostic } from '../dry'
import type { Msg, TypeInfo } from '../flow/analyze'
import type { FlowNode } from '../flow/model'
import { sampleInput, useStore } from '../store'
import { standardizeRefs } from '../dry'
import { LazyCode } from './editors/LazyCode'
import { SchemaEditor } from './editors/SchemaEditor'
import { KIND_STYLE } from './nodes/kinds'
import { TypeChip } from './TypeChip'
import { tyColor } from './typeColors'

/* ---------- small shared pieces ---------- */

const field =
  'rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500'

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-zinc-800/80 px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h4>
        {right}
      </div>
      {children}
    </section>
  )
}

const SEV_COLOR = { error: '#ef4444', warning: '#f59e0b', info: '#60a5fa' } as const

function Messages({ messages, empty }: { messages: (Msg | Diagnostic)[]; empty?: string }) {
  if (messages.length === 0) {
    return <div className="text-xs text-emerald-400/80">{empty ?? 'No issues'}</div>
  }
  return (
    <ul className="space-y-1">
      {messages.map((m, i) => (
        <li key={i} className="flex gap-2 text-xs leading-4 text-zinc-300">
          <span className="mt-1 size-1.5 shrink-0 rounded-full" style={{ background: SEV_COLOR[m.severity] }} />
          <span>{m.message}</span>
        </li>
      ))}
    </ul>
  )
}

function TypeView({ info, empty = 'not available' }: { info: TypeInfo | null | undefined; empty?: string }) {
  const [json, setJson] = useState(false)
  if (!info) return <div className="text-xs text-zinc-600">{empty}</div>
  return (
    <div>
      <div className="flex items-start gap-2">
        <span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: tyColor(info.ty) }} />
        <code className="min-w-0 flex-1 break-words font-mono text-xs leading-5 text-zinc-200">{info.type}</code>
        <button
          type="button"
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
            json ? 'bg-indigo-500/20 text-indigo-200' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
          }`}
          onClick={() => setJson((v) => !v)}
          title="Show as JSON Schema"
        >
          JSON Schema
        </button>
      </div>
      {info.optional && (
        <div className="mt-1 text-[10px] text-amber-400/90">may be undefined (no value) at runtime</div>
      )}
      {json && (
        <pre className="mt-2 max-h-56 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] leading-4 text-zinc-300">
          {JSON.stringify(info.schema, null, 2)}
        </pre>
      )}
    </div>
  )
}

function Header({ id, kind, title }: { id: string; kind: keyof typeof KIND_STYLE; title: string }) {
  const update = useStore((s) => s.updateNodeData)
  const node = useStore((s) => s.doc.nodes.find((n) => n.id === id))
  const style = KIND_STYLE[kind]
  return (
    <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
      <span
        className="flex size-5 items-center justify-center rounded text-[11px] font-bold text-zinc-950"
        style={{ background: style.accent }}
      >
        {style.glyph}
      </span>
      <span className="text-xs font-medium text-zinc-300">{style.name}</span>
      {node && (
        <input
          className={`${field} ml-2 w-56 py-0.5`}
          placeholder={title}
          value={node.data.label ?? ''}
          onChange={(e) => update(id, { label: e.target.value })}
        />
      )}
      <span className="ml-auto font-mono text-[10px] text-zinc-600">{id}</span>
    </div>
  )
}

/** two columns: the editing surface, and what the dry-run says about it */
function Split({ editor, side }: { editor: ReactNode; side: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1">{editor}</div>
      <div className="w-[min(420px,45%)] shrink-0 overflow-y-auto border-l border-zinc-800 bg-zinc-950/60">
        {side}
      </div>
    </div>
  )
}

/* ---------- inspectors ---------- */

function ExpressionInspector({ node }: { node: Extract<FlowNode, { type: 'transform' | 'condition' }> }) {
  const { id } = node
  const report = useStore((s) => s.analysis.nodes[id])
  const update = useStore((s) => s.updateNodeData)
  const [newVar, setNewVar] = useState('')
  const dry = report?.dry
  const markers = useMemo(
    () =>
      (dry?.diagnostics ?? [])
        .filter((d) => d.start !== undefined && d.end !== undefined)
        .map((d) => ({
          start: d.start as number,
          end: d.end as number,
          severity: d.severity,
          message: d.message,
        })),
    [dry],
  )
  const completion = useMemo(
    () => ({
      input: report?.inputs.in?.ty ?? null,
      bindings: Object.fromEntries(
        node.data.variables.map((v) => [v, report?.inputs[`var:${v}`]?.ty ?? ANY]),
      ),
    }),
    [report?.inputs, node.data.variables],
  )
  const isCondition = node.type === 'condition'
  const addVar = () => {
    const v = newVar.trim().replace(/^\$/, '')
    if (!/^[A-Za-z_]\w*$/.test(v) || node.data.variables.includes(v)) return
    update(id, { variables: [...node.data.variables, v] })
    setNewVar('')
  }

  return (
    <>
      <Header id={id} kind={node.type} title={isCondition ? 'Condition' : 'Transform'} />
      <Split
        editor={
          <LazyCode
            language="jsonata"
            path={`expr-${id}.jsonata`}
            value={node.data.expression}
            onChange={(expression) => update(id, { expression })}
            markers={markers}
            completion={completion}
          />
        }
        side={
          <>
            <Section title="Input  ($)">
              <TypeView info={report?.inputs.in} empty="Nothing connected: the input is untyped (any)" />
            </Section>
            <Section
              title="Variables"
              right={<span className="text-[10px] text-zinc-600">extra typed inputs, used as $name</span>}
            >
              <ul className="space-y-1">
                {node.data.variables.map((v) => (
                  <li key={v} className="flex items-center gap-2">
                    <code className="font-mono text-xs text-sky-300">${v}</code>
                    <TypeChip info={report?.inputs[`var:${v}`]} max={40} />
                    <button
                      type="button"
                      className="ml-auto rounded px-1 text-zinc-500 hover:text-red-400"
                      onClick={() => update(id, { variables: node.data.variables.filter((x) => x !== v) })}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 flex gap-1.5">
                <input
                  className={`${field} w-32 font-mono`}
                  placeholder="name"
                  value={newVar}
                  onChange={(e) => setNewVar(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addVar()}
                />
                <button type="button" className="rounded bg-zinc-800 px-2 text-xs hover:bg-zinc-700" onClick={addVar}>
                  + variable
                </button>
              </div>
            </Section>
            <Section title={isCondition ? 'Result (boolean)' : 'Result type'}>
              <TypeView info={report?.outputs.out} />
            </Section>
            <Section title="Dry-run diagnostics">
              <Messages messages={dry?.diagnostics ?? []} empty="Expression type-checks" />
            </Section>
            <Section title="Node">
              <Messages messages={(report?.messages ?? []).filter((m) => !m.message.startsWith('Expression:'))} />
            </Section>
          </>
        }
      />
    </>
  )
}

function InputInspector({ node }: { node: Extract<FlowNode, { type: 'input' }> }) {
  const { id } = node
  const report = useStore((s) => s.analysis.nodes[id])
  const update = useStore((s) => s.updateNodeData)
  const types = useStore((s) => s.doc.types)
  const names = useMemo(() => types.map((t) => t.name), [types])
  return (
    <>
      <Header id={id} kind="input" title="Input" />
      <Split
        editor={
          <SchemaEditor
            key={id}
            pathKey={id}
            spec={node.data.spec}
            typeNames={names}
            onChange={(spec) => update(id, { spec })}
          />
        }
        side={
          <>
            <Section title="Flow input type">
              <TypeView info={report?.outputs.out} />
            </Section>
            <Section title="About">
              <p className="text-xs leading-5 text-zinc-400">
                This is the single entry point. Define its type as JSON Schema, with the form, or with TypeBox
                code (<code className="text-zinc-300">t.Object({'{ … }'})</code>). Reference a named type from
                the left panel with <code className="text-zinc-300">{'{ "$ref": "Name" }'}</code> or{' '}
                <code className="text-zinc-300">t.Ref("Name")</code>.
              </p>
            </Section>
            <Section title="Issues">
              <Messages messages={report?.messages ?? []} />
            </Section>
          </>
        }
      />
    </>
  )
}

function BranchInspector({ node }: { node: Extract<FlowNode, { type: 'branch' }> }) {
  const report = useStore((s) => s.analysis.nodes[node.id])
  const gate = (id: 'yes' | 'no') => report?.gates[id]
  return (
    <>
      <Header id={node.id} kind="branch" title="Branch" />
      <div className="flex-1 overflow-y-auto">
        <Section title="Condition">
          <TypeView info={report?.inputs.in} empty="No condition connected" />
        </Section>
        <Section title="Gates">
          {(['yes', 'no'] as const).map((g) => (
            <div key={g} className="flex items-center gap-2 py-0.5 text-xs">
              <span className="w-8 font-medium" style={{ color: g === 'yes' ? '#4ade80' : '#f87171' }}>
                {g}
              </span>
              {gate(g)?.live ? (
                <span className="text-emerald-400/80">can fire</span>
              ) : (
                <span className="text-zinc-400">dead: {gate(g)?.reason ?? 'never fires'}</span>
              )}
            </div>
          ))}
          <p className="mt-2 text-xs leading-5 text-zinc-500">
            Connect a gate to the <span className="text-amber-400">trigger</span> input of the nodes that should run for that
            outcome. If the condition is a known constant, the other gate (and everything only reachable through it) is
            reported as a dead branch.
          </p>
        </Section>
        <Section title="Issues">
          <Messages messages={report?.messages ?? []} />
        </Section>
      </div>
    </>
  )
}

function LoopInspector({ node }: { node: Extract<FlowNode, { type: 'loop' }> }) {
  const report = useStore((s) => s.analysis.nodes[node.id])
  const update = useStore((s) => s.updateNodeData)
  const reduce = node.data.mode === 'reduce'
  return (
    <>
      <Header id={node.id} kind="loop" title="Loop" />
      <div className="flex-1 overflow-y-auto">
        <Section title="Mode">
          <div className="flex gap-1.5">
            {(['map', 'reduce'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => update(node.id, { mode: m })}
                className={`rounded px-3 py-1 text-xs ${
                  node.data.mode === m ? 'bg-violet-500/25 text-violet-200' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs leading-5 text-zinc-500">
            {reduce
              ? 'Each iteration receives item, index and acc. Connect the body’s new accumulator to “next acc”: it must be assignable to the initial value’s type. The result is the final accumulator.'
              : 'Each iteration receives item and index. Whatever you connect to “collect” is gathered into results: an array of the collected type.'}{' '}
            Hang the loop body off the <span className="text-violet-300">each</span> gate (it runs once per item);{' '}
            <span className="text-amber-400">done</span> fires after the last iteration.
          </p>
        </Section>
        <Section title="Per iteration">
          <div className="space-y-1">
            <Row label="item" info={report?.outputs.item} />
            <Row label="index" info={report?.outputs.index} />
            {reduce && <Row label="acc" info={report?.outputs.acc} />}
          </div>
        </Section>
        <Section title={reduce ? 'Result' : 'Results'}>
          <TypeView info={report?.outputs.results} />
        </Section>
        <Section title="Issues">
          <Messages messages={report?.messages ?? []} />
        </Section>
      </div>
    </>
  )
}

function Row({ label, info }: { label: string; info: TypeInfo | null | undefined }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 shrink-0 text-zinc-400">{label}</span>
      <TypeChip info={info} max={60} />
    </div>
  )
}

function CallInspector({ node }: { node: Extract<FlowNode, { type: 'call' }> }) {
  const report = useStore((s) => s.analysis.nodes[node.id])
  const fns = useStore((s) => s.doc.functions)
  const types = useStore((s) => s.doc.types)
  const update = useStore((s) => s.updateNodeData)
  const setSelection = useStore((s) => s.setSelection)
  const fn = fns.find((f) => f.id === node.data.fnId)
  const defs = useMemo(() => Object.fromEntries(types.map((t) => [t.name, t.spec.schema])), [types])
  return (
    <>
      <Header id={node.id} kind="call" title="Call function" />
      <div className="flex-1 overflow-y-auto">
        <Section title="Function">
          <div className="flex items-center gap-2">
            <select
              className={`${field} w-56`}
              value={node.data.fnId ?? ''}
              onChange={(e) => update(node.id, { fnId: e.target.value || null })}
            >
              <option value="">Choose a function…</option>
              {fns.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            {fn && (
              <button
                type="button"
                className="text-xs text-indigo-300 hover:underline"
                onClick={() => setSelection({ kind: 'function', id: fn.id })}
              >
                edit definition
              </button>
            )}
          </div>
          {fn && (
            <div className="mt-2 space-y-1">
              <Row
                label="expects"
                info={{
                  ty: fromSchema(fn.input.schema, { defs }),
                  type: show(fromSchema(fn.input.schema, { defs })),
                  schema: fn.input.schema,
                  optional: false,
                }}
              />
              <Row label="receives" info={report?.inputs.arg} />
            </div>
          )}
        </Section>
        <Section title="Execution">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={node.data.async}
              onChange={(e) => update(node.id, { async: e.target.checked })}
            />
            Async (fire and forget)
          </label>
          <p className="mt-2 text-xs leading-5 text-zinc-500">
            Calls are synchronous by default: everything after them waits. An async call lets the flow continue right
            away via its <span className="text-amber-400">done</span> gate; its result is only usable in the detached
            branch, and a return in that branch can never deliver a value.
          </p>
        </Section>
        <Section title="Result type">
          <TypeView info={report?.outputs.out} />
        </Section>
        <Section title="Issues">
          <Messages messages={report?.messages ?? []} />
        </Section>
      </div>
    </>
  )
}

function ReturnInspector({ node }: { node: Extract<FlowNode, { type: 'return' }> }) {
  const report = useStore((s) => s.analysis.nodes[node.id])
  const ret = useStore((s) => s.analysis.returns.find((r) => r.nodeId === node.id))
  const flowType = useStore((s) => s.analysis.returnType)
  return (
    <>
      <Header id={node.id} kind="return" title="Return" />
      <div className="flex-1 overflow-y-auto">
        <Section title="Returns here">
          <TypeView info={report?.inputs.in} empty="No value connected" />
          <div className="mt-2 text-xs text-zinc-400">
            {ret?.counted
              ? 'Counted toward the flow’s result type.'
              : report?.status === 'live'
                ? 'Not counted (see issues).'
                : 'Not counted: this node never runs.'}
          </div>
        </Section>
        <Section title="Flow result type (all returns unified)">
          <TypeView info={flowType} empty="The flow never returns a value" />
        </Section>
        <Section title="Issues">
          <Messages messages={report?.messages ?? []} />
        </Section>
      </div>
    </>
  )
}

function TypeDefinitionInspector({ id }: { id: string }) {
  const t = useStore((s) => s.doc.types.find((x) => x.id === id))
  const all = useStore((s) => s.doc.types)
  const names = useMemo(() => all.filter((x) => x.id !== id).map((x) => x.name), [all, id])
  const update = useStore((s) => s.updateType)
  const defs = useMemo(() => Object.fromEntries(all.map((x) => [x.name, x.spec.schema])), [all])
  if (!t) return null
  const ty = fromSchema(t.spec.schema, { defs })
  return (
    <>
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="text-xs font-medium text-violet-300">Type</span>
        <input
          className={`${field} w-56 font-mono`}
          value={t.name}
          onChange={(e) => update(id, { name: e.target.value })}
        />
        <span className="text-[10px] text-zinc-600">references to it are renamed too</span>
      </div>
      <Split
        editor={
          <SchemaEditor
            key={id}
            pathKey={id}
            spec={t.spec}
            typeNames={names}
            onChange={(spec) => update(id, { spec })}
          />
        }
        side={
          <Section title="Resolved type">
            <code className="block break-words font-mono text-xs leading-5 text-zinc-200">{show(ty)}</code>
          </Section>
        }
      />
    </>
  )
}

function FunctionInspector({ id }: { id: string }) {
  const f = useStore((s) => s.doc.functions.find((x) => x.id === id))
  const types = useStore((s) => s.doc.types)
  const names = useMemo(() => types.map((x) => x.name), [types])
  const update = useStore((s) => s.updateFunction)
  const defs = useMemo(() => Object.fromEntries(types.map((x) => [x.name, x.spec.schema])), [types])
  const mockCtx = useMemo(
    () => ({ input: f ? fromSchema(f.input.schema, { defs }) : null, bindings: {} }),
    [f, defs],
  )
  if (!f) return null
  return (
    <>
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="text-xs font-medium text-rose-300">Function</span>
        <input
          className={`${field} w-48 font-mono`}
          value={f.name}
          onChange={(e) => update(id, { name: e.target.value })}
        />
        <input
          className={`${field} min-w-0 flex-1`}
          placeholder="description (optional)"
          value={f.description ?? ''}
          onChange={(e) => update(id, { description: e.target.value })}
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-3 divide-x divide-zinc-800">
        {(['input', 'output'] as const).map((side) => (
          <div key={side} className="flex min-h-0 min-w-0 flex-col">
            <div className="px-3 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              {side === 'input' ? 'Argument type' : 'Return type'}
            </div>
            <div className="min-h-0 flex-1">
              <SchemaEditor
                key={`${id}-${side}`}
                pathKey={`${id}-${side}`}
                spec={f[side]}
                typeNames={names}
                onChange={(spec) => update(id, { [side]: spec })}
              />
            </div>
          </div>
        ))}
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="px-3 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Mock for runs (JSONata, <code>$</code> is the argument)
          </div>
          <div className="min-h-0 flex-1">
            <LazyCode
              language="jsonata"
              path={`mock-${id}.jsonata`}
              value={f.mock ?? ''}
              onChange={(mock) => update(id, { mock })}
              completion={mockCtx}
            />
          </div>
          <div className="shrink-0 border-t border-zinc-800 px-3 py-1 text-[11px] text-zinc-500">
            {f.mock?.trim()
              ? 'Used when the flow is run.'
              : 'Empty: a sample of the return type is generated.'}
          </div>
        </div>
      </div>
    </>
  )
}

function EdgeInspector({ id }: { id: string }) {
  const rep = useStore((s) => s.analysis.edges[id])
  const edge = useStore((s) => s.doc.edges.find((e) => e.id === id))
  if (!rep || !edge) return null
  return (
    <div className="flex-1 overflow-y-auto">
      <Section title="Connection">
        <div className="font-mono text-xs text-zinc-300">
          {edge.source}.{edge.sourceHandle ?? 'out'} → {edge.target}.{edge.targetHandle ?? 'in'}
        </div>
        <div className="mt-1 text-xs text-zinc-500">
          {rep.kind === 'trigger'
            ? 'Trigger signal: lets the target node start.'
            : 'Data: carries a value of this type.'}
          {rep.dead && ' · carries nothing: the branch is dead.'}
          {rep.async && ' · async (detached) branch.'}
        </div>
      </Section>
      {rep.kind === 'data' && (
        <Section title="Type on the wire">
          <TypeView info={rep.type} />
        </Section>
      )}
      {rep.error && (
        <Section title="Error">
          <Messages messages={[{ severity: 'error', message: rep.error }]} />
        </Section>
      )}
    </div>
  )
}

function FlowSummary() {
  const a = useStore((s) => s.analysis)
  const nodes = useStore((s) => s.doc.nodes)
  const setSelection = useStore((s) => s.setSelection)
  const label = (id?: string) => {
    const n = nodes.find((x) => x.id === id)
    return n ? n.data.label || n.type : ''
  }
  const issues = a.messages.filter((m) => m.severity !== 'info')
  const dead = Object.entries(a.nodes).filter(([, r]) => r.status !== 'live')
  return (
    <div className="grid min-h-0 flex-1 grid-cols-3 divide-x divide-zinc-800 overflow-y-auto">
      <div>
        <Section title="Flow result type">
          <TypeView info={a.returnType} empty="This flow never returns a value" />
        </Section>
        <Section title="Returns">
          {a.returns.length === 0 && <div className="text-xs text-zinc-600">No return nodes</div>}
          <ul className="space-y-1">
            {a.returns.map((r) => (
              <li key={r.nodeId} className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  className="shrink-0 text-indigo-300 hover:underline"
                  onClick={() => setSelection({ kind: 'node', id: r.nodeId })}
                >
                  {label(r.nodeId)}
                </button>
                <TypeChip info={r.type} max={36} />
                <span className={r.counted ? 'text-emerald-400/80' : 'text-zinc-500'}>
                  {r.counted ? 'counted' : 'ignored'}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
      <div>
        <Section title={`Issues (${issues.length})`}>
          {issues.length === 0 ? (
            <div className="text-xs text-emerald-400/80">The flow is typesafe.</div>
          ) : (
            <ul className="space-y-1.5">
              {issues.map((m, i) => (
                <li key={i} className="flex gap-2 text-xs leading-4 text-zinc-300">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full" style={{ background: SEV_COLOR[m.severity] }} />
                  <span>
                    {m.nodeId && (
                      <button
                        type="button"
                        className="mr-1 text-indigo-300 hover:underline"
                        onClick={() => setSelection({ kind: 'node', id: m.nodeId as string })}
                      >
                        {label(m.nodeId)}:
                      </button>
                    )}
                    {m.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <div>
        <Section title={`Dead & unreachable (${dead.length})`}>
          {dead.length === 0 && <div className="text-xs text-zinc-600">Every node can run.</div>}
          <ul className="space-y-1.5">
            {dead.map(([id, r]) => (
              <li key={id} className="text-xs leading-4 text-zinc-400">
                <button
                  type="button"
                  className="mr-1 text-indigo-300 hover:underline"
                  onClick={() => setSelection({ kind: 'node', id })}
                >
                  {label(id)}
                </button>
                <span className="text-zinc-600">({r.status})</span> {r.deadReason}
              </li>
            ))}
          </ul>
        </Section>
        <Section title="How to read the flow">
          <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-zinc-500">
            <li>Round handles carry typed data; diamond handles carry trigger signals.</li>
            <li>A node with a connected trigger is lazy: it waits for the signal.</li>
            <li>Dashed + faded = dead branch. Animated = async branch.</li>
          </ul>
        </Section>
      </div>
    </div>
  )
}


/* ---------- run ---------- */

const pretty = (v: unknown) => (v === undefined ? 'undefined' : (JSON.stringify(v, null, 2) ?? String(v)))
const oneLine = (v: unknown, max = 70) => {
  const t = v === undefined ? 'undefined' : (JSON.stringify(v) ?? String(v))
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}
const SPEEDS = [
  { label: '0.5×', ms: 800 },
  { label: '1×', ms: 400 },
  { label: '2×', ms: 160 },
] as const

function RunInspector() {
  const run = useStore((s) => s.run)
  const doc = useStore((s) => s.doc)
  const { startRun, setRunInput, generateRunInput, setCursor, stepRun, setPlaying, clearRun } = useStore.getState()
  const [speed, setSpeed] = useState(1)

  const inputNode = doc.nodes.find((n) => n.type === 'input')
  const inputSchema = useMemo(() => {
    if (!inputNode || inputNode.type !== 'input') return undefined
    const defs = Object.fromEntries(doc.types.map((t) => [t.name, t.spec.schema]))
    return standardizeRefs(inputNode.data.spec.schema, defs)
  }, [inputNode, doc.types])
  const text = run.inputText ?? sampleInput(doc)

  // playback
  useEffect(() => {
    if (!run.playing) return
    const t = setInterval(() => useStore.getState().stepRun(1), SPEEDS[speed].ms)
    return () => clearInterval(t)
  }, [run.playing, speed])

  const result = run.result
  const n = result?.steps.length ?? 0
  const at = result ? (run.cursor === null ? n - 1 : run.cursor) : -1
  const step = result && at >= 0 ? result.steps[at] : null
  const label = (id: string) => {
    const node = doc.nodes.find((x) => x.id === id)
    return node ? node.data.label || KIND_STYLE[node.type as keyof typeof KIND_STYLE]?.name || node.type : id
  }
  const kindOf = (id: string) => doc.nodes.find((x) => x.id === id)?.type as keyof typeof KIND_STYLE | undefined

  const statusBadge = result && (
    <span
      className={`rounded px-2 py-0.5 text-[11px] font-medium ${
        result.status === 'returned'
          ? 'bg-emerald-500/15 text-emerald-300'
          : result.status === 'failed'
            ? 'bg-red-500/15 text-red-300'
            : 'bg-amber-500/15 text-amber-300'
      }`}
    >
      {result.status === 'returned' ? 'returned' : result.status === 'failed' ? 'failed' : 'finished without returning'}
    </span>
  )

  return (
    <div className="flex min-h-0 flex-1">
      {/* input */}
      <div className="flex min-h-0 w-[32%] min-w-56 flex-col border-r border-zinc-800">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-zinc-800 px-2 py-1.5">
          <button
            type="button"
            disabled={run.running}
            onClick={() => void startRun()}
            className="rounded bg-emerald-500 px-3 py-1 text-xs font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            ▶ Run
          </button>
          <button
            type="button"
            className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
            onClick={() => generateRunInput()}
            title="Generate a random input that matches the flow's input type"
          >
            New sample
          </button>
          <span className="ml-auto text-[10px] uppercase tracking-wide text-zinc-500">input</span>
        </div>
        <div className="min-h-0 flex-1">
          <LazyCode
            language="json"
            path="run-input.json"
            value={text}
            onChange={(t) => setRunInput(t)}
            jsonSchema={inputSchema}
          />
        </div>
        {run.parseError && (
          <div className="shrink-0 border-t border-zinc-800 px-3 py-1 text-[11px] text-red-400">{run.parseError}</div>
        )}
      </div>

      {/* timeline */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-zinc-800">
        {!result ? (
          <div className="p-4 text-xs leading-5 text-zinc-500">
            {run.running ? (
              'Running…'
            ) : (
              <>
                Press <span className="text-emerald-400">▶ Run</span> to execute the flow with the input on the left.
                JSONata expressions are evaluated for real; functions are answered by their mock (set one in the
                function’s definition) or by a generated sample of their return type. The canvas then replays the
                execution: lit wires carried a value, dimmed nodes never ran.
              </>
            )}
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-1.5 border-b border-zinc-800 px-2 py-1.5">
              <button type="button" className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs hover:bg-zinc-700" title="First step" onClick={() => setCursor(0)}>
                ⏮
              </button>
              <button type="button" className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs hover:bg-zinc-700" title="Previous step" onClick={() => stepRun(-1)}>
                ◀
              </button>
              <button
                type="button"
                className="rounded bg-cyan-500 px-2.5 py-0.5 text-xs font-semibold text-zinc-950 hover:bg-cyan-400"
                onClick={() => setPlaying(!run.playing)}
              >
                {run.playing ? '❚❚ Pause' : '▶ Play'}
              </button>
              <button type="button" className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs hover:bg-zinc-700" title="Next step" onClick={() => stepRun(1)}>
                ▶
              </button>
              <button type="button" className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs hover:bg-zinc-700" title="Show the whole run" onClick={() => setCursor(null)}>
                ⏭
              </button>
              <select
                className="ml-1 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-300"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                {SPEEDS.map((s, i) => (
                  <option key={s.label} value={i}>
                    {s.label}
                  </option>
                ))}
              </select>
              <input
                type="range"
                min={0}
                max={Math.max(0, n - 1)}
                value={Math.max(0, at)}
                onChange={(e) => setCursor(Number(e.target.value))}
                className="mx-2 min-w-16 flex-1"
              />
              <span className="shrink-0 font-mono text-[11px] text-zinc-400">
                {at + 1}/{n}
              </span>
              <button type="button" className="ml-1 rounded px-1.5 text-zinc-500 hover:text-zinc-200" title="Clear the run" onClick={clearRun}>
                ✕
              </button>
            </div>
            <ol className="min-h-0 flex-1 overflow-y-auto py-1">
              {result.steps.map((s, i) => {
                const k = kindOf(s.nodeId)
                const active = i === at
                const future = i > at
                return (
                  <li key={s.seq}>
                    <button
                      type="button"
                      onClick={() => setCursor(i)}
                      className={`flex w-full items-start gap-2 px-3 py-1 text-left text-xs ${
                        active ? 'bg-cyan-500/15' : 'hover:bg-zinc-900'
                      } ${future ? 'opacity-40' : ''}`}
                      style={{ paddingLeft: 12 + s.scope.length * 14 }}
                    >
                      <span className="w-6 shrink-0 text-right font-mono text-[10px] text-zinc-500">{s.seq}</span>
                      <span
                        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-bold text-zinc-950"
                        style={{ background: k ? KIND_STYLE[k].accent : '#71717a' }}
                      >
                        {k ? KIND_STYLE[k].glyph : '?'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-zinc-200">{label(s.nodeId)}</span>
                        {s.scope.length > 0 && (
                          <span className="ml-1.5 rounded bg-violet-500/20 px-1 font-mono text-[10px] text-violet-300">
                            {s.scope.map((c) => `${label(c.loopId)}[${c.index}]`).join(' › ')}
                          </span>
                        )}
                        {s.detached && (
                          <span className="ml-1.5 rounded bg-sky-500/20 px-1 text-[10px] text-sky-300">async branch</span>
                        )}
                        <span className="mt-px block truncate font-mono text-[10.5px] text-zinc-500">
                          {s.error ? (
                            <span className="text-red-400">{s.error}</span>
                          ) : s.fired.length > 0 && !('out' in s.outputs) && s.outputs.results === undefined ? (
                            `→ ${s.fired.join(', ')}`
                          ) : (
                            oneLine('out' in s.outputs ? s.outputs.out : (s.outputs.results ?? s.outputs.in))
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </>
        )}
      </div>

      {/* result + step detail */}
      <div className="w-[30%] min-w-56 shrink-0 overflow-y-auto">
        {result && (
          <>
            <Section title="Outcome" right={statusBadge}>
              {result.status === 'returned' && (
                <>
                  <div className="mb-1 text-[11px] text-zinc-500">
                    returned by <span className="text-indigo-300">{label(result.returnedBy ?? '')}</span>
                  </div>
                  <pre className="max-h-48 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] leading-4 text-emerald-200">
                    {pretty(result.value)}
                  </pre>
                </>
              )}
              {result.status === 'failed' && (
                <div className="text-xs leading-5 text-red-300">
                  {result.error?.nodeId && <span className="font-medium">{label(result.error.nodeId)}: </span>}
                  {result.error?.message}
                </div>
              )}
              {result.status === 'finished' && (
                <div className="text-xs leading-5 text-amber-200/90">
                  Every runnable node ran, but no return was reached.
                </div>
              )}
              {result.ignoredReturns.length > 0 && (
                <div className="mt-2 text-[11px] leading-4 text-sky-300/90">
                  Ignored (async branch): {result.ignoredReturns.map(label).join(', ')}
                </div>
              )}
            </Section>
            {step && (
              <Section title={`Step ${step.seq} · ${label(step.nodeId)}`}>
                {step.note && <div className="mb-1.5 text-[11px] text-zinc-500">{step.note}</div>}
                {Object.keys(step.inputs).length > 0 && (
                  <>
                    <div className="mb-0.5 text-[10px] uppercase tracking-wide text-zinc-500">received</div>
                    <pre className="mb-2 max-h-40 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] leading-4 text-zinc-300">
                      {pretty(step.inputs)}
                    </pre>
                  </>
                )}
                {Object.keys(step.outputs).length > 0 && (
                  <>
                    <div className="mb-0.5 text-[10px] uppercase tracking-wide text-zinc-500">produced</div>
                    <pre className="mb-2 max-h-40 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] leading-4 text-cyan-200">
                      {pretty(step.outputs)}
                    </pre>
                  </>
                )}
                {step.fired.length > 0 && (
                  <div className="text-[11px] text-amber-400">fired: {step.fired.join(', ')}</div>
                )}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ---------- panel ---------- */

export function BottomPanel() {
  const selection = useStore((s) => s.selection)
  const node = useStore((s) =>
    selection?.kind === 'node' ? s.doc.nodes.find((n) => n.id === selection.id) : undefined,
  )

  let body: ReactNode
  if (selection?.kind === 'node' && node) {
    switch (node.type) {
      case 'input':
        body = <InputInspector key={node.id} node={node} />
        break
      case 'transform':
      case 'condition':
        body = <ExpressionInspector key={node.id} node={node} />
        break
      case 'branch':
        body = <BranchInspector key={node.id} node={node} />
        break
      case 'loop':
        body = <LoopInspector key={node.id} node={node} />
        break
      case 'call':
        body = <CallInspector key={node.id} node={node} />
        break
      case 'return':
        body = <ReturnInspector key={node.id} node={node} />
        break
    }
  } else if (selection?.kind === 'edge') {
    body = <EdgeInspector id={selection.id} />
  } else if (selection?.kind === 'type') {
    body = <TypeDefinitionInspector key={selection.id} id={selection.id} />
  } else if (selection?.kind === 'function') {
    body = <FunctionInspector key={selection.id} id={selection.id} />
  } else if (selection?.kind === 'run') {
    body = <RunInspector />
  } else {
    body = <FlowSummary />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      {!selection && (
        <div className="flex items-center border-b border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300">
          Flow overview
          <span className="ml-3 font-normal text-zinc-600">select a node, edge, type or function to edit it</span>
        </div>
      )}
      {body}
    </div>
  )
}
