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
import { EXAMPLES } from './flow/examples'
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
  | null

interface Store {
  doc: FlowDoc
  analysis: FlowAnalysis
  selection: Selection
  exampleId: string | null
  /** bumped whenever a whole document is loaded, so the canvas can re-fit the view */
  version: number
  /** set by the canvas so the palette can drop nodes in the middle of the viewport */
  viewportCenter: (() => XYPosition) | null

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
      commit(normalize(ex.build()), { selection: null, exampleId: id, version: get().version + 1 })
    },
    clear: () =>
      commit(normalize(emptyDoc()), { selection: null, exampleId: null, version: get().version + 1 }),
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
