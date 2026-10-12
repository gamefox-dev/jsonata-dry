import jsonata from 'jsonata'
import { fromSchema } from '../dry/schema'
import { rng, sample } from '../dry/sample'
import { removeUndef } from '../dry/ty'
import {
  isTriggerHandle,
  sourceHandleOf,
  targetHandleOf,
  type FlowDoc,
  type FlowEdge,
  type FlowNode,
} from './model'

/** one node execution */
export interface RunStep {
  seq: number
  nodeId: string
  /** the loop iterations this execution happened inside, outermost first */
  scope: { loopId: string; index: number }[]
  inputs: Record<string, unknown>
  outputs: Record<string, unknown>
  /** trigger gates this execution fired */
  fired: string[]
  /** ran in an async branch that can no longer affect the result */
  detached: boolean
  error?: string
  /** how the value was produced when it is not just "evaluated" */
  note?: string
}

export interface RunResult {
  status: 'returned' | 'finished' | 'failed'
  /** the value of the first synchronous return reached */
  value?: unknown
  returnedBy?: string
  steps: RunStep[]
  error?: { nodeId: string; message: string }
  /** returns reached only in async branches: their values were discarded */
  ignoredReturns: string[]
}

class ReturnSignal {
  nodeId: string
  value: unknown
  constructor(nodeId: string, value: unknown) {
    this.nodeId = nodeId
    this.value = value
  }
}

class StepError extends Error {
  nodeId: string
  constructor(nodeId: string, message: string) {
    super(message)
    this.nodeId = nodeId
  }
}

interface Cell {
  v: unknown
  detached: boolean
}

class Scope {
  readonly parent: Scope | null
  readonly path: RunStep['scope']
  readonly values = new Map<string, Cell>()
  readonly gates = new Map<string, boolean>()
  readonly executed = new Set<string>()
  constructor(parent: Scope | null, path: RunStep['scope']) {
    this.parent = parent
    this.path = path
  }
  value(key: string): Cell | undefined {
    return this.values.get(key) ?? this.parent?.value(key)
  }
  gate(key: string): boolean | undefined {
    return this.gates.get(key) ?? this.parent?.gate(key)
  }
  done(id: string): boolean {
    return this.executed.has(id) || (this.parent?.done(id) ?? false)
  }
}

/** a JSON-safe copy, so later mutation can't rewrite history */
const snap = (v: unknown): unknown => {
  if (v === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return String(v)
  }
}

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7)

export interface RunOptions {
  maxSteps?: number
  maxIterations?: number
}

/**
 * Execute a flow for real: JSONata expressions are evaluated with the real library, functions are
 * answered by their mock expression (or a generated sample of their return type), and every node
 * execution is recorded in order.
 *
 * Semantics mirror the static analysis: a node runs when all its data inputs have arrived and, if it
 * has a trigger connection, a trigger has fired; branches fire exactly one gate; loops run their body
 * (everything behind the `each` gate) once per item in a fresh scope; the first synchronous return
 * ends the flow; async branches keep running but cannot return a value.
 */
