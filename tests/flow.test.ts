import { describe, expect, test } from 'bun:test'
import { analyzeFlow, combineReturns } from '../src/flow/analyze'
import { EXAMPLES } from '../src/flow/examples'
import { obj, STR, NUM, NULL, INT, BOOL, arr, UNDEF, show, union } from '../src/dry/ty'
import { evalTypeBox, schemaToTypeBox } from '../src/schema/typebox'

const example = (id: string) => (EXAMPLES.find((e) => e.id === id) as (typeof EXAMPLES)[number]).build()

describe('order checkout example', () => {
  const a = analyzeFlow(example('order'))

  test('has no errors or warnings', () => {
    const bad = a.messages.filter((m) => m.severity !== 'info')
    expect(bad).toEqual([])
    expect(a.ok).toBe(true)
  })

  test('every node is live', () => {
    for (const [id, r] of Object.entries(a.nodes)) expect([id, r.status]).toEqual([id, 'live'])
  })

  test('propagates types through transforms', () => {
    expect(a.nodes.summary.outputs.out.type).toBe(
      '{ orderId: string; customer: string; email?: string; total: number }',
    )
    expect(a.nodes.large.outputs.out.type).toBe('boolean')
    expect(a.nodes.reserve.outputs.out.type).toBe('{ reserved: boolean }')
    expect(a.nodes.each.outputs.results.type).toBe('{ reserved: boolean }[]')
    expect(a.nodes.each.outputs.item.type).toBe('{ sku: string; qty: integer; price: number }')
  })

  test('the async call detaches only its own result', () => {
    expect(a.nodes.send.async).toBe(false) // the call itself runs in the main flow
    expect(a.nodes.approved.async).toBe(false) // `done` of an async call continues the main flow
    expect(a.returns.every((r) => r.counted)).toBe(true)
  })

  test('both returns unify into one nullable type', () => {
    expect(a.returnType?.type).toBe('{ status: string; receiptId: string | null }')
  })
})

describe('broken example', () => {
  const a = analyzeFlow(example('broken'))
  const msgs = (id: string) => a.nodes[id].messages.map((m) => `${m.severity}: ${m.message}`)

  test('flags the argument mismatch with a reason', () => {
    expect(msgs('send').join('\n')).toContain('property "to" is optional but required here')
  })

  test('reports the unknown property from the expression', () => {
    const d = a.nodes.label.dry!.diagnostics
    expect(d.some((x) => x.message.includes('"nmae" does not exist'))).toBe(true)
  })

  test('the impossible comparison makes the yes-branch dead', () => {
    expect(a.nodes.imposs.outputs.out.type).toBe('false')
    expect(a.nodes.dead.status).toBe('dead')
    expect(a.nodes['ret-dead'].status).toBe('dead')
    expect(a.nodes.count.status).toBe('live')
    expect(a.edges['e5-in-imposs']).toBeUndefined()
  })

  test('a return in an async branch is an error and is not counted', () => {
    expect(a.nodes.note.async).toBe(true)
    expect(msgs('ret-audit').join('\n')).toContain('async branch')
    expect(a.returns.find((r) => r.nodeId === 'ret-audit')?.counted).toBe(false)
  })

  test('incompatible returns are reported on both nodes', () => {
    expect(msgs('ret-count').join('\n')).toContain('not compatible')
    expect(msgs('ret-label').join('\n')).toContain('not compatible')
    expect(a.ok).toBe(false)
  })
})

describe('return unification', () => {
  test('identical, subtype and nullable types combine', () => {
    expect(combineReturns(STR, STR)).toEqual(STR)
    expect(show(combineReturns(INT, NUM)!)).toBe('number')
    expect(show(combineReturns(STR, NULL)!)).toBe('string | null')
    expect(show(combineReturns(STR, UNDEF)!)).toBe('string | undefined')
  })
  test('objects merge property-wise', () => {
    const a = obj({ id: STR, note: STR })
    const b = obj({ id: STR, note: NULL })
    expect(show(combineReturns(a, b)!)).toBe('{ id: string; note: string | null }')
    const c = obj({ id: STR, extra: BOOL })
    expect(show(combineReturns(a, c)!)).toBe('{ id: string; note?: string; extra?: boolean }')
  })
  test('unrelated primitives conflict', () => {
    expect(combineReturns(STR, NUM)).toBeNull()
    expect(combineReturns(arr(STR), arr(NUM))).toBeNull()
    expect(combineReturns(obj({ a: STR }), obj({ a: NUM }))).toBeNull()
  })
  test('unions of conflicting types stay conflicting', () => {
    expect(combineReturns(union(STR, NULL), NUM)).toBeNull()
  })
})

