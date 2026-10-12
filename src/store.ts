import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react'
import { create } from 'zustand'
import type { JSONSchema } from './dry'
import { analyzeFlow, type FlowAnalysis } from './flow/analyze'
import { fromSchema, removeUndef } from './dry'
import { rng, sample } from './dry/sample'
import { EXAMPLES } from './flow/examples'
import { runFlow, type RunResult, type RunStep } from './flow/run'
import {
  canConnect,
  handleKind,
  sourceHandleOf,
  targetHandleOf,
  type FlowDoc,
  type FlowEdge,
  type FlowNode,
  type FnDef,
  type NamedType,
  type NodeKind,
  type SchemaSpec,
} from './flow/model'

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'type'; id: string }
  | { kind: 'function'; id: string }
  | { kind: 'run' }
  | null

/** what the canvas needs to know to show a run up to the current step */
export interface RunView {
  nodes: Record<
    string,
    { count: number; seqs: number[]; last: RunStep; current: boolean; error?: string; detached: boolean; iterations: number }
  >
  edges: Record<string, { value?: unknown; hasValue: boolean; trigger: boolean; current: boolean; detached: boolean }>
  /** number of steps shown */
  shown: number
}

export interface RunState {
  /** JSON text of the input; null until the user (or the sample generator) provides one */
  inputText: string | null
  running: boolean
  result: RunResult | null
  parseError: string | null
  /** index of the last step shown, or null for "the whole run" */
  cursor: number | null
  playing: boolean
  view: RunView | null
}

interface Store {
  doc: FlowDoc
  analysis: FlowAnalysis
  selection: Selection
  exampleId: string | null
  /** bumped whenever a whole document is loaded, so the canvas can re-fit the view */
  version: number
  /** set by the canvas so the palette can drop nodes in the middle of the viewport */
  viewportCenter: (() => XYPosition) | null
  run: RunState

  setSelection: (s: Selection) => void
  registerViewport: (fn: (() => XYPosition) | null) => void

  onNodesChange: (changes: NodeChange<FlowNode>[]) => void
  onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void
  onConnect: (c: Connection) => void

  updateNodeData: (id: string, patch: Partial<FlowNode['data']>) => void
  addNode: (kind: NodeKind) => void

  addType: () => void
  updateType: (id: string, patch: Partial<Pick<NamedType, 'name' | 'spec'>>) => void
  removeType: (id: string) => void

  addFunction: () => void
  updateFunction: (id: string, patch: Partial<Omit<FnDef, 'id'>>) => void
  removeFunction: (id: string) => void

  loadExample: (id: string) => void
  clear: () => void

  setRunInput: (text: string | null) => void
  startRun: (opts?: { play?: boolean }) => Promise<void>
  setCursor: (cursor: number | null) => void
  stepRun: (delta: number) => void
  setPlaying: (playing: boolean) => void
  clearRun: () => void
  generateRunInput: (seed?: number) => void
}

const IDLE_RUN: RunState = {
  inputText: null,
  running: false,
  result: null,
  parseError: null,
  cursor: null,
  playing: false,
  view: null,
}

/** the sample input for a document: a deterministic value of the input node's type */
export function sampleInput(doc: FlowDoc, seed = 1): string {
  const input = doc.nodes.find((n) => n.type === 'input')
  if (!input || input.type !== 'input') return '{}'
  const defs = Object.fromEntries(doc.types.map((t) => [t.name, t.spec.schema]))
  const ty = removeUndef(fromSchema(input.data.spec.schema, { defs }))
  return JSON.stringify(sample(ty, rng(seed)), null, 2) ?? 'null'
}

