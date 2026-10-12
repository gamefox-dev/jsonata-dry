import {
  dryRunTy,
  fromSchema,
  toSchema,
  show,
  union,
  type DryRunResult,
  type JSONSchema,
  type SchemaContext,
  type Ty,
} from '../dry'
import {
  ANY,
  BOOL,
  INT,
  NEVER,
  arr,
  assignable,
  equals,
  explain,
  hasUndef,
  members,
  removeUndef,
  widen,
} from '../dry/ty'
import {
  handlesOf,
  isTriggerHandle,
  sourceHandleOf,
  targetHandleOf,
  varHandle,
  type FlowDoc,
  type FlowEdge,
  type FlowNode,
} from './model'

export interface TypeInfo {
  ty: Ty
  /** TypeScript-flavoured rendering */
  type: string
  schema: JSONSchema
  /** may be undefined (no value) */
  optional: boolean
}

export interface Msg {
  severity: 'error' | 'warning' | 'info'
  message: string
}

/**
 *  live        – can execute
 *  dead        – statically unreachable (a gate upstream never fires, or its data never arrives)
 *  unreachable – not connected to the flow's input at all
 */
export type NodeStatus = 'live' | 'dead' | 'unreachable'

export interface NodeReport {
  status: NodeStatus
  deadReason?: string
  /** runs in a detached (async) branch: nothing downstream can contribute to the result */
  async: boolean
  inputs: Record<string, TypeInfo | null>
  outputs: Record<string, TypeInfo>
  messages: Msg[]
  /** expression result for transform / condition nodes (diagnostics carry source ranges) */
  dry?: DryRunResult
  /** does each trigger gate this node exposes ever fire? */
  gates: Record<string, { live: boolean; reason?: string }>
}

export interface EdgeReport {
  kind: 'data' | 'trigger'
  type?: TypeInfo
  error?: string
  dead: boolean
  async: boolean
}

export interface ReturnReport {
  nodeId: string
  type: TypeInfo | null
  /** contributes to the flow's result type */
  counted: boolean
}

export interface FlowAnalysis {
  nodes: Record<string, NodeReport>
  edges: Record<string, EdgeReport>
  returns: ReturnReport[]
  /** the unified result type of the whole flow (null when it never returns) */
  returnType: TypeInfo | null
  messages: (Msg & { nodeId?: string })[]
  ok: boolean
}

const info = (ty: Ty): TypeInfo => ({
  ty,
  type: show(ty),
  schema: toSchema(removeUndef(ty)),
  optional: hasUndef(ty),
})

const removeNullish = (t: Ty) =>
  union(...members(t).filter((m) => m.k !== 'null' && m.k !== 'undef'))

/**
 * Can two return types be merged into one? Allowed: identical types, a subtype and its supertype,
 * types differing only by null/undefined (nullable/optional), and objects/arrays whose parts are
 * recursively combinable. Anything else is a genuine conflict (returns null).
 */
export function combineReturns(a: Ty, b: Ty): Ty | null {
  if (a.k === 'any' || b.k === 'any') return ANY
  if (equals(a, b)) return a
  if (assignable(b, a)) return a
  if (assignable(a, b)) return b

  const na = removeNullish(a)
  const nb = removeNullish(b)
  if (na.k === 'never' || nb.k === 'never') return union(a, b)
  if (!equals(na, a) || !equals(nb, b)) {
    const inner = combineReturns(na, nb)
    if (!inner) return null
    const nullish = [...members(a), ...members(b)].filter((m) => m.k === 'null' || m.k === 'undef')
    return union(inner, ...nullish)
  }
  if (a.k === 'arr' && b.k === 'arr') {
    const item = combineReturns(a.item, b.item)
    return item ? arr(item) : null
  }
  if (a.k === 'obj' && b.k === 'obj') {
    const props: Record<string, Ty> = {}
    const req: string[] = []
    for (const k of new Set([...Object.keys(a.props), ...Object.keys(b.props)])) {
      const pa = a.props[k]
      const pb = b.props[k]
      if (pa && pb) {
        const m = combineReturns(removeUndef(pa), removeUndef(pb))
        if (!m) return null
        props[k] = m
        if (a.req.includes(k) && b.req.includes(k)) req.push(k)
      } else props[k] = pa ?? pb
    }
    const extra = a.extra === false && b.extra === false ? false : undefined
    return { k: 'obj', props, req, extra }
  }
  return null
}

