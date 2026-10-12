import type { JSONSchema } from '../dry'
import type { FlowDoc, FlowEdge, FlowNode, SchemaSpec } from './model'

const json = (schema: JSONSchema): SchemaSpec => ({ schema, mode: 'json' })

let n = 0
const edge = (
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): FlowEdge => ({
  id: `e${++n}-${source}-${target}`,
  source,
  sourceHandle,
  target,
  targetHandle,
})

/* ------------------------------------------------------------------ */
/*  1. A realistic, clean flow                                         */
/* ------------------------------------------------------------------ */

const orderFlow = (): FlowDoc => {
  const nodes: FlowNode[] = [
    { id: 'in', type: 'input', position: { x: 0, y: 200 }, data: { label: 'Order', spec: json({ $ref: 'Order' }) } },
    {
      id: 'summary',
      type: 'transform',
      position: { x: 330, y: 200 },
      data: {
        label: 'summary',
        variables: [],
        expression:
          '{\n  "orderId": id,\n  "customer": customer.name,\n  "email": customer.email,\n  "total": $sum(items.(price * qty)) ?? 0\n}',
      },
    },
    {
      id: 'large',
      type: 'condition',
      position: { x: 660, y: 200 },
      data: { label: 'large order?', variables: [], expression: 'total > 100' },
    },
    { id: 'gate', type: 'branch', position: { x: 990, y: 200 }, data: { label: 'large?' } },

    // approved path
    {
      id: 'payment',
      type: 'transform',
      position: { x: 660, y: -170 },
      data: { label: 'payment', variables: [], expression: '{ "amount": total, "customer": customer }' },
    },
    { id: 'charge', type: 'call', position: { x: 990, y: -170 }, data: { label: 'charge', fnId: 'fn-charge', async: false } },
    {
      id: 'mail',
      type: 'transform',
      position: { x: 1320, y: -290 },
      data: {
        label: 'receipt mail',
        variables: ['receipt'],
        expression: '{ "to": email ?? "orders@example.com", "subject": "Receipt " & $receipt.receiptId }',
      },
    },
    { id: 'send', type: 'call', position: { x: 1650, y: -290 }, data: { label: 'send (fire & forget)', fnId: 'fn-email', async: true } },
    {
      id: 'approved',
      type: 'transform',
      position: { x: 1320, y: -30 },
      data: {
        label: 'approved',
        variables: ['receipt'],
        expression: '{ "status": "charged", "receiptId": $receipt.receiptId }',
      },
    },
    { id: 'ret-ok', type: 'return', position: { x: 1650, y: -30 }, data: { label: 'return charged' } },

    // small-order path
    {
      id: 'lines',
      type: 'transform',
      position: { x: 660, y: 470 },
      data: { label: 'line items', variables: [], expression: 'items' },
    },
    { id: 'each', type: 'loop', position: { x: 990, y: 430 }, data: { label: 'reserve each line', mode: 'map' } },
    { id: 'reserve', type: 'call', position: { x: 1330, y: 470 }, data: { label: 'reserve', fnId: 'fn-reserve', async: false } },
    {
      id: 'queued',
      type: 'transform',
      position: { x: 1330, y: 700 },
      data: {
        label: 'queued',
        variables: [],
        expression:
          '{\n  "status": $count($[reserved = false]) > 0 ? "backorder" : "queued",\n  "receiptId": null\n}',
      },
    },
    { id: 'ret-q', type: 'return', position: { x: 1660, y: 700 }, data: { label: 'return queued' } },
  ]
  const edges: FlowEdge[] = [
    edge('in', 'out', 'summary', 'in'),
    edge('summary', 'out', 'large', 'in'),
    edge('large', 'out', 'gate', 'in'),
    // yes
    edge('summary', 'out', 'payment', 'in'),
    edge('gate', 'yes', 'charge', 'trigger'),
    edge('payment', 'out', 'charge', 'arg'),
    edge('summary', 'out', 'mail', 'in'),
    edge('charge', 'out', 'mail', 'var:receipt'),
    edge('charge', 'done', 'send', 'trigger'),
    edge('mail', 'out', 'send', 'arg'),
    edge('send', 'done', 'approved', 'trigger'),
    edge('summary', 'out', 'approved', 'in'),
    edge('charge', 'out', 'approved', 'var:receipt'),
    edge('approved', 'out', 'ret-ok', 'in'),
    // no
    edge('in', 'out', 'lines', 'in'),
    edge('gate', 'no', 'each', 'trigger'),
    edge('lines', 'out', 'each', 'in'),
    edge('each', 'each', 'reserve', 'trigger'),
    edge('each', 'item', 'reserve', 'arg'),
    edge('reserve', 'out', 'each', 'collect'),
    edge('each', 'done', 'queued', 'trigger'),
    edge('each', 'results', 'queued', 'in'),
    edge('queued', 'out', 'ret-q', 'in'),
  ]

  const customer: JSONSchema = {
    type: 'object',
    required: ['name', 'vip'],
    properties: {
      name: { type: 'string' },
      email: { type: 'string' },
      vip: { type: 'boolean' },
    },
  }
  return {
    nodes,
    edges,
    types: [
      { id: 't-customer', name: 'Customer', spec: json(customer) },
      {
        id: 't-line',
        name: 'LineItem',
        spec: json({
          type: 'object',
          required: ['sku', 'qty', 'price'],
          properties: { sku: { type: 'string' }, qty: { type: 'integer' }, price: { type: 'number' } },
        }),
      },
      {
        id: 't-order',
        name: 'Order',
        spec: json({
          type: 'object',
          required: ['id', 'customer', 'items'],
          properties: {
            id: { type: 'string' },
            customer: { $ref: 'Customer' },
            items: { type: 'array', items: { $ref: 'LineItem' } },
            coupon: { type: 'string' },
          },
        }),
      },
    ],
    functions: [
      {
        id: 'fn-charge',
        name: 'chargeCard',
        description: 'Charge the customer and return a receipt',
        input: json({
          type: 'object',
          required: ['amount', 'customer'],
          properties: { amount: { type: 'number' }, customer: { type: 'string' } },
        }),
        output: json({
          type: 'object',
          required: ['ok', 'receiptId'],
          properties: { ok: { type: 'boolean' }, receiptId: { type: 'string' } },
        }),
      },
      {
        id: 'fn-email',
        name: 'sendEmail',
        input: json({
          type: 'object',
          required: ['to', 'subject'],
          properties: { to: { type: 'string' }, subject: { type: 'string' } },
        }),
        output: json({ type: 'object', required: ['queued'], properties: { queued: { type: 'boolean' } } }),
      },
      {
        id: 'fn-reserve',
        name: 'reserveStock',
        input: json({
          type: 'object',
          required: ['sku', 'qty'],
          properties: { sku: { type: 'string' }, qty: { type: 'integer' } },
        }),
        output: json({ type: 'object', required: ['reserved'], properties: { reserved: { type: 'boolean' } } }),
      },
    ],
  }
}

