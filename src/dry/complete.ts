import { BUILTINS, BUILTIN_DOCS } from './builtins.ts'
import { dryRunTy, type Probe } from './infer.ts'
import { ANY, hasUndef, members, removeUndef, show, union, type Ty } from './ty.ts'

/**
 * Context-aware completion for JSONata, driven by the dry-run engine.
 *
 * The text before the cursor is made parseable (the word under the cursor becomes a placeholder
 * identifier and open brackets are closed), dry-run against the real input type, and the inferer
 * reports which type the placeholder was looked up on. That is what makes `items[`, `items.`
 * and `function($v){ $v.` all work, including inside nested filters and lambdas.
 */

export interface Completion {
  kind: 'field' | 'variable' | 'function' | 'keyword'
  /** display name (variables and functions without the `$`) */
  name: string
  /** text to insert; a snippet for functions */
  insert: string
  detail?: string
  doc?: string
  optional?: boolean
  /** lets the editor match what the user typed against `name` even though `insert` starts with `$` */
  filter?: string
  /** lower sorts first */
  rank: number
  /** field / variable type */
  ty?: Ty
  snippet?: boolean
}

export interface CompletionResult {
  items: Completion[]
  /** replace [from, to) with the chosen item */
  from: number
  to: number
}

const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** bracket stack at the end of `text`, or null when it ends inside a string / comment */
function scan(text: string): string[] | null {
  const stack: string[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) return null
      i = end + 1
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      if (j >= text.length) return null
      i = j
    } else if (c in CLOSERS) stack.push(c)
    else if (c === ')' || c === ']' || c === '}') stack.pop()
  }
  return stack
}

function fieldsOf(ty: Ty): Map<string, { ty: Ty; req: boolean }> {
  const out = new Map<string, { ty: Ty; req: boolean }>()
  let objects = 0
  const seenReq = new Map<string, number>()
  const visit = (t: Ty, depth: number) => {
    for (const m of members(t)) {
      if (m.k === 'arr') {
        if (depth < 4) visit(m.item, depth + 1)
      } else if (m.k === 'obj') {
        objects++
        for (const [k, v] of Object.entries(m.props)) {
          const prev = out.get(k)
          out.set(k, { ty: prev ? union(prev.ty, v) : v, req: true })
          if (m.req.includes(k)) seenReq.set(k, (seenReq.get(k) ?? 0) + 1)
        }
      }
    }
  }
  visit(ty, 0)
  for (const [k, v] of out) v.req = (seenReq.get(k) ?? 0) === objects
  return out
}

function functionSnippet(name: string): string {
  const args = BUILTIN_DOCS[name]?.args ?? ''
  const required = args
    .split('[')[0]
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
  if (required.length === 0) return `$${name}()`
  const parts = required.map((a, i) => {
    const label = a === 'function' ? 'function($v){ $v }' : a
    return '${' + (i + 1) + ':' + label.replace(/[\\$}]/g, '\\$&') + '}'
  })
  return `$${name}(${parts.join(', ')})`
}

const KEYWORDS = ['true', 'false', 'null', 'and', 'or', 'in', 'function']