export function analyzeFlow(doc: FlowDoc): FlowAnalysis {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const incoming = new Map<string, FlowEdge[]>()
  for (const e of doc.edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e])
  const inEdges = (id: string, handle: string) =>
    (incoming.get(id) ?? []).filter((e) => targetHandleOf(e) === handle)

  const defs: Record<string, JSONSchema> = {}
  for (const t of doc.types) defs[t.name] = t.spec.schema
  const schemaCtx: SchemaContext = { defs }

  const reports: Record<string, NodeReport> = {}
  const edgeErrors = new Map<string, string>()
  const messages: FlowAnalysis['messages'] = []
  for (const n of doc.nodes) {
    reports[n.id] = {
      status: 'live',
      async: false,
      inputs: {},
      outputs: {},
      messages: [],
      gates: {},
    }
  }
  const say = (nodeId: string, severity: Msg['severity'], message: string, edge?: FlowEdge) => {
    const r = reports[nodeId]
    if (!r.messages.some((m) => m.message === message && m.severity === severity)) {
      r.messages.push({ severity, message })
      messages.push({ severity, message, nodeId })
    }
    if (edge && severity === 'error') edgeErrors.set(edge.id, message)
  }
  const nodeName = (n: FlowNode) => n.data.label || n.type

  /* ---------------- 1. type propagation (demand driven, memoised) ---------------- */

  type Outputs = Record<string, Ty>
  const memo = new Map<string, Outputs>()
  const visiting = new Set<string>()

  const outputOf = (nodeId: string, handle: string): Ty => {
    const node = byId.get(nodeId)
    if (!node) return ANY
    if (isTriggerHandle(handle)) return ANY
    const phase = node.type === 'loop' && handle === 'results' ? 'tail' : 'head'
    return evalNode(node, phase)[handle] ?? ANY
  }

  /** the type arriving at `handle`, or null when nothing is connected */
  const inputOf = (nodeId: string, handle: string): { ty: Ty | null; edge?: FlowEdge } => {
    const edges = inEdges(nodeId, handle)
    if (edges.length === 0) return { ty: null }
    const edge = edges[0]
    if (edges.length > 1) {
      say(nodeId, 'warning', `Input "${handle}" has ${edges.length} connections; only the first is used.`)
    }
    const sh = sourceHandleOf(edge)
    if (isTriggerHandle(sh)) {
      say(nodeId, 'error', `A trigger gate cannot supply data to "${handle}".`, edge)
      return { ty: ANY, edge }
    }
    return { ty: outputOf(edge.source, sh), edge }
  }

  const evalNode = (node: FlowNode, phase: 'head' | 'tail'): Outputs => {
    const memoKey = `${node.id}:${phase}`
    const hit = memo.get(memoKey)
    if (hit) return hit
    if (visiting.has(memoKey)) {
      say(node.id, 'error', 'This node depends on its own output (cycle).')
      return {}
    }
    visiting.add(memoKey)
    const out: Outputs = {}
    const report = reports[node.id]
    const record = (handle: string, t: { ty: Ty | null }) => {
      report.inputs[handle] = t.ty ? info(t.ty) : null
    }

    switch (node.type) {
      case 'input': {
        out.out = fromSchema(node.data.spec.schema, {
          ...schemaCtx,
          onUnresolved: (ref) => say(node.id, 'warning', `Unknown type reference "${ref}".`),
        })
        break
      }

      case 'transform':
      case 'condition': {
        const inp = inputOf(node.id, 'in')
        record('in', inp)
        if (!inp.ty) {
          say(node.id, 'warning', 'No input connected: "$" is untyped (any).')
        }
        const bindings: Record<string, Ty> = {}
        for (const v of node.data.variables) {
          const vi = inputOf(node.id, varHandle(v))
          record(varHandle(v), vi)
          if (!vi.ty) say(node.id, 'warning', `Variable $${v} is not connected.`)
          bindings[v] = vi.ty ?? ANY
        }
        const dry = dryRunTy(node.data.expression, inp.ty ?? ANY, { bindings })
        report.dry = dry
        for (const d of dry.diagnostics) {
          if (d.severity !== 'info') say(node.id, d.severity, `Expression: ${d.message}`)
        }

        if (node.type === 'transform') {
          out.out = dry.ty
        } else {
          const t = dry.ty
          const defined = removeUndef(t)
          const bad = members(defined).filter((m) => m.k !== 'bool' && m.k !== 'any')
          if (bad.length) {
            say(
              node.id,
              'error',
              `A condition must produce a boolean, but this produces ${show(defined)}. Wrap it in $boolean() if you want truthiness.`,
            )
          } else if (hasUndef(t)) {
            say(node.id, 'warning', 'The condition may be undefined; undefined is treated as false.')
          }
          const bools = members(defined).filter((m) => m.k === 'bool')
          out.out = bad.length ? BOOL : union(...bools, hasUndef(t) ? { k: 'bool', v: false } : NEVER)
          if (out.out.k === 'never') out.out = BOOL
        }
        break
      }

      case 'branch': {
        const inp = inputOf(node.id, 'in')
        record('in', inp)
        if (!inp.ty) say(node.id, 'error', 'The branch has no condition connected.')
        else {
          const why = explain(inp.ty, BOOL)
          if (why) say(node.id, 'error', `A branch needs a boolean, but received ${show(inp.ty)}.`, inp.edge)
        }
        break
      }

      case 'loop': {
        const inp = inputOf(node.id, 'in')
        record('in', inp)
        if (phase === 'head') {
          if (!inp.ty) {
            say(node.id, 'error', 'The loop has no array connected.')
            out.item = ANY
          } else {
            const ms = members(removeUndef(inp.ty))
            const bad = ms.filter((m) => m.k !== 'arr' && m.k !== 'any')
            if (bad.length) {
              say(node.id, 'error', `A loop iterates over an array, but received ${show(inp.ty)}.`, inp.edge)
            } else if (hasUndef(inp.ty)) {
              say(node.id, 'warning', 'The array may be undefined; the loop would not run.')
            }
            out.item = union(...ms.map((m) => (m.k === 'arr' ? m.item : ANY)))
          }
          out.index = INT
          if (node.data.mode === 'reduce') {
            const init = inputOf(node.id, 'initial')
            record('initial', init)
            if (!init.ty) {
              say(node.id, 'error', 'A reduce loop needs an initial value.')
              out.acc = ANY
            } else out.acc = widen(removeUndef(init.ty), false)
          }
        } else {
          const head = evalNode(node, 'head')
          const col = inputOf(node.id, 'collect')
          record('collect', col)
          if (node.data.mode === 'reduce') {
            const acc = head.acc ?? ANY
            if (col.ty) {
              const why = explain(removeUndef(col.ty), acc)
              if (why) {
                say(
                  node.id,
                  'error',
                  `The next accumulator (${show(col.ty)}) does not match the accumulator type ${show(acc)}: ${why}.`,
                  col.edge,
                )
              }
            } else say(node.id, 'warning', 'Nothing is connected to "next acc"; the accumulator never changes.')
            out.results = acc
          } else {
            if (!col.ty) say(node.id, 'info', 'Nothing is collected, so "results" is always empty.')
            out.results = arr(col.ty ? removeUndef(col.ty) : NEVER)
          }
        }
        break
      }

      case 'call': {
        const fnDef = doc.functions.find((f) => f.id === node.data.fnId)
        const arg = inputOf(node.id, 'arg')
        record('arg', arg)
        if (!fnDef) {
          say(node.id, 'error', 'No function selected.')
          out.out = ANY
          break
        }
        const input = fromSchema(fnDef.input.schema, schemaCtx)
        const output = fromSchema(fnDef.output.schema, schemaCtx)
        if (!arg.ty) {
          say(node.id, 'error', `${fnDef.name} needs an argument of type ${show(input)}.`)
        } else {
          const why = explain(arg.ty, input)
          if (why) {
            say(
              node.id,
              'error',
              `Argument does not match ${fnDef.name}(${show(input)}): ${why}.`,
              arg.edge,
            )
          }
        }
        out.out = output
        break
      }

      case 'return': {
        const inp = inputOf(node.id, 'in')
        record('in', inp)
        if (!inp.ty) say(node.id, 'error', 'The return has no value connected.')
        break
      }
    }

    for (const [h, t] of Object.entries(out)) report.outputs[h] = info(t)
    visiting.delete(memoKey)
    memo.set(memoKey, out)
    return out
  }

  for (const n of doc.nodes) {
    evalNode(n, 'head')
    if (n.type === 'loop') evalNode(n, 'tail')
  }

  /* ---------------- 2. reachability, dead branches, async ---------------- */

  const roots = doc.nodes.filter((n) => n.type === 'input')
  const reached = new Set<string>(roots.map((r) => r.id))
  {
    const out = new Map<string, string[]>()
    for (const e of doc.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target])
    const stack = [...reached]
    while (stack.length) {
      for (const next of out.get(stack.pop() as string) ?? []) {
        if (!reached.has(next)) {
          reached.add(next)
          stack.push(next)
        }
      }
    }
  }
  if (roots.length === 0) {
    messages.push({ severity: 'error', message: 'The flow has no input node.' })
  }

  interface Live {
    live: boolean
    reason?: string
    async: boolean
    unreachable?: boolean
  }
  const liveMemo = new Map<string, Live>()
  const liveVisiting = new Set<string>()

  const nodeLive = (id: string): Live => {
    const hit = liveMemo.get(id)
    if (hit) return hit
    const node = byId.get(id)
    if (!node) return { live: false, async: false, reason: 'missing node' }
    let res: Live
    if (!reached.has(id)) {
      res = { live: false, async: false, unreachable: true, reason: 'it is not connected to the flow input' }
    } else if (node.type === 'input') {
      res = { live: true, async: false }
    } else if (liveVisiting.has(id)) {
      return { live: false, async: false, reason: 'it is part of a cycle' }
    } else {
      liveVisiting.add(id)
      res = { live: true, async: false }
      const trig = inEdges(id, 'trigger')
      if (trig.length) {
        const gates = trig.map((e) => gateLive(e.source, sourceHandleOf(e)))
        const lives = gates.filter((g) => g.live)
        if (lives.length === 0) {
          res = { live: false, async: false, reason: gates[0]?.reason ?? 'its trigger never fires' }
        } else res.async = lives.some((g) => g.async)
      }
      if (res.live) {
        for (const e of incoming.get(id) ?? []) {
          const th = targetHandleOf(e)
          if (th === 'trigger' || th === 'collect') continue
          const src = nodeLive(e.source)
          if (!src.live) {
            const sn = byId.get(e.source)
            res = {
              live: false,
              async: false,
              reason: `its "${th}" input comes from "${sn ? nodeName(sn) : e.source}", which never runs (${src.reason})`,
            }
            break
          }
          const sh = sourceHandleOf(e)
          const srcNode = byId.get(e.source)
          const detached = srcNode?.type === 'call' && srcNode.data.async && sh === 'out'
          if (src.async || detached) res.async = true
        }
      }
      liveVisiting.delete(id)
    }
    liveMemo.set(id, res)
    return res
  }

  /** does the gate `handle` of `id` ever fire? */
  const gateLive = (id: string, handle: string): Live => {
    const n = nodeLive(id)
    if (!n.live) return n
    const node = byId.get(id)
    if (node?.type === 'branch') {
      const c = reports[id].inputs.in?.ty
      const ms = c ? members(c) : []
      if (ms.length === 1 && ms[0].k === 'bool' && ms[0].v !== undefined) {
        if (handle === 'yes' && ms[0].v === false) {
          return { live: false, async: n.async, reason: `the condition of "${nodeName(node)}" is always false` }
        }
        if (handle === 'no' && ms[0].v === true) {
          return { live: false, async: n.async, reason: `the condition of "${nodeName(node)}" is always true` }
        }
      }
    }
    if (node?.type === 'loop' && handle === 'each') {
      const item = reports[id].outputs.item?.ty
      if (item && item.k === 'never') {
        return { live: false, async: n.async, reason: `"${nodeName(node)}" iterates an always-empty array` }
      }
    }
    return n
  }

  for (const n of doc.nodes) {
    const r = reports[n.id]
    const l = nodeLive(n.id)
    r.async = l.async
    for (const h of handlesOf(n).sources) {
      if (h.kind !== 'trigger') continue
      const g = gateLive(n.id, h.id)
      r.gates[h.id] = { live: g.live, reason: g.reason }
    }
    if (l.unreachable) {
      r.status = 'unreachable'
      r.deadReason = l.reason
      if (n.type !== 'input') say(n.id, 'warning', 'Not connected to the flow input, so it never runs.')
    } else if (!l.live) {
      r.status = 'dead'
      r.deadReason = l.reason
      say(n.id, 'info', `Dead branch: this node never runs because ${l.reason}.`)
    }
  }

  /* ---------------- 3. returns ---------------- */

  const returns: ReturnReport[] = []
  const counted: { id: string; ty: Ty }[] = []
  for (const n of doc.nodes) {
    if (n.type !== 'return') continue
    const r = reports[n.id]
    const ty = r.inputs.in?.ty ?? null
    let isCounted = false
    if (r.status === 'live') {
      if (r.async) {
        say(
          n.id,
          'error',
          'This return sits in an async branch: the flow has already moved on, so its value can never be returned.',
        )
      } else if (ty) {
        isCounted = true
        counted.push({ id: n.id, ty })
      }
    }
    returns.push({ nodeId: n.id, type: ty ? info(ty) : null, counted: isCounted })
  }

  let returnType: TypeInfo | null = null
  if (counted.length) {
    let acc = counted[0].ty
    let accFrom = counted[0].id
    for (const next of counted.slice(1)) {
      const merged = combineReturns(acc, next.ty)
      if (merged) {
        acc = merged
      } else {
        const msg = `Return types are not compatible: ${show(next.ty)} here vs ${show(acc)} from "${nodeName(byId.get(accFrom) as FlowNode)}". Returns must have the same type, or differ only by null/undefined or by being a subtype.`
        say(next.id, 'error', msg)
        say(accFrom, 'error', msg)
        acc = union(acc, next.ty)
      }
      accFrom = next.id
    }
    returnType = info(acc)
  } else if (roots.length > 0) {
    messages.push({
      severity: 'warning',
      message: 'No reachable return node: this flow never produces a value.',
    })
  }

  /* ---------------- 4. edges ---------------- */

  const edges: Record<string, EdgeReport> = {}
  for (const e of doc.edges) {
    const sh = sourceHandleOf(e)
    const kind = isTriggerHandle(sh) ? 'trigger' : 'data'
    const gate = gateLive(e.source, sh)
    const target = nodeLive(e.target)
    const srcNode = byId.get(e.source)
    const detached = srcNode?.type === 'call' && srcNode.data.async && sh === 'out'
    edges[e.id] = {
      kind,
      type: kind === 'data' ? reports[e.source]?.outputs[sh] : undefined,
      error: edgeErrors.get(e.id),
      dead: !gate.live || !target.live,
      async: gate.async || detached,
    }
  }

  // validate handles that no longer exist (e.g. a removed variable)
  for (const e of doc.edges) {
    const s = byId.get(e.source)
    const t = byId.get(e.target)
    if (!s || !t) continue
    if (!handlesOf(t).targets.some((h) => h.id === targetHandleOf(e))) {
      edgeErrors.set(e.id, 'This connection points at a handle that no longer exists.')
      edges[e.id].error = edgeErrors.get(e.id)
      say(t.id, 'warning', `A connection targets a missing handle "${targetHandleOf(e)}".`)
    }
  }

  return {
    nodes: reports,
    edges,
    returns,
    returnType,
    messages,
    ok: !messages.some((m) => m.severity === 'error'),
  }
}