export async function runFlow(doc: FlowDoc, input: unknown, opts: RunOptions = {}): Promise<RunResult> {
  const maxSteps = opts.maxSteps ?? 5000
  const maxIterations = opts.maxIterations ?? 1000
  const steps: RunStep[] = []
  const ignoredReturns: string[] = []
  const defs: Record<string, never> = {}
  for (const t of doc.types) (defs as Record<string, unknown>)[t.name] = t.spec.schema

  const incoming = new Map<string, FlowEdge[]>()
  for (const e of doc.edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e])

  let drain = false // after the flow returned: only detached work may still run

  const dataEdges = (n: FlowNode) =>
    (incoming.get(n.id) ?? []).filter((e) => {
      const th = targetHandleOf(e)
      return th !== 'trigger' && th !== 'collect' && !isTriggerHandle(sourceHandleOf(e))
    })
  const triggerEdges = (n: FlowNode) =>
    (incoming.get(n.id) ?? []).filter((e) => targetHandleOf(e) === 'trigger')

  /** has everything this node waits for arrived? */
  const ready = (n: FlowNode, scope: Scope): boolean => {
    const edges = incoming.get(n.id) ?? []
    if (edges.length === 0) return false
    const trig = triggerEdges(n)
    let detached = false
    if (trig.length) {
      const fired = trig.filter((e) => scope.gate(`${e.source}:${sourceHandleOf(e)}`) !== undefined)
      if (fired.length === 0) return false
      detached = fired.some((e) => scope.gate(`${e.source}:${sourceHandleOf(e)}`) === true)
    }
    for (const e of dataEdges(n)) {
      const c = scope.value(`${e.source}:${sourceHandleOf(e)}`)
      if (!c) return false
      if (c.detached) detached = true
    }
    return drain ? detached : true
  }

  const inputsOf = (n: FlowNode, scope: Scope) => {
    const inputs: Record<string, unknown> = {}
    let detached = false
    for (const e of dataEdges(n)) {
      const c = scope.value(`${e.source}:${sourceHandleOf(e)}`)
      inputs[targetHandleOf(e)] = c?.v
      if (c?.detached) detached = true
    }
    for (const e of triggerEdges(n)) {
      if (scope.gate(`${e.source}:${sourceHandleOf(e)}`) === true) detached = true
    }
    return { inputs, detached }
  }

  const evaluate = async (expr: string, ctx: unknown, bindings: Record<string, unknown> = {}) => {
    try {
      return await jsonata(expr).evaluate(ctx, bindings)
    } catch (e) {
      throw new Error((e as { message?: string }).message ?? String(e))
    }
  }

  const callFunction = async (n: Extract<FlowNode, { type: 'call' }>, arg: unknown) => {
    const fn = doc.functions.find((f) => f.id === n.data.fnId)
    if (!fn) throw new Error('No function selected.')
    if (fn.mock && fn.mock.trim()) {
      return { value: await evaluate(fn.mock, arg), note: `${fn.name}: mock expression` }
    }
    const ty = removeUndef(fromSchema(fn.output.schema, { defs }))
    return { value: sample(ty, rng(hash(fn.id))), note: `${fn.name}: generated sample of the return type` }
  }

  const record = (
    n: FlowNode,
    scope: Scope,
    r: Omit<RunStep, 'seq' | 'nodeId' | 'scope'>,
  ): RunStep => {
    const step: RunStep = { seq: steps.length + 1, nodeId: n.id, scope: scope.path, ...r }
    steps.push(step)
    return step
  }

  const exec = async (n: FlowNode, scope: Scope): Promise<void> => {
    if (steps.length >= maxSteps) throw new Error(`Stopped after ${maxSteps} steps (possible runaway loop).`)
    const { inputs, detached } = inputsOf(n, scope)
    const outputs: Record<string, unknown> = {}
    const fired: string[] = []
    let note: string | undefined
    let outDetached = detached
    scope.executed.add(n.id)

    const fail = (e: unknown) => {
      const message = (e as Error).message ?? String(e)
      record(n, scope, { inputs: snap(inputs) as never, outputs: {}, fired: [], detached, error: message })
      throw new StepError(n.id, message)
    }

    try {
      switch (n.type) {
        case 'input':
          break
        case 'transform': {
          const vars: Record<string, unknown> = {}
          for (const v of n.data.variables) vars[v] = inputs[`var:${v}`]
          outputs.out = await evaluate(n.data.expression, inputs.in, vars)
          fired.push('done')
          break
        }
        case 'condition': {
          const vars: Record<string, unknown> = {}
          for (const v of n.data.variables) vars[v] = inputs[`var:${v}`]
          const r = await evaluate(n.data.expression, inputs.in, vars)
          if (r !== undefined && typeof r !== 'boolean') {
            throw new Error(`A condition must produce a boolean, got ${typeof r}.`)
          }
          outputs.out = r === undefined ? false : r
          if (r === undefined) note = 'undefined → false'
          fired.push('done')
          break
        }
        case 'branch': {
          if (typeof inputs.in !== 'boolean') throw new Error(`A branch needs a boolean, got ${typeof inputs.in}.`)
          fired.push(inputs.in ? 'yes' : 'no')
          break
        }
        case 'call': {
          const r = await callFunction(n, inputs.arg)
          outputs.out = r.value
          note = (n.data.async ? 'async · ' : '') + r.note
          if (n.data.async) outDetached = true
          fired.push('done')
          break
        }
        case 'return': {
          outputs.in = inputs.in
          break
        }
        case 'loop':
          break // handled below
      }
    } catch (e) {
      fail(e)
    }

    if (n.type === 'loop') {
      await runLoop(n, scope, inputs, detached)
      return
    }

    // publish values and gates
    for (const [h, v] of Object.entries(outputs)) {
      if (n.type === 'return') continue
      scope.values.set(`${n.id}:${h}`, { v: snap(v), detached: outDetached && !(n.type === 'call' && h === 'done') })
    }
    for (const g of fired) scope.gates.set(`${n.id}:${g}`, detached)

    record(n, scope, {
      inputs: snap(inputs) as Record<string, unknown>,
      outputs: snap(outputs) as Record<string, unknown>,
      fired,
      detached,
      note,
    })

    if (n.type === 'return') {
      if (detached) ignoredReturns.push(n.id)
      else throw new ReturnSignal(n.id, snap(inputs.in))
    }
  }

  const runLoop = async (
    n: Extract<FlowNode, { type: 'loop' }>,
    scope: Scope,
    inputs: Record<string, unknown>,
    detached: boolean,
  ) => {
    const arr = inputs.in
    if (arr !== undefined && !Array.isArray(arr)) {
      const message = `A loop iterates over an array, got ${typeof arr}.`
      record(n, scope, { inputs: snap(inputs) as never, outputs: {}, fired: [], detached, error: message })
      throw new StepError(n.id, message)
    }
    const items = (arr as unknown[] | undefined) ?? []
    if (items.length > maxIterations) {
      const message = `Refusing to run ${items.length} iterations (limit ${maxIterations}).`
      record(n, scope, { inputs: snap(inputs) as never, outputs: {}, fired: [], detached, error: message })
      throw new StepError(n.id, message)
    }
    const reduce = n.data.mode === 'reduce'
    const collect = (incoming.get(n.id) ?? []).find((e) => targetHandleOf(e) === 'collect')
    let acc = reduce ? inputs.initial : undefined
    const results: unknown[] = []

    // the loop's own step goes first so iterations read as its children
    const step = record(n, scope, {
      inputs: snap(inputs) as Record<string, unknown>,
      outputs: {},
      fired: [],
      detached,
      note: `${items.length} iteration${items.length === 1 ? '' : 's'} (${n.data.mode})`,
    })

    for (let i = 0; i < items.length; i++) {
      const inner = new Scope(scope, [...scope.path, { loopId: n.id, index: i }])
      inner.values.set(`${n.id}:item`, { v: snap(items[i]), detached })
      inner.values.set(`${n.id}:index`, { v: i, detached })
      if (reduce) inner.values.set(`${n.id}:acc`, { v: snap(acc), detached })
      inner.gates.set(`${n.id}:each`, detached)
      await propagate(inner)
      if (collect) {
        const c = inner.value(`${collect.source}:${sourceHandleOf(collect)}`)
        if (reduce) {
          if (c) acc = c.v
        } else if (c && c.v !== undefined) results.push(c.v)
      }
    }

    const out = reduce ? acc : results
    scope.values.set(`${n.id}:results`, { v: snap(out), detached })
    scope.gates.set(`${n.id}:done`, detached)
    step.outputs = { results: snap(out) }
    step.fired = ['done']
  }

  /** run every node that can run in this scope until nothing more can */
  const propagate = async (scope: Scope): Promise<void> => {
    let progressed = true
    while (progressed) {
      progressed = false
      for (const n of doc.nodes) {
        if (n.type === 'input' || scope.done(n.id)) continue
        if (!ready(n, scope)) continue
        await exec(n, scope)
        progressed = true
      }
    }
  }

  const root = new Scope(null, [])
  const start = doc.nodes.find((n) => n.type === 'input')
  if (!start) {
    return { status: 'failed', steps, ignoredReturns, error: { nodeId: '', message: 'The flow has no input node.' } }
  }
  root.executed.add(start.id)
  root.values.set(`${start.id}:out`, { v: snap(input), detached: false })
  root.gates.set(`${start.id}:done`, false)
  record(start, root, {
    inputs: {},
    outputs: { out: snap(input) },
    fired: ['done'],
    detached: false,
    note: 'flow input',
  })

  try {
    await propagate(root)
    return { status: 'finished', steps, ignoredReturns }
  } catch (e) {
    if (e instanceof ReturnSignal) {
      // the flow has its value; async work that was already in flight still completes
      drain = true
      try {
        await propagate(root)
      } catch (inner) {
        if (!(inner instanceof ReturnSignal) && !(inner instanceof StepError)) throw inner
      }
      return { status: 'returned', value: e.value, returnedBy: e.nodeId, steps, ignoredReturns }
    }
    if (e instanceof StepError) {
      return { status: 'failed', steps, ignoredReturns, error: { nodeId: e.nodeId, message: e.message } }
    }
    return { status: 'failed', steps, ignoredReturns, error: { nodeId: '', message: (e as Error).message } }
  }
}