describe('typebox bridge', () => {
  test('evaluates expressions to JSON Schema', () => {
    const r = evalTypeBox('t.Object({ name: t.String(), age: t.Optional(t.Integer()) })')
    expect(r).toEqual({
      ok: true,
      schema: {
        type: 'object',
        properties: { name: { type: 'string' }, age: { type: 'integer' } },
        required: ['name'],
      },
    })
  })
  test('accepts function bodies and imports', () => {
    const r = evalTypeBox(`import { Type as t } from '@sinclair/typebox'\nconst X = t.String();\nreturn t.Array(X)`)
    expect(r).toEqual({ ok: true, schema: { type: 'array', items: { type: 'string' } } })
  })
  test('reports errors instead of throwing', () => {
    expect(evalTypeBox('t.Nope()').ok).toBe(false)
    expect(evalTypeBox('').ok).toBe(false)
  })
  test('the broken example input matches its typebox source', () => {
    const doc = example('broken')
    const spec = (doc.nodes.find((n) => n.type === 'input') as { data: { spec: { typebox: string; schema: unknown } } }).data.spec
    const r = evalTypeBox(spec.typebox)
    expect(r.ok && r.schema).toEqual(spec.schema as never)
  })
  test('schema -> typebox -> schema round trips', () => {
    const schema = {
      type: 'object',
      required: ['a'],
      properties: {
        a: { type: 'string' },
        b: { type: 'array', items: { type: 'integer' } },
        c: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        d: { enum: ['x', 'y'] },
        e: { $ref: 'Other' },
        f: { type: 'object', required: ['z'], properties: { z: { type: 'boolean' } } },
      },
    }
    const code = schemaToTypeBox(schema)
    const r = evalTypeBox(code)
    expect(r.ok && r.schema).toEqual({
      ...schema,
      properties: { ...schema.properties, d: { anyOf: [{ const: 'x', type: 'string' }, { const: 'y', type: 'string' }] } },
    } as never)
  })
})

import type { FlowDoc, FlowEdge, FlowNode, SchemaSpec } from '../src/flow/model'
import type { JSONSchema } from '../src/dry'

const spec = (schema: JSONSchema): SchemaSpec => ({ schema, mode: 'json' })
let k = 0
const e = (source: string, sourceHandle: string, target: string, targetHandle: string): FlowEdge => ({
  id: `x${++k}`,
  source,
  sourceHandle,
  target,
  targetHandle,
})
const doc = (nodes: FlowNode[], edges: FlowEdge[], extra: Partial<FlowDoc> = {}): FlowDoc => ({
  nodes,
  edges,
  types: [],
  functions: [],
  ...extra,
})
const at = { x: 0, y: 0 }
const input = (schema: JSONSchema): FlowNode => ({ id: 'in', type: 'input', position: at, data: { spec: spec(schema) } })
const xf = (id: string, expression: string, variables: string[] = []): FlowNode => ({
  id,
  type: 'transform',
  position: at,
  data: { expression, variables },
})
const ret = (id: string): FlowNode => ({ id, type: 'return', position: at, data: {} })

describe('loops', () => {
  const numbers: JSONSchema = { type: 'object', required: ['xs'], properties: { xs: { type: 'array', items: { type: 'number' } } } }

  test('reduce: accumulator type comes from the initial value, result is the accumulator', () => {
    const a = analyzeFlow(
      doc(
        [
          input(numbers),
          xf('xs', 'xs'),
          xf('zero', '0'),
          { id: 'loop', type: 'loop', position: at, data: { mode: 'reduce' } },
          xf('sum', '$acc + $item', ['acc', 'item']),
          ret('r'),
        ],
        [
          e('in', 'out', 'xs', 'in'),
          e('in', 'out', 'zero', 'in'),
          e('xs', 'out', 'loop', 'in'),
          e('zero', 'out', 'loop', 'initial'),
          e('loop', 'each', 'sum', 'trigger'),
          e('in', 'out', 'sum', 'in'),
          e('loop', 'acc', 'sum', 'var:acc'),
          e('loop', 'item', 'sum', 'var:item'),
          e('sum', 'out', 'loop', 'collect'),
          e('loop', 'results', 'r', 'in'),
          e('loop', 'done', 'r', 'trigger'),
        ],
      ),
    )
    expect(a.messages.filter((m) => m.severity !== 'info')).toEqual([])
    expect(a.nodes.loop.outputs.acc.type).toBe('number')
    expect(a.returnType?.type).toBe('number')
  })

  test('reduce: a next accumulator of the wrong type is an error', () => {
    const a = analyzeFlow(
      doc(
        [
          input(numbers),
          xf('xs', 'xs'),
          xf('zero', '0'),
          { id: 'loop', type: 'loop', position: at, data: { mode: 'reduce' } },
          xf('bad', '"oops"'),
        ],
        [
          e('in', 'out', 'xs', 'in'),
          e('in', 'out', 'zero', 'in'),
          e('xs', 'out', 'loop', 'in'),
          e('zero', 'out', 'loop', 'initial'),
          e('loop', 'each', 'bad', 'trigger'),
          e('in', 'out', 'bad', 'in'),
          e('bad', 'out', 'loop', 'collect'),
        ],
      ),
    )
    expect(a.nodes.loop.messages.map((m) => m.message).join()).toContain('does not match the accumulator type')
  })

  test('map: results is an array of the collected type', () => {
    const a = analyzeFlow(
      doc(
        [
          input(numbers),
          xf('xs', 'xs'),
          { id: 'loop', type: 'loop', position: at, data: { mode: 'map' } },
          xf('dbl', '$item * 2', ['item']),
        ],
        [
          e('in', 'out', 'xs', 'in'),
          e('xs', 'out', 'loop', 'in'),
          e('loop', 'each', 'dbl', 'trigger'),
          e('in', 'out', 'dbl', 'in'),
          e('loop', 'item', 'dbl', 'var:item'),
          e('dbl', 'out', 'loop', 'collect'),
        ],
      ),
    )
    expect(a.nodes.loop.outputs.results.type).toBe('number[]')
    expect(a.nodes.loop.outputs.item.type).toBe('number')
  })

  test('looping over a non-array is an error', () => {
    const a = analyzeFlow(
      doc(
        [input({ type: 'object', properties: {} }), { id: 'loop', type: 'loop', position: at, data: { mode: 'map' } }],
        [e('in', 'out', 'loop', 'in')],
      ),
    )
    expect(a.nodes.loop.messages[0].message).toContain('iterates over an array')
  })
})