function buildRunView(doc: FlowDoc, result: RunResult, cursor: number | null): RunView {
  const shown = cursor === null ? result.steps.length : Math.min(cursor + 1, result.steps.length)
  const visible = result.steps.slice(0, shown)
  const nodes: RunView['nodes'] = {}
  const edges: RunView['edges'] = {}
  const current = shown > 0 ? visible[shown - 1] : null
  const loopIterations = new Map<string, number>()
  const loopStep = new Map<string, RunStep>()

  for (const s of visible) {
    const n = nodes[s.nodeId]
    nodes[s.nodeId] = {
      count: (n?.count ?? 0) + 1,
      seqs: [...(n?.seqs ?? []), s.seq],
      last: s,
      current: false,
      error: s.error ?? n?.error,
      detached: s.detached,
      iterations: 0,
    }
    loopStep.set(s.nodeId, s)
    for (const sc of s.scope) {
      loopIterations.set(sc.loopId, Math.max(loopIterations.get(sc.loopId) ?? 0, sc.index + 1))
    }
  }
  if (current) nodes[current.nodeId].current = true
  for (const [id, it] of loopIterations) if (nodes[id]) nodes[id].iterations = it

  for (const e of doc.edges) {
    const sh = e.sourceHandle ?? 'out'
    const src = nodes[e.source]
    if (!src) continue
    const step = loopStep.get(e.source) as RunStep
    const trigger = sh === 'done' || sh === 'yes' || sh === 'no' || sh === 'each'
    let active = false
    let value: unknown
    let hasValue = false
    if (trigger) {
      if (sh === 'each') active = src.iterations > 0
      else active = nodes[e.source].last.fired.includes(sh) || visible.some((v) => v.nodeId === e.source && v.fired.includes(sh))
    } else if (nodes[e.source] && (sh === 'item' || sh === 'index' || sh === 'acc')) {
      active = src.iterations > 0
      if (active && sh === 'item') {
        const items = step.inputs.in as unknown[] | undefined
        value = items?.[src.iterations - 1]
        hasValue = true
      } else if (active && sh === 'index') {
        value = src.iterations - 1
        hasValue = true
      }
    } else {
      const outStep = [...visible].reverse().find((v) => v.nodeId === e.source && sh in v.outputs)
      if (outStep) {
        active = true
        value = outStep.outputs[sh]
        hasValue = true
      }
    }
    if (!active) continue
    edges[e.id] = {
      value,
      hasValue,
      trigger,
      detached: src.detached,
      current: !!current && (e.source === current.nodeId || e.target === current.nodeId),
    }
  }
  return { nodes, edges, shown }
}

const STORAGE_KEY = 'jsonata-dry:doc:v1'
const uid = () => Math.random().toString(36).slice(2, 8)

/** make sure edges render with our custom component and the input node stays put */
function normalize(doc: FlowDoc): FlowDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.type === 'input' ? { ...n, deletable: false } : n)),
    edges: doc.edges.map((e) => (e.type === 'typed' ? e : { ...e, type: 'typed' })),
  }
}

function loadInitial(): { doc: FlowDoc; exampleId: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { doc: FlowDoc; exampleId: string | null }
      if (Array.isArray(parsed.doc?.nodes)) return parsed
    }
  } catch {
    /* storage unavailable or corrupt: fall back to the example */
  }
  return { doc: EXAMPLES[0].build(), exampleId: EXAMPLES[0].id }
}

const emptyDoc = (): FlowDoc => ({
  nodes: [
    {
      id: 'input',
      type: 'input',
      position: { x: 0, y: 0 },
      data: {
        label: 'Input',
        spec: {
          mode: 'json',
          schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      },
    },
  ],
  edges: [],
  types: [],
  functions: [],
})

function defaultData(kind: NodeKind, doc: FlowDoc): FlowNode['data'] {
  switch (kind) {
    case 'input':
      return { label: 'Input', spec: { mode: 'json', schema: { type: 'object' } } }
    case 'transform':
      return { label: '', expression: '$', variables: [] }
    case 'condition':
      return { label: '', expression: 'true', variables: [] }
    case 'branch':
      return { label: '' }
    case 'loop':
      return { label: '', mode: 'map' }
    case 'call':
      return { label: '', fnId: doc.functions[0]?.id ?? null, async: false }
    case 'return':
      return { label: '' }
  }
}

/** rewrite `$ref`s (and TypeBox `t.Ref("…")`) after a named type is renamed */
function renameRefs(doc: FlowDoc, from: string, to: string): FlowDoc {
  const walk = (s: JSONSchema): JSONSchema => {
    if (Array.isArray(s)) return (s as JSONSchema[]).map(walk) as unknown as JSONSchema
    if (s === null || typeof s !== 'object') return s
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s)) {
      if (k === '$ref' && typeof v === 'string') {
        out[k] = v === from ? to : v.endsWith('/' + from) ? v.slice(0, -from.length) + to : v
      } else out[k] = typeof v === 'object' && v !== null ? walk(v as JSONSchema) : v
    }
    return out
  }
  const spec = (sp: SchemaSpec): SchemaSpec => ({
    ...sp,
    schema: walk(sp.schema),
    typebox: sp.typebox?.replace(
      new RegExp(`(Ref\\(\\s*)(['"])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2`, 'g'),
      `$1$2${to}$2`,
    ),
  })
  return {
    ...doc,
    types: doc.types.map((t) => ({ ...t, spec: spec(t.spec) })),
    functions: doc.functions.map((f) => ({ ...f, input: spec(f.input), output: spec(f.output) })),
    nodes: doc.nodes.map((n) => (n.type === 'input' ? { ...n, data: { ...n.data, spec: spec(n.data.spec) } } : n)),
  }
}

