import { describe, expect, test } from 'bun:test'
import jsonata from 'jsonata'
import { dryRun } from '../src/dry'
import { fromSchema } from '../src/dry/schema'
import { matches, removeUndef, show } from '../src/dry/ty'
import { rng, sample } from '../src/dry/sample'
import type { JSONSchema } from '../src/dry'

const order: JSONSchema = {
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
        properties: {
          sku: { type: 'string' },
          qty: { type: 'integer' },
          price: { type: 'number' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    coupon: { type: ['string', 'null'] },
    meta: { type: 'object', additionalProperties: { type: 'number' } },
  },
}

const nums: JSONSchema = { type: 'array', items: { type: 'number' } }
const mixed: JSONSchema = {
  type: 'object',
  required: ['v'],
  properties: { v: { anyOf: [{ type: 'string' }, { type: 'number' }] }, w: { enum: ['x', 'y'] } },
}

// expressions that never throw at runtime for generated data
const ORDER_EXPRS = [
  'id', 'customer', 'customer.name', 'customer.email', 'customer.age', 'items', 'items.sku', 'items.price',
  'items[0]', 'items[0].sku', 'items[-1].price', 'items[price > 10]', 'items[price > 10].sku', 'items[qty = 1 and price < 50].sku',
  'items.tags', 'items.tags[0]', 'items[0].tags', 'items.price[]', 'items.sku[]', 'coupon', 'coupon ? coupon : "none"',
  'coupon ?? "none"', 'customer.email ?? "n/a"', 'customer.email ? customer.email : id', '$exists(customer.email)',
  '$count(items)', '$sum(items.price)', '$sum(items.(price * qty))', '$max(items.price)', '$min(items.qty)', '$average(items.price)',
  '$uppercase(id)', '$uppercase(customer.email)', '$lowercase(customer.name)', '$length(id)', '$substring(id, 1, 2)', '$trim(id)',
  '$string(items)', '$string(customer.age)', '$boolean(items)', '$not(coupon)', '$keys(customer)', '$keys(items)', '$lookup(customer, "name")',
  '{ "id": id, "n": $count(items) }', '{ "e": customer.email, "name": customer.name }',
  'items.{ "sku": sku, "line": price * qty }', 'items.{ "sku": sku, "tags": tags }', '[id, customer.name]', '[items.sku, id]', '[[1,2],[3]]',
  'items.sku ~> $join(",")', 'items.sku ~> $count()', '$map(items, function($i){ $i.price * $i.qty })',
  '$map(items, function($i){ $i.sku })', '$filter(items, function($i){ $i.qty > 1 })', '$filter(items, function($i){ $i.qty > 1 }).sku',
  '$reduce(items, function($a, $i){ $a + $i.qty }, 0)', '$sort(items, function($a, $b){ $a.price > $b.price }).sku', 'items^(price).sku', 'items^(>price).sku',
  '$reverse(items.sku)', '$distinct(items.sku)', '$append(items.sku, id)', '$append(id, customer.name)', '$zip(items.sku, items.qty)',
  'items{sku: $sum(qty)}', 'items{sku: price}', '$spread(customer)', '$merge([customer, { "x": 1 }])', '$each(customer, function($v, $k){ $k })',
  'items.qty + 1', 'customer.age + 1', 'customer.age > 18', 'customer.age >= 18 and $exists(customer.email)', 'id = "a"', 'id != "a"', 'customer.age = 5',
  '1 + 2', '1 > 2', '1 > 2 ? "a" : 1', 'true and false', '"a" & "b"', 'id & customer.age', '-customer.age', '[1..5]', '[1..$count(items)]',
  '($x := items.price; $sum($x))', '($f := function($n){ $n * 2 }; $f(customer.age))', 'items.($i := qty; $i * 2)',
  'items@$i.sku', 'items#$n.sku', 'items#$n.{ "n": $n, "sku": sku }', 'items.%.id', '$$.id', '$.id', 'items.$$.id',
  '*', 'customer.*', 'items.*', '**.sku', 'meta', 'meta.foo', 'meta.*', '$type(id)', '$type(customer)', '$type(items)',
  '$match(id, /a/)', '$contains(id, "a")', '$split(id, ",")', '$replace(id, "a", "b")', '$pad(id, 5)', '$number(customer.age)',
  '$floor(customer.age)', '$round(items[0].price)', '$abs(customer.age)', '$power(customer.age, 2)',
  'customer.age ? "adult" : "minor"', 'items ? $count(items) : 0', '$exists(items[0]) ? items[0].sku : "none"',
]

const NUM_EXPRS = ['$', '$[0]', '$sum($)', '$count($)', '$max($)', '$[$ > 2]', '$ ~> $sum()', '$map($, function($v){ $v * 2 })', '$.[$ + 1]', '$reduce($, function($a,$b){ $a + $b })', '$sort($)', '$reverse($)', '$distinct($)', '$[0] + $[1]', '$count($[$ > 1])', '$average($)']
const MIXED_EXPRS = ['v', 'w', 'v = "a"', 'v & "x"', '$string(v)', '$type(v)', 'w = "x" ? 1 : 2', '$exists(w)', '{ "v": v }', '[v, w]']

async function check(schema: JSONSchema, exprs: string[], seeds = 40) {
  const ty = fromSchema(schema)
  const failures: string[] = []
  for (const expr of exprs) {
    const res = dryRun(expr, schema)
    if (res.diagnostics.some((d) => d.severity === 'error' && d.code === undefined && d.message.startsWith('Syntax')))
      failures.push(`${expr}: parse error ${res.diagnostics[0].message}`)
    const rt = removeUndef(res.ty)
    for (let s = 1; s <= seeds; s++) {
      const input = sample(ty, rng(s * 7919))
      let out: unknown
      try {
        out = await jsonata(expr).evaluate(input)
      } catch (e) {
        // a runtime error must have been foreseen as an error or warning
        const foreseen = res.diagnostics.some((d) => d.severity !== 'info')
        if (!foreseen) failures.push(`${expr}: runtime error "${(e as Error).message}" not foreseen (input ${JSON.stringify(input)})`)
        break
      }
      if (out === undefined) {
        if (!res.optional) {
          failures.push(`${expr}: returned undefined but inferred ${show(res.ty)}  (input ${JSON.stringify(input)})`)
          break
        }
      } else if (!matches(JSON.parse(JSON.stringify(out)), rt)) {
        failures.push(`${expr}: result ${JSON.stringify(out)} does not match ${show(res.ty)}  (input ${JSON.stringify(input)})`)
        break
      }
    }
  }
  return failures
}

describe('differential: inferred types vs real JSONata results', () => {
  test('order schema', async () => {
    expect(await check(order, ORDER_EXPRS)).toEqual([])
  })
  test('array of numbers as root', async () => {
    expect(await check(nums, NUM_EXPRS)).toEqual([])
  })
  test('unions and enums', async () => {
    expect(await check(mixed, MIXED_EXPRS)).toEqual([])
  })
})
