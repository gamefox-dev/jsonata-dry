import { describe, expect, test } from 'bun:test'
import { EXAMPLES } from '../src/flow/examples'
import { runFlow } from '../src/flow/run'
import type { FlowDoc } from '../src/flow/model'

const build = (id: string): FlowDoc => (EXAMPLES.find((e) => e.id === id) as (typeof EXAMPLES)[number]).build()

const order = (total: number) => ({
  id: 'o-1',
  customer: { name: 'Ann', email: 'ann@example.com', vip: false },
  items: [
    { sku: 'A', qty: 2, price: total / 2 - 1 },
    { sku: 'B', qty: 1, price: 2 },
  ],
})
// price*qty sums: (total/2-1)*2 + 2 = total

describe('running the order example', () => {
  test('a large order is charged and returns the receipt', async () => {
    const doc = build('order')
    doc.functions.find((f) => f.id === 'fn-charge')!.mock = '{ "ok": true, "receiptId": "R-" & customer }'
    const r = await runFlow(doc, order(500))
    expect(r.status).toBe('returned')
    expect(r.value).toEqual({ status: 'charged', receiptId: 'R-Ann' })
    expect(r.returnedBy).toBe('ret-ok')
    const ran = r.steps.map((s) => s.nodeId)
    expect(ran).toContain('charge')
    expect(ran).toContain('send')
    expect(ran).not.toContain('reserve') // the `no` gate never fired
    expect(ran).not.toContain('ret-q')
  })

  test('the async call does not delay or alter the result', async () => {
    const r = await runFlow(build('order'), order(500))
    const send = r.steps.find((s) => s.nodeId === 'send')!
    expect(send.note).toContain('async')
    // the main flow continued past it through `done`
    expect(r.steps.map((s) => s.nodeId).indexOf('approved')).toBeGreaterThan(
      r.steps.map((s) => s.nodeId).indexOf('send'),
    )
  })

  test('a small order loops over the lines in a fresh scope each time', async () => {
    const r = await runFlow(build('order'), order(40))
    expect(r.status).toBe('returned')
    expect(r.returnedBy).toBe('ret-q')
    const reserves = r.steps.filter((s) => s.nodeId === 'reserve')
    expect(reserves).toHaveLength(2)
    expect(reserves.map((s) => s.scope)).toEqual([[{ loopId: 'each', index: 0 }], [{ loopId: 'each', index: 1 }]])
    expect(reserves[0].inputs.arg).toEqual({ sku: 'A', qty: 2, price: 19 })
    expect(r.steps.find((s) => s.nodeId === 'each')!.outputs.results).toHaveLength(2)
    expect((r.value as { receiptId: unknown }).receiptId).toBeNull()
    expect(r.steps.map((s) => s.nodeId)).not.toContain('charge')
  })

  test('generated mocks follow the declared return type', async () => {
    const r = await runFlow(build('order'), order(500))
    const charge = r.steps.find((s) => s.nodeId === 'charge')!
    expect(charge.note).toContain('generated sample')
    const out = charge.outputs.out as { ok: unknown; receiptId: unknown }
    expect(typeof out.ok).toBe('boolean')
    expect(typeof out.receiptId).toBe('string')
  })
})

describe('failures and edge cases', () => {
  test('a runtime error stops the run and names the node', async () => {
    const doc = build('order')
    const summary = doc.nodes.find((n) => n.id === 'summary')!
    if (summary.type === 'transform') summary.data.expression = '$number("not a number")'
    const r = await runFlow(doc, order(100))
    expect(r.status).toBe('failed')
    expect(r.error?.nodeId).toBe('summary')
    expect(r.steps.at(-1)!.error).toBeDefined()
  })

  test('returns in async branches are ignored', async () => {
    const doc = build('broken')
    const r = await runFlow(doc, { name: 'Ann', age: 30, tags: ['a'] })
    expect(r.ignoredReturns).toContain('ret-audit')
    expect(r.returnedBy).not.toBe('ret-audit')
  })

  test('dead branches never execute', async () => {
    const doc = build('broken')
    const r = await runFlow(doc, { name: 'Ann', age: 30, tags: ['a', 'b'] })
    const ran = r.steps.map((s) => s.nodeId)
    expect(ran).not.toContain('dead')
    expect(ran).not.toContain('ret-dead')
    expect(ran).toContain('count')
  })

  test('a runaway loop is refused', async () => {
    const doc = build('order')
    const r = await runFlow(doc, { ...order(10), items: Array.from({ length: 5000 }, () => ({ sku: 'x', qty: 1, price: 0.001 })) })
    expect(r.status).toBe('failed')
    expect(r.error?.message).toContain('Refusing')
  })
})