const initial = loadInitial()
const initialDoc = normalize(initial.doc)

export const useStore = create<Store>()((set, get) => {
  /** replace the document and re-run the analysis */
  const commit = (doc: FlowDoc, extra: Partial<Store> = {}) =>
    set({ doc, analysis: analyzeFlow(doc), ...extra })

  return {
    doc: initialDoc,
    analysis: analyzeFlow(initialDoc),
    selection: null,
    exampleId: initial.exampleId,
    version: 0,
    viewportCenter: null,
    run: IDLE_RUN,

    setSelection: (selection) => set({ selection }),
    registerViewport: (viewportCenter) => set({ viewportCenter }),

    onNodesChange: (changes) => {
      const { doc, selection } = get()
      const nodes = applyNodeChanges(changes, doc.nodes)
      const structural = changes.some((c) => c.type === 'remove' || c.type === 'add' || c.type === 'replace')
      const next = { ...doc, nodes }
      if (!structural) {
        set({ doc: next })
        return
      }
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
      const edges = doc.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target))
      commit(
        { ...next, edges },
        selection?.kind === 'node' && removed.has(selection.id) ? { selection: null } : {},
      )
    },

    onEdgesChange: (changes) => {
      const { doc, selection } = get()
      const edges = applyEdgeChanges(changes, doc.edges)
      const structural = changes.some((c) => c.type === 'remove' || c.type === 'add' || c.type === 'replace')
      if (!structural) {
        set({ doc: { ...doc, edges } })
        return
      }
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
      commit(
        { ...doc, edges },
        selection?.kind === 'edge' && removed.has(selection.id) ? { selection: null } : {},
      )
    },

    onConnect: (c) => {
      const { doc } = get()
      if (!canConnect(c, doc.nodes, doc.edges)) return
      const th = c.targetHandle ?? 'in'
      // a data input takes exactly one value: replace what was there
      const edges =
        handleKind(th) === 'data'
          ? doc.edges.filter((e) => !(e.target === c.target && targetHandleOf(e) === th))
          : doc.edges
      const edge: FlowEdge = {
        id: `e-${uid()}`,
        type: 'typed',
        source: c.source,
        sourceHandle: c.sourceHandle ?? 'out',
        target: c.target,
        targetHandle: th,
      }
      commit({ ...doc, edges: [...edges, edge] })
    },

    updateNodeData: (id, patch) => {
      const { doc } = get()
      const nodes = doc.nodes.map((n) =>
        n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as FlowNode) : n,
      )
      // dropping a variable must also drop edges that targeted its handle
      const node = nodes.find((n) => n.id === id)
      let edges = doc.edges
      if (node && (node.type === 'transform' || node.type === 'condition')) {
        const handles = new Set(['trigger', 'in', ...node.data.variables.map((v) => `var:${v}`)])
        edges = edges.filter((e) => e.target !== id || handles.has(targetHandleOf(e)))
      }
      if (node?.type === 'loop' && node.data.mode === 'map') {
        edges = edges.filter(
          (e) =>
            !(e.target === id && targetHandleOf(e) === 'initial') &&
            !(e.source === id && sourceHandleOf(e) === 'acc'),
        )
      }
      commit({ ...doc, nodes, edges })
    },

    addNode: (kind) => {
      const { doc, viewportCenter } = get()
      if (kind === 'input' && doc.nodes.some((n) => n.type === 'input')) return
      const center = viewportCenter?.() ?? { x: 100, y: 100 }
      const jitter = (doc.nodes.length % 5) * 24
      const id = `${kind}-${uid()}`
      const node = {
        id,
        type: kind,
        position: { x: center.x - 120 + jitter, y: center.y - 40 + jitter },
        data: defaultData(kind, doc),
      } as FlowNode
      commit({ ...doc, nodes: [...doc.nodes, node] }, { selection: { kind: 'node', id } })
    },

    addType: () => {
      const { doc } = get()
      let i = doc.types.length + 1
      while (doc.types.some((t) => t.name === `Type${i}`)) i++
      const id = `t-${uid()}`
      const type: NamedType = {
        id,
        name: `Type${i}`,
        spec: { mode: 'json', schema: { type: 'object', properties: {}, required: [] } },
      }
      commit({ ...doc, types: [...doc.types, type] }, { selection: { kind: 'type', id } })
    },
    updateType: (id, patch) => {
      let { doc } = get()
      const old = doc.types.find((t) => t.id === id)
      if (!old) return
      if (patch.name !== undefined && patch.name !== old.name && patch.name.trim() !== '') {
        doc = renameRefs(doc, old.name, patch.name)
      }
      commit({ ...doc, types: doc.types.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
    },
    removeType: (id) => {
      const { doc, selection } = get()
      commit(
        { ...doc, types: doc.types.filter((t) => t.id !== id) },
        selection?.kind === 'type' && selection.id === id ? { selection: null } : {},
      )
    },

    addFunction: () => {
      const { doc } = get()
      let i = doc.functions.length + 1
      while (doc.functions.some((f) => f.name === `fn${i}`)) i++
      const id = `fn-${uid()}`
      const spec = (): SchemaSpec => ({ mode: 'json', schema: { type: 'object', properties: {}, required: [] } })
      const fn: FnDef = { id, name: `fn${i}`, input: spec(), output: spec() }
      commit({ ...doc, functions: [...doc.functions, fn] }, { selection: { kind: 'function', id } })
    },
    updateFunction: (id, patch) => {
      const { doc } = get()
      commit({ ...doc, functions: doc.functions.map((f) => (f.id === id ? { ...f, ...patch } : f)) })
    },
    removeFunction: (id) => {
      const { doc, selection } = get()
      commit(
        {
          ...doc,
          functions: doc.functions.filter((f) => f.id !== id),
          nodes: doc.nodes.map((n) =>
            n.type === 'call' && n.data.fnId === id ? { ...n, data: { ...n.data, fnId: null } } : n,
          ),
        },
        selection?.kind === 'function' && selection.id === id ? { selection: null } : {},
      )
    },

    loadExample: (id) => {
      const ex = EXAMPLES.find((e) => e.id === id)
      if (!ex) return
      commit(normalize(ex.build()), {
        selection: null,
        exampleId: id,
        version: get().version + 1,
        run: IDLE_RUN,
      })
    },
    setRunInput: (text) => set({ run: { ...get().run, inputText: text, parseError: null } }),

    generateRunInput: (seed = Math.floor(Math.random() * 1e6)) =>
      set({ run: { ...get().run, inputText: sampleInput(get().doc, seed), parseError: null } }),

    startRun: async (opts = {}) => {
      const { doc, run } = get()
      const text = run.inputText ?? sampleInput(doc)
      let input: unknown
      try {
        input = text.trim() === '' ? undefined : JSON.parse(text)
      } catch (e) {
        set({ run: { ...run, inputText: text, parseError: (e as Error).message, result: null, view: null, playing: false } })
        return
      }
      set({ run: { ...run, inputText: text, running: true, parseError: null, playing: false } })
      const result = await runFlow(doc, input)
      const play = opts.play ?? true
      const cursor = play ? 0 : null
      set({
        run: {
          ...get().run,
          inputText: text,
          running: false,
          result,
          cursor,
          playing: play && result.steps.length > 1,
          view: buildRunView(get().doc, result, cursor),
        },
      })
    },

    setCursor: (cursor) => {
      const { run, doc } = get()
      if (!run.result) return
      set({ run: { ...run, cursor, playing: false, view: buildRunView(doc, run.result, cursor) } })
    },

    stepRun: (delta) => {
      const { run, doc } = get()
      if (!run.result) return
      const n = run.result.steps.length
      const at = run.cursor === null ? n - 1 : run.cursor
      const next = Math.max(0, Math.min(n - 1, at + delta))
      const playing = run.playing && next < n - 1
      set({ run: { ...run, cursor: next, playing, view: buildRunView(doc, run.result, next) } })
    },

    setPlaying: (playing) => {
      const { run, doc } = get()
      if (!run.result) return
      // pressing play at the end starts over
      const atEnd = run.cursor === null || run.cursor >= run.result.steps.length - 1
      if (playing && atEnd) {
        set({ run: { ...run, cursor: 0, playing: true, view: buildRunView(doc, run.result, 0) } })
      } else set({ run: { ...run, playing } })
    },

    clearRun: () => set({ run: { ...IDLE_RUN, inputText: get().run.inputText } }),

    clear: () =>
      commit(normalize(emptyDoc()), {
        selection: null,
        exampleId: null,
        version: get().version + 1,
        run: IDLE_RUN,
      }),
  }
})

/* persistence (debounced); selection/viewport are not part of the document */
let saveTimer: ReturnType<typeof setTimeout> | undefined
useStore.subscribe((state, prev) => {
  if (state.doc === prev.doc && state.exampleId === prev.exampleId) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ doc: state.doc, exampleId: state.exampleId }))
    } catch {
      /* quota or privacy mode: persistence is a convenience only */
    }
  }, 400)
})