export function completeAt(
  expression: string,
  offset: number,
  input: Ty | null,
  bindings: Record<string, Ty> = {},
): CompletionResult {
  const prefix = expression.slice(0, offset)
  const empty: CompletionResult = { items: [], from: offset, to: offset }
  const stack = scan(prefix)
  if (stack === null) return empty

  const word = /(\$\$?)?[A-Za-z_]\w*$|\$\$?$/.exec(prefix)?.[0] ?? ''
  const from = offset - word.length
  const isVar = word.startsWith('$')
  const head = prefix.slice(0, from)
  const afterDot = /(^|[^.])\.\s*$/.test(head)
  const placeholder = isVar ? '$__cursor__' : '__cursor__'
  const closers = [...stack].reverse().map((c) => CLOSERS[c]).join('')

  const found: { kind: 'field' | 'variable'; items: Ty; vars: Map<string, Ty> }[] = []
  const probe: Probe = { placeholder, onPlaceholder: (i) => found.push(i) }
  // a key position inside `{ … }` needs `: value` to parse
  const variants = [placeholder, `${placeholder}: 0`, `${placeholder}: 0,`]
  for (const v of variants) {
    found.length = 0
    const r = dryRunTy(head + v + closers, input ?? ANY, { bindings, probe })
    const syntax = r.diagnostics.find((d) => d.severity === 'error' && /^S\d{4}$/.test(d.code ?? ''))
    if (!syntax && found.length) break
  }
  if (found.length === 0) return { ...empty, from, to: offset }

  const items: Completion[] = []
  const names = new Set<string>()

  // fields of whatever the cursor is looking at; `any` only matters when nothing else is known
  if (!isVar) {
    const known = found.filter((f) => f.kind === 'field').map((f) => f.items)
    const typed = known.filter((t) => !members(t).some((m) => m.k === 'any'))
    const merged = union(...(typed.length ? typed : known))
    for (const [name, f] of fieldsOf(merged)) {
      names.add(name)
      items.push({
        kind: 'field',
        name,
        insert: /^[A-Za-z_]\w*$/.test(name) ? name : '`' + name.replace(/`/g, '') + '`',
        detail: show(removeUndef(f.ty)) + (f.req ? '' : ' (optional)'),
        optional: !f.req || hasUndef(f.ty),
        ty: f.ty,
        rank: 0,
      })
    }
  }

  if (!afterDot || isVar) {
    // variables in scope
    const vars = found.find((f) => f.kind === 'variable' || f.kind === 'field')?.vars ?? new Map<string, Ty>()
    if (isVar) {
      const ctx = found.find((f) => f.kind === 'variable')
      items.push(
        { kind: 'variable', name: '', insert: '$', detail: ctx ? show(ctx.items) : 'context', doc: 'The current context item.', rank: 1 },
        { kind: 'variable', name: '$', insert: '$$', detail: 'root', doc: 'The root of the input.', rank: 1 },
      )
    }
    for (const [name, ty] of vars) {
      if (name in BUILTINS && !isVar) continue
      items.push({
        kind: 'variable',
        name,
        insert: '$' + name,
        filter: isVar ? undefined : name,
        detail: show(ty),
        ty,
        rank: 1,
      })
    }
    for (const name of Object.keys(BUILTINS).sort()) {
      const d = BUILTIN_DOCS[name]
      items.push({
        kind: 'function',
        name,
        insert: functionSnippet(name),
        snippet: true,
        filter: isVar ? undefined : name,
        detail: `$${name}(${d?.args ?? ''})`,
        doc: d?.doc,
        rank: 2,
      })
    }
    if (!isVar) {
      for (const k of KEYWORDS) {
        if (!names.has(k)) {
          items.push({
            kind: 'keyword',
            name: k,
            insert: k === 'function' ? 'function($v){ $v }' : k,
            snippet: k === 'function',
            rank: 3,
          })
        }
      }
    }
  }
  return { items, from, to: offset }
}

/** the type under the cursor, for hover */
export function hoverAt(
  expression: string,
  offset: number,
  input: Ty | null,
  bindings: Record<string, Ty> = {},
): { start: number; end: number; ty: Ty; kind: 'field' | 'variable' | 'call'; name?: string } | null {
  type Hit = { start: number; end: number; ty: Ty; kind: 'field' | 'variable' | 'call'; name?: string }
  const hits = new Map<string, Hit>()
  const probe: Probe = {
    onNode: (n) => {
      if (offset < n.start || offset > n.end) return
      const k = `${n.start}:${n.end}:${n.kind}`
      const prev = hits.get(k)
      hits.set(k, prev ? { ...n, ty: union(prev.ty, n.ty) } : n)
    },
  }
  dryRunTy(expression, input ?? ANY, { bindings, probe })
  let best: Hit | null = null
  for (const h of hits.values()) {
    if (!best || h.end - h.start < best.end - best.start) best = h
  }
  return best
}
