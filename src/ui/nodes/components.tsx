import type { NodeProps } from '@xyflow/react'
import type {
  BranchData,
  CallData,
  ConditionData,
  InputData,
  LoopData,
  ReturnData,
  TransformData,
} from '../../flow/model'
import { varHandle } from '../../flow/model'
import { schemaToTypeBox } from '../../schema/typebox'
import { useStore } from '../../store'
import { CodePreview, DataIn, DataOut, NodeShell } from './parts'

const useReport = (id: string) => useStore((s) => s.analysis.nodes[id])

export function InputNode({ id, data, selected }: NodeProps & { data: InputData }) {
  const r = useReport(id)
  const text = JSON.stringify(data.spec.schema)
  return (
    <NodeShell
      id={id}
      kind="input"
      title={data.label || 'Input'}
      selected={selected}
      report={r}
      hasTrigger={false}
      gates={[{ id: 'done', label: 'start' }]}
    >
      <CodePreview text={text.length > 160 ? schemaToTypeBox(data.spec.schema).replace(/\s+/g, ' ') : text} lines={2} />
      <DataOut id="out" label="value" info={r?.outputs.out} />
    </NodeShell>
  )
}

export function ExpressionNode({
  id,
  data,
  selected,
  kind,
}: NodeProps & { data: TransformData | ConditionData; kind: 'transform' | 'condition' }) {
  const r = useReport(id)
  return (
    <NodeShell
      id={id}
      kind={kind}
      title={data.label || (kind === 'condition' ? 'Condition' : 'Transform')}
      selected={selected}
      report={r}
      gates={[{ id: 'done', label: 'done' }]}
    >
      <CodePreview text={data.expression} />
      <DataIn id="in" label="$" info={r?.inputs.in} />
      {data.variables.map((v) => (
        <DataIn key={v} id={varHandle(v)} label={`$${v}`} info={r?.inputs[varHandle(v)]} />
      ))}
      <DataOut id="out" label={kind === 'condition' ? 'boolean' : 'result'} info={r?.outputs.out} />
    </NodeShell>
  )
}

export const TransformNode = (p: NodeProps & { data: TransformData }) => (
  <ExpressionNode {...p} kind="transform" />
)
export const ConditionNode = (p: NodeProps & { data: ConditionData }) => (
  <ExpressionNode {...p} kind="condition" />
)

export function BranchNode({ id, data, selected }: NodeProps & { data: BranchData }) {
  const r = useReport(id)
  const edges = useStore((s) => s.analysis.edges)
  void edges
  return (
    <NodeShell
      id={id}
      kind="branch"
      title={data.label || 'Branch'}
      selected={selected}
      report={r}
      gates={[
        { id: 'yes', label: 'yes', color: '#4ade80' },
        { id: 'no', label: 'no', color: '#f87171' },
      ]}
    >
      <DataIn id="in" label="if" info={r?.inputs.in} />
    </NodeShell>
  )
}

export function LoopNode({ id, data, selected }: NodeProps & { data: LoopData }) {
  const r = useReport(id)
  const reduce = data.mode === 'reduce'
  return (
    <NodeShell
      id={id}
      kind="loop"
      title={data.label || (reduce ? 'Loop · reduce' : 'Loop · map')}
      selected={selected}
      report={r}
      gates={[
        { id: 'each', label: 'each', color: '#a78bfa' },
        { id: 'done', label: 'done' },
      ]}
    >
      <DataIn id="in" label="for each in" info={r?.inputs.in} />
      {reduce && <DataIn id="initial" label="initial" info={r?.inputs.initial} />}
      <div className="my-1 border-t border-dashed border-zinc-800" />
      <DataOut id="item" label="item" info={r?.outputs.item} />
      <DataOut id="index" label="index" info={r?.outputs.index} />
      {reduce && <DataOut id="acc" label="acc" info={r?.outputs.acc} />}
      <DataIn id="collect" label={reduce ? 'next acc' : 'collect'} info={r?.inputs.collect} side="right" />
      <div className="my-1 border-t border-dashed border-zinc-800" />
      <DataOut id="results" label={reduce ? 'result' : 'results'} info={r?.outputs.results} />
    </NodeShell>
  )
}

export function CallNode({ id, data, selected }: NodeProps & { data: CallData }) {
  const r = useReport(id)
  const fns = useStore((s) => s.doc.functions)
  const update = useStore((s) => s.updateNodeData)
  const fn = fns.find((f) => f.id === data.fnId)
  return (
    <NodeShell
      id={id}
      kind="call"
      title={data.label || (fn ? fn.name : 'Call function')}
      selected={selected}
      report={r}
      gates={[{ id: 'done', label: 'done' }]}
      headerExtra={
        <button
          type="button"
          className={`nodrag rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ${
            data.async ? 'bg-sky-500 text-zinc-950' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
          }`}
          title={
            data.async
              ? 'Async: fire and forget. Click to make it synchronous.'
              : 'Sync: everything after this call waits for it. Click to make it async (fire and forget).'
          }
          onClick={() => update(id, { async: !data.async })}
        >
          {data.async ? 'async' : 'sync'}
        </button>
      }
    >
      <select
        className="nodrag my-1 w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-200"
        value={data.fnId ?? ''}
        onChange={(e) => update(id, { fnId: e.target.value || null })}
      >
        <option value="">Choose a function…</option>
        {fns.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <DataIn id="arg" label="argument" info={r?.inputs.arg} />
      <DataOut id="out" label="result" info={r?.outputs.out} detached={data.async} />
    </NodeShell>
  )
}

export function ReturnNode({ id, data, selected }: NodeProps & { data: ReturnData }) {
  const r = useReport(id)
  const counted = useStore((s) => s.analysis.returns.find((x) => x.nodeId === id)?.counted)
  return (
    <NodeShell
      id={id}
      kind="return"
      title={data.label || 'Return'}
      selected={selected}
      report={r}
      headerExtra={
        counted ? (
          <span className="rounded bg-emerald-500/15 px-1 text-[9px] font-semibold uppercase text-emerald-300">counted</span>
        ) : undefined
      }
    >
      <DataIn id="in" label="value" info={r?.inputs.in} />
    </NodeShell>
  )
}
