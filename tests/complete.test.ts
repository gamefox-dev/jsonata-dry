import { describe, expect, test } from 'bun:test'
import { completeAt, hoverAt } from '../src/dry/complete'
import { fromSchema } from '../src/dry/schema'
import { show } from '../src/dry/ty'

const input = fromSchema({
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
  },
})

/** complete at the `|` marker */
const at = (src: string, bindings = {}) => {
  const offset = src.indexOf('|')
  return completeAt(src.replace('|', ''), offset, input, bindings)
}
const fields = (src: string, bindings = {}) =>
  at(src, bindings).items.filter((i) => i.kind === 'field').map((i) => i.name).sort()
const names = (src: string, kind: string) =>
  at(src).items.filter((i) => i.kind === kind).map((i) => i.name)

describe('completion', () => {
  test('root fields at the start of an expression', () => {
    expect(fields('|')).toEqual(['customer', 'id', 'items'])
    expect(fields('i|')).toEqual(['customer', 'id', 'items'])
  })
  test('fields after a dot', () => {
    expect(fields('customer.|')).toEqual(['age', 'email', 'name'])
    expect(fields('customer.na|')).toEqual(['age', 'email', 'name'])
  })
  test('fields through arrays', () => {
    expect(fields('items.|')).toEqual(['price', 'qty', 'sku'])
  })
  test('inside a filter predicate the context is the item', () => {
    expect(fields('items[|')).toEqual(['price', 'qty', 'sku'])
    expect(fields('items[price > 10 and |]')).toEqual(['price', 'qty', 'sku'])
  })
  test('after a filter', () => {
    expect(fields('items[price > 10].|')).toEqual(['price', 'qty', 'sku'])
  })
  test('inside object constructors and function arguments', () => {
    expect(fields('{ "a": customer.|')).toEqual(['age', 'email', 'name'])
    expect(fields('{ "a": 1, |')).toEqual(['customer', 'id', 'items'])
    expect(fields('$sum(items.|')).toEqual(['price', 'qty', 'sku'])
  })
  test('per-item contexts in a mapped step', () => {
    expect(fields('items.(price * |')).toEqual(['price', 'qty', 'sku'])
  })
  test('lambda parameters take the item type from $map', () => {
    expect(fields('$map(items, function($v){ $v.|')).toEqual(['price', 'qty', 'sku'])
  })
  test('variables: bindings, assignments and lambda params', () => {
    const b = { extra: fromSchema({ type: 'object', properties: { z: { type: 'number' } } }) }
    expect(names('($x := 1; $|', 'variable')).toContain('x')
    expect(at('$|', b).items.some((i) => i.kind === 'variable' && i.name === 'extra')).toBe(true)
    expect(fields('$extra.|', b)).toEqual(['z'])
    expect(names('$map(items, function($item){ $| })', 'variable')).toContain('item')
  })
  test('functions come with signature, docs and a snippet', () => {
    const f = at('$su|').items.find((i) => i.name === 'sum')!
    expect(f.detail).toBe('$sum(array)')
    expect(f.insert).toBe('$sum(${1:array})')
    expect(f.doc).toContain('Sum')
    const m = at('$ma|').items.find((i) => i.name === 'map')!
    // `$` and `}` are escaped because this is a Monaco snippet
    expect(m.insert).toBe('$map(${1:array}, ${2:function(\\$v){ \\$v \\}})')
  })
  test('functions are offered without typing the $', () => {
    const f = at('su|').items.find((i) => i.name === 'sum')!
    expect(f.insert).toBe('$sum(${1:array})')
    expect(f.filter).toBe('sum')
  })
  test('no function suggestions after a dot', () => {
    expect(names('customer.|', 'function')).toEqual([])
  })
  test('nothing inside strings or comments', () => {
    expect(at('"abc|').items).toEqual([])
    expect(at('/* x |').items).toEqual([])
  })
  test('field types are shown, optional ones are marked', () => {
    const email = at('customer.|').items.find((i) => i.name === 'email')!
    expect(email.optional).toBe(true)
    expect(email.detail).toBe('string (optional)')
  })
  test('replace range covers the typed word', () => {
    const r = at('customer.na|')
    expect(r.from).toBe('customer.'.length)
    expect(r.to).toBe('customer.na'.length)
  })
})

describe('hover', () => {
  test('shows the type of a field', () => {
    const src = 'customer.email'
    const h = hoverAt(src, src.length - 2, input)!
    expect(h.kind).toBe('field')
    expect(show(h.ty)).toBe('string | undefined')
  })
  test('shows the type of a call', () => {
    const src = '$count(items)'
    const h = hoverAt(src, 2, input)!
    expect(h.kind).toBe('call')
    expect(show(h.ty)).toBe('integer')
  })
})