describe('branches and gates', () => {
  const user: JSONSchema = { type: 'object', required: ['age'], properties: { age: { type: 'integer' } } }

  test('a branch needs a boolean', () => {
    const a = analyzeFlow(
      doc(
        [input(user), xf('age', 'age'), { id: 'b', type: 'branch', position: at, data: {} }],
        [e('in', 'out', 'age', 'in'), e('age', 'out', 'b', 'in')],
      ),
    )
    expect(a.nodes.b.messages[0].message).toContain('needs a boolean')
  })

  test('conditions must produce booleans (truthiness needs an explicit $boolean)', () => {
    const bad = analyzeFlow(
      doc(
        [input(user), { id: 'c', type: 'condition', position: at, data: { expression: 'age', variables: [] } }],
        [e('in', 'out', 'c', 'in')],
      ),
    )
    expect(bad.nodes.c.messages[0].message).toContain('must produce a boolean')
    const good = analyzeFlow(
      doc(
        [input(user), { id: 'c', type: 'condition', position: at, data: { expression: '$boolean(age)', variables: [] } }],
        [e('in', 'out', 'c', 'in')],
      ),
    )
    expect(good.nodes.c.messages.filter((m) => m.severity === 'error')).toEqual([])
  })

  test('a lazy node behind a dead gate is dead, and so is everything that needs its data', () => {
    const a = analyzeFlow(
      doc(
        [
          input(user),
          { id: 'c', type: 'condition', position: at, data: { expression: 'true', variables: [] } },
          { id: 'b', type: 'branch', position: at, data: {} },
          xf('only-if-false', '"x"'),
          xf('downstream', '$', []),
          ret('r'),
        ],
        [
          e('in', 'out', 'c', 'in'),
          e('c', 'out', 'b', 'in'),
          e('b', 'no', 'only-if-false', 'trigger'),
          e('in', 'out', 'only-if-false', 'in'),
          e('only-if-false', 'out', 'downstream', 'in'),
          e('downstream', 'out', 'r', 'in'),
        ],
      ),
    )
    expect(a.nodes['only-if-false'].status).toBe('dead')
    expect(a.nodes.downstream.status).toBe('dead')
    expect(a.nodes.r.status).toBe('dead')
    expect(a.returnType).toBeNull()
  })

  test('nodes not connected to the input are unreachable', () => {
    const a = analyzeFlow(doc([input(user), xf('floating', '1')], []))
    expect(a.nodes.floating.status).toBe('unreachable')
  })

  test('an async call detaches its result but not its done gate', () => {
    const fn = { id: 'f', name: 'f', input: spec({}), output: spec({ type: 'string' }) }
    const a = analyzeFlow(
      doc(
        [
          input(user),
          { id: 'c', type: 'call', position: at, data: { fnId: 'f', async: true } },
          xf('after', '"after"'),
          xf('uses', '$'),
          ret('r1'),
          ret('r2'),
        ],
        [
          e('in', 'out', 'c', 'arg'),
          e('c', 'done', 'after', 'trigger'),
          e('in', 'out', 'after', 'in'),
          e('after', 'out', 'r1', 'in'),
          e('c', 'out', 'uses', 'in'),
          e('uses', 'out', 'r2', 'in'),
        ],
        { functions: [fn] },
      ),
    )
    expect(a.nodes.after.async).toBe(false)
    expect(a.nodes.uses.async).toBe(true)
    expect(a.returns.find((r) => r.nodeId === 'r1')?.counted).toBe(true)
    expect(a.returns.find((r) => r.nodeId === 'r2')?.counted).toBe(false)
  })

  test('a cycle is reported instead of hanging', () => {
    const a = analyzeFlow(
      doc(
        [input(user), xf('a', '$', ['v']), xf('b', '$')],
        [e('in', 'out', 'a', 'in'), e('b', 'out', 'a', 'var:v'), e('a', 'out', 'b', 'in')],
      ),
    )
    expect(a.ok).toBe(false)
  })
})