/* ------------------------------------------------------------------ */
/*  2. A flow that is wrong on purpose                                 */
/* ------------------------------------------------------------------ */

const brokenFlow = (): FlowDoc => {
  const nodes: FlowNode[] = [
    {
      id: 'in',
      type: 'input',
      position: { x: 0, y: 240 },
      data: {
        label: 'User',
        spec: {
          mode: 'typebox',
          typebox:
            't.Object({\n  name: t.String(),\n  age: t.Integer(),\n  email: t.Optional(t.String()),\n  tags: t.Array(t.String()),\n})',
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              age: { type: 'integer' },
              email: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'age', 'tags'],
          },
        },
      },
    },
    {
      id: 'mail',
      type: 'transform',
      position: { x: 330, y: -40 },
      data: { label: 'mail', variables: [], expression: '{ "to": email, "subject": "Hi " & name }' },
    },
    { id: 'send', type: 'call', position: { x: 660, y: -40 }, data: { label: 'send', fnId: 'fn-email', async: false } },
    { id: 'audit', type: 'call', position: { x: 990, y: -40 }, data: { label: 'audit (async)', fnId: 'fn-audit', async: true } },
    {
      id: 'note',
      type: 'transform',
      position: { x: 1320, y: -40 },
      data: { label: 'audit note', variables: [], expression: '"audited: " & $string(ok)' },
    },
    { id: 'ret-audit', type: 'return', position: { x: 1650, y: -40 }, data: { label: 'return note' } },

    {
      id: 'imposs',
      type: 'condition',
      position: { x: 330, y: 300 },
      data: { label: 'name is a number?', variables: [], expression: '$type(name) = "number"' },
    },
    { id: 'gate', type: 'branch', position: { x: 660, y: 300 }, data: { label: 'check' } },
    {
      id: 'dead',
      type: 'transform',
      position: { x: 990, y: 230 },
      data: { label: 'never runs', variables: [], expression: '"unreachable"' },
    },
    { id: 'ret-dead', type: 'return', position: { x: 1320, y: 230 }, data: { label: 'return (dead)' } },
    {
      id: 'count',
      type: 'transform',
      position: { x: 990, y: 400 },
      data: { label: 'tag count', variables: [], expression: '$count(tags)' },
    },
    { id: 'ret-count', type: 'return', position: { x: 1320, y: 400 }, data: { label: 'return count' } },

    {
      id: 'label',
      type: 'transform',
      position: { x: 330, y: 560 },
      data: { label: 'label', variables: [], expression: 'nmae ?? name' },
    },
    { id: 'ret-label', type: 'return', position: { x: 660, y: 560 }, data: { label: 'return label' } },
  ]
  const edges: FlowEdge[] = [
    edge('in', 'out', 'mail', 'in'),
    edge('mail', 'out', 'send', 'arg'),
    edge('send', 'done', 'audit', 'trigger'),
    edge('send', 'out', 'audit', 'arg'),
    edge('audit', 'out', 'note', 'in'),
    edge('note', 'out', 'ret-audit', 'in'),

    edge('in', 'out', 'imposs', 'in'),
    edge('imposs', 'out', 'gate', 'in'),
    edge('gate', 'yes', 'dead', 'trigger'),
    edge('in', 'out', 'dead', 'in'),
    edge('dead', 'out', 'ret-dead', 'in'),
    edge('gate', 'no', 'count', 'trigger'),
    edge('in', 'out', 'count', 'in'),
    edge('count', 'out', 'ret-count', 'in'),

    edge('in', 'out', 'label', 'in'),
    edge('label', 'out', 'ret-label', 'in'),
  ]
  return {
    nodes,
    edges,
    types: [],
    functions: [
      {
        id: 'fn-email',
        name: 'sendEmail',
        input: json({
          type: 'object',
          required: ['to', 'subject'],
          properties: { to: { type: 'string' }, subject: { type: 'string' } },
        }),
        output: json({ type: 'object', required: ['queued'], properties: { queued: { type: 'boolean' } } }),
      },
      {
        id: 'fn-audit',
        name: 'audit',
        input: json({ type: 'object', required: ['queued'], properties: { queued: { type: 'boolean' } } }),
        output: json({ type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }),
      },
    ],
  }
}

export interface Example {
  id: string
  title: string
  description: string
  build: () => FlowDoc
}

export const EXAMPLES: Example[] = [
  {
    id: 'order',
    title: 'Order checkout (clean)',
    description:
      'Branches on order size, charges a card, fires an async email, or loops over lines to reserve stock. Both returns unify to one nullable type.',
    build: orderFlow,
  },
  {
    id: 'broken',
    title: 'Needs attention (every diagnostic)',
    description:
      'An argument type mismatch, an unknown property, a dead branch, an async return and incompatible return types.',
    build: brokenFlow,
  },
]
