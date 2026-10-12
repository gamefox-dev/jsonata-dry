import { describe, expect, test } from 'bun:test'
import { dryRun, type JSONSchema } from '../src/dry'

const schema: JSONSchema = {
  type: 'object',
  required: ['id', 'customer', 'items'],
  properties: {
    id: { type: 'string' },
    customer: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' }, email: { type: 'string' }, age: { type: 'integer' } },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['sku', 'qty', 'price'],
        properties: { sku: { type: 'string' }, qty: { type: 'integer' }, price: { type: 'number' } },
      },
    },
    coupon: { type: ['string', 'null'] },
  },
}
const t = (e: string) => dryRun(e, schema).type
const LINE = '{ sku: string; qty: integer; price: number }'

describe('inferred types are precise, not just sound', () => {
  const cases: [string, string][] = [
    ['id', 'string'],
    ['customer', '{ name: string; email?: string; age?: integer }'],
    ['customer.name', 'string'],
    ['customer.email', 'string | undefined'],
    ['items', `${LINE}[]`],
    ['items[0]', `${LINE} | undefined`],
    ['items.sku', 'string | string[] | undefined'],
    ['items.sku[]', 'string[] | undefined'],
    ['$count(items)', 'integer'],
    ['$exists(customer.email)', 'boolean'],
    ['customer.email ?? "none"', 'string'],
    ['$sum(items.(price * qty)) ?? 0', 'number'],
    ['coupon ? coupon : "none"', 'string'],
    ['coupon', 'string | null | undefined'],
    ['1 + 2', '3'],
    ['"a" & "b"', '"ab"'],
    ['{ "ok": true, "n": 1, "tags": ["a"] }', '{ ok: boolean; n: integer; tags: string[] }'],
    ['[1, 2, 3]', 'integer[]'],
    ['id = "x"', 'boolean'],
    ['customer.age > 18', 'boolean | undefined'],
    ['$uppercase(id)', 'string'],
    ['$uppercase(customer.email)', 'string | undefined'],
    ['customer.age ? "adult" : "minor"', '"adult" | "minor"'],
    ['$type(id)', '"string"'],
    ['$$.id', 'string'],
  ]
  for (const [expr, want] of cases) {
    test(expr, () => expect(t(expr)).toBe(want))
  }
})

describe('diagnostics', () => {
  const diag = (e: string) => dryRun(e, schema).diagnostics.map((d) => `${d.severity}: ${d.message}`)
  test('unknown property', () => {
    expect(diag('customer.nmae')[0]).toContain('Property "nmae" does not exist')
  })
  test('wrong operand type is an error', () => {
    expect(diag('id + 1')[0]).toContain('error: Operator "+" expects a number')
  })
  test('wrong argument type is an error with the builtin name', () => {
    expect(diag('$uppercase(items.qty)')[0]).toContain('Argument 1 of $uppercase()')
  })
  test('comparing different types is reported', () => {
    expect(diag('id = 5').join()).toContain('always false')
  })
  test('unknown function', () => {
    expect(diag('$nope(1)')[0]).toContain('Unknown function $nope()')
  })
  test('syntax errors carry a position', () => {
    const r = dryRun('id +', schema)
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0].start).toBeDefined()
  })
  test('dead conditional branch is flagged', () => {
    expect(diag('1 > 2 ? "a" : "b"').join()).toContain('always false')
  })
  test('ranges point at the offending token', () => {
    const r = dryRun('customer.nmae', schema)
    expect('customer.nmae'.slice(r.diagnostics[0].start, r.diagnostics[0].end)).toBe('nmae')
  })
})

describe('schemas out', () => {
  test('produces a JSON Schema for the result', () => {
    const r = dryRun('{ "name": customer.name, "email": customer.email, "n": $count(items) }', schema)
    expect(r.schema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        n: { type: 'integer' },
      },
      required: ['name', 'n'],
      additionalProperties: false,
    })
    expect(r.optional).toBe(false)
  })
  test('reports optionality separately from the schema', () => {
    const r = dryRun('customer.email', schema)
    expect(r.schema).toEqual({ type: 'string' })
    expect(r.optional).toBe(true)
  })
})
