import type { Edge, Node } from '@xyflow/react'
import type { JSONSchema } from '../dry'

/* ---------- schema specs: one canonical JSON Schema, three ways to author it ---------- */

export type SchemaMode = 'json' | 'form' | 'typebox'

export interface SchemaSpec {
  /** canonical form, always JSON Schema */
  schema: JSONSchema
  /** how the user last edited it */
  mode: SchemaMode
  /** source of the TypeBox program when authored in `typebox` mode */
  typebox?: string
}

export interface NamedType {
  id: string
  name: string
  spec: SchemaSpec
}

export interface FnDef {
  id: string
  name: string
  description?: string
  input: SchemaSpec
  output: SchemaSpec
}

/* ---------- nodes ---------- */

export type InputData = { label?: string; spec: SchemaSpec }
export type TransformData = { label?: string; expression: string; variables: string[] }
export type ConditionData = { label?: string; expression: string; variables: string[] }
export type BranchData = { label?: string }
export type LoopData = { label?: string; mode: 'map' | 'reduce' }
export type CallData = { label?: string; fnId: string | null; async: boolean }
export type ReturnData = { label?: string }

export type FlowNode =
  | Node<InputData, 'input'>
  | Node<TransformData, 'transform'>
  | Node<ConditionData, 'condition'>
  | Node<BranchData, 'branch'>
  | Node<LoopData, 'loop'>
  | Node<CallData, 'call'>
  | Node<ReturnData, 'return'>

export type NodeKind = NonNullable<FlowNode['type']>
export type FlowEdge = Edge

export interface FlowDoc {
  nodes: FlowNode[]
  edges: FlowEdge[]
  types: NamedType[]
  functions: FnDef[]
}

/* ---------- handles ---------- */

export type HandleKind = 'data' | 'trigger'

/** trigger gates; every other handle carries data */
const TRIGGER_HANDLES = new Set(['trigger', 'done', 'yes', 'no', 'each'])
export const isTriggerHandle = (id: string | null | undefined) => TRIGGER_HANDLES.has(id ?? '')
export const handleKind = (id: string | null | undefined): HandleKind =>
  isTriggerHandle(id) ? 'trigger' : 'data'

export const varHandle = (name: string) => `var:${name}`
export const isVarHandle = (id: string) => id.startsWith('var:')

export interface HandleSpec {
  id: string
  kind: HandleKind
  label: string
}

/** Handles a node exposes. The UI renders them and the analyzer validates against them. */
export function handlesOf(node: FlowNode): { targets: HandleSpec[]; sources: HandleSpec[] } {
  const trigger: HandleSpec = { id: 'trigger', kind: 'trigger', label: 'trigger' }
  const done: HandleSpec = { id: 'done', kind: 'trigger', label: 'done' }
  const data = (id: string, label: string): HandleSpec => ({ id, kind: 'data', label })
  switch (node.type) {
    case 'input':
      return { targets: [], sources: [data('out', 'value'), done] }
    case 'transform':
    case 'condition':
      return {
        targets: [
          trigger,
          data('in', '$'),
          ...node.data.variables.map((v) => data(varHandle(v), `$${v}`)),
        ],
        sources: [data('out', node.type === 'condition' ? 'boolean' : 'value'), done],
      }
    case 'branch':
      return {
        targets: [trigger, data('in', 'boolean')],
        sources: [
          { id: 'yes', kind: 'trigger', label: 'yes' },
          { id: 'no', kind: 'trigger', label: 'no' },
        ],
      }
    case 'loop':
      return {
        targets: [
          trigger,
          data('in', 'array'),
          ...(node.data.mode === 'reduce' ? [data('initial', 'initial')] : []),
          data('collect', node.data.mode === 'reduce' ? 'next acc' : 'collect'),
        ],
        sources: [
          data('item', 'item'),
          data('index', 'index'),
          ...(node.data.mode === 'reduce' ? [data('acc', 'acc')] : []),
          data('results', node.data.mode === 'reduce' ? 'result' : 'results'),
          { id: 'each', kind: 'trigger', label: 'each' },
          { id: 'done', kind: 'trigger', label: 'done' },
        ],
      }
    case 'call':
      return { targets: [trigger, data('arg', 'argument')], sources: [data('out', 'result'), done] }
    case 'return':
      return { targets: [trigger, data('in', 'value')], sources: [] }
  }
}

export function sourceHandleOf(e: FlowEdge) {
  return e.sourceHandle ?? 'out'
}
export function targetHandleOf(e: FlowEdge) {
  return e.targetHandle ?? 'in'
}

/** Would adding source -> target close a cycle? (`collect` edges are the loop's back edge.) */
export function wouldCycle(edges: FlowEdge[], source: string, target: string): boolean {
  if (source === target) return true
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (targetHandleOf(e) === 'collect') continue
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target])
  }
  const seen = new Set<string>()
  const stack = [target]
  while (stack.length) {
    const n = stack.pop() as string
    if (n === source) return true
    if (seen.has(n)) continue
    seen.add(n)
    stack.push(...(adj.get(n) ?? []))
  }
  return false
}

export interface ConnectionLike {
  source: string | null
  target: string | null
  sourceHandle: string | null
  targetHandle: string | null
}

/** Structural validity of a connection (types are checked by the analyzer instead). */
export function canConnect(c: ConnectionLike, nodes: FlowNode[], edges: FlowEdge[]): boolean {
  if (!c.source || !c.target) return false
  const s = nodes.find((n) => n.id === c.source)
  const t = nodes.find((n) => n.id === c.target)
  if (!s || !t) return false
  const sh = c.sourceHandle ?? 'out'
  const th = c.targetHandle ?? 'in'
  if (!handlesOf(s).sources.some((h) => h.id === sh)) return false
  if (!handlesOf(t).targets.some((h) => h.id === th)) return false
  if (handleKind(sh) !== handleKind(th)) return false
  if (
    edges.some(
      (e) =>
        e.source === c.source &&
        sourceHandleOf(e) === sh &&
        e.target === c.target &&
        targetHandleOf(e) === th,
    )
  ) {
    return false
  }
  // `collect` is the loop's back edge; everything else must stay acyclic
  return th === 'collect' || !wouldCycle(edges, c.source, c.target)
}
