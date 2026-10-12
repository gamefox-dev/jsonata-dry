import jsonata from 'jsonata'
import { BUILTINS, type Helpers } from './builtins'
import { fromSchema, toSchema, type JSONSchema } from './schema'
import {
  ANY,
  BOOL,
  INT,
  NEVER,
  NULL,
  NUM,
  STR,
  UNDEF,
  arr,
  assignable,
  bool,
  canBeArray,
  elems,
  fn,
  hasUndef,
  members,
  num,
  obj,
  overlaps,
  removeUndef,
  seq,
  show,
  str,
  union,
  widen,
  type FnTy,
  type Ty,
} from './ty'

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info'
  message: string
  /** character offsets into the expression */
  start?: number
  end?: number
  code?: string
}

export interface DryRunOptions {
  /** named schemas, resolvable through `$ref` */
  defs?: Record<string, JSONSchema>
  /** schemas of variables the host binds, available as `$name` */
  bindings?: Record<string, JSONSchema>
  /** host functions callable as `$name(arg)` */
  functions?: Record<string, { input: JSONSchema; output: JSONSchema }>
}

/** Same as {@link DryRunOptions}, but with values already converted to types. */
export interface TyOptions {
  bindings?: Record<string, Ty>
  functions?: Record<string, { input: Ty; output: Ty }>
}

export interface DryRunResult {
  /** JSON Schema of the value when it is defined */
  schema: JSONSchema
  /** the expression can evaluate to `undefined` (no value) */
  optional: boolean
  /** the expression can only ever evaluate to `undefined` */
  alwaysUndefined: boolean
  /** TypeScript-flavoured rendering of the type */
  type: string
  diagnostics: Diagnostic[]
  /** no errors (warnings are allowed) */
  ok: boolean
  ty: Ty
}

interface Ast {
  type: string
  value?: any
  position?: number
  [k: string]: any
}

class Env {
  readonly vars = new Map<string, Ty>()
  readonly ctx: Ty
  readonly root: Ty
  readonly parent?: Env
  readonly parents: Ty[]
  /** AST keys known to be defined/truthy in this branch */
  readonly narrowed: ReadonlyMap<string, 'def' | 'truthy'>

  constructor(
    ctx: Ty,
    root: Ty,
    parent?: Env,
    parents: Ty[] = [],
    narrowed: ReadonlyMap<string, 'def' | 'truthy'> = new Map(),
  ) {
    this.ctx = ctx
    this.root = root
    this.parent = parent
    this.parents = parents
    this.narrowed = narrowed
  }

  get(name: string): Ty | undefined {
    return this.vars.get(name) ?? this.parent?.get(name)
  }

  child(over: { ctx?: Ty; parents?: Ty[]; narrowed?: ReadonlyMap<string, 'def' | 'truthy'> } = {}) {
    return new Env(
      over.ctx ?? this.ctx,
      this.root,
      this,
      over.parents ?? this.parents,
      over.narrowed ?? this.narrowed,
    )
  }
}

const astKey = (n: Ast) => JSON.stringify(n, (k, v) => (k === 'position' ? undefined : v))
const MAX_STEPS = 60_000
const MAX_DEPTH = 10

class Inferer implements Helpers {
  diags: Diagnostic[] = []
  private seen = new Set<string>()
  private steps = 0
  private depth = 0
  private overBudget = false

  private source: string
  private opts: TyOptions

  constructor(source: string, opts: TyOptions) {
    this.source = source
    this.opts = opts
  }

  /* ---------- diagnostics ---------- */

  private range(n: Ast | undefined): { start?: number; end?: number } {
    if (!n) return {}
    if (n.position === undefined) {
      // composite nodes carry no position: span their children
      const kids: Ast[] =
        n.type === 'path'
          ? n.steps
          : n.type === 'block'
            ? n.expressions
            : [n.lhs, n.rhs, n.expression, n.condition].filter(Boolean)
      const rs = (kids ?? []).map((k) => this.range(k)).filter((r) => r.start !== undefined)
      if (!rs.length) return {}
      return {
        start: Math.min(...rs.map((r) => r.start as number)),
        end: Math.max(...rs.map((r) => r.end as number)),
      }
    }
    const end = n.position
    let len = 1
    switch (n.type) {
      case 'name':
        len = String(n.value).length
        if (this.source.slice(end - len - 2, end) === '`' + n.value + '`') len += 2
        break
      case 'variable':
        len = String(n.value).length + 1
        break
      case 'string':
        len = String(n.value).length + 2
        break
      case 'number':
        len = String(n.value).length
        break
      case 'binary':
      case 'apply':
        len = String(n.value).length
        break
      case 'function':
        if (n.procedure?.position !== undefined) {
          return { start: n.procedure.position - String(n.procedure.value ?? '').length - 1, end: n.procedure.position }
        }
        break
    }
    return { start: Math.max(0, end - len), end }
  }

  report(severity: Diagnostic['severity'], message: string, node?: Ast, code?: string) {
    const r = this.range(node)
    const k = `${severity}|${message}|${r.start}`
    if (this.seen.has(k)) return
    this.seen.add(k)
    this.diags.push({ severity, message, code, ...r })
  }
  error(m: string, n?: Ast, code?: string) {
    this.report('error', m, n, code)
  }
  warn(m: string, n?: Ast, code?: string) {
    this.report('warning', m, n, code)
  }
  info(m: string, n?: Ast, code?: string) {
    this.report('info', m, n, code)
  }

  /* ---------- entry ---------- */

  infer(node: Ast, env: Env): Ty {
    if (++this.steps > MAX_STEPS) {
      if (!this.overBudget) {
        this.overBudget = true
        this.warn('Analysis budget exceeded; the result is approximated as any.')
      }
      return ANY
    }
    let t = this.inferNode(node, env)
    if (node.predicate) {
      for (const p of node.predicate as Ast[]) {
        const f = this.filter(t, p.expr, env, [...env.parents, env.ctx])
        // a filtered sequence of length one is unwrapped to the item itself
        t = union(f, ...members(f).flatMap((m) => (m.k === 'arr' ? [m.item] : [])))
      }
    }
    if (node.type !== 'path' && node.keepArray) t = union(UNDEF, arr(elems(removeUndef(t))))
    if (env.narrowed.size > 0 && node.type !== 'string' && node.type !== 'number') {
      const nar = env.narrowed.get(astKey(node))
      if (nar) {
        t = removeUndef(t)
        if (nar === 'truthy') t = union(...members(t).filter((m) => m.k !== 'null'))
      }
    }
    return t
  }

  private inferNode(n: Ast, env: Env): Ty {
    switch (n.type) {
      case 'string':
        return str(n.value)
      case 'number':
        return num(n.value)
      case 'value':
        return n.value === null ? NULL : bool(n.value)
      case 'regex':
        return fn([STR], union(obj({ match: STR, index: INT, groups: arr(STR) }), UNDEF))
      case 'variable':
        return this.variable(n, env)
      case 'path':
        return this.path(n, env)
      case 'name':
      case 'wildcard':
      case 'descendant':
      case 'parent':
        return this.path({ type: 'path', steps: [n], position: n.position }, env)
      case 'block':
        return this.block(n, env)
      case 'bind':
        return this.bind(n, env)
      case 'binary':
        return this.binary(n, env)
      case 'unary':
        return this.unary(n, env)
      case 'condition':
        return this.condition(n, env)
      case 'function':
        return this.callNode(n, env)
      case 'apply':
        return this.apply(n, env)
      case 'lambda':
        return this.lambda(n, env)
      case 'partial':
        return fn([], ANY)
      case 'transform': {
        const c = env.child({ ctx: ANY })
        if (n.pattern) this.infer(n.pattern, c)
        if (n.update) this.infer(n.update, c)
        if (n.delete) this.infer(n.delete, c)
        return fn([ANY], ANY, { sameAsArg: true })
      }
      case 'sort':
        return env.ctx
      default:
        this.warn(`Unsupported syntax node "${n.type}"; treated as any.`, n)
        return ANY
    }
  }

  /* ---------- variables, blocks, binding ---------- */

  private variable(n: Ast, env: Env): Ty {
    const name: string = n.value
    if (name === '') return env.ctx
    if (name === '$') return env.root
    const local = env.get(name)
    if (local) return local
    const b = this.opts.bindings?.[name]
    if (b !== undefined) return b
    const f = this.opts.functions?.[name]
    if (f) return fn([f.input], f.output, { name })
    const bi = BUILTINS[name]
    if (bi) {
      return fn(
        bi.sig.params.map((p) => p.ty),
        bi.sig.ret,
        { builtin: name, name },
      )
    }
    this.warn(`Variable $${name} is not defined; it evaluates to undefined.`, n, 'undefined-variable')
    return UNDEF
  }

  private block(n: Ast, env: Env): Ty {
    const scope = env.child()
    let last: Ty = UNDEF
    for (const e of n.expressions as Ast[]) last = this.infer(e, scope)
    return last
  }

  private bind(n: Ast, env: Env): Ty {
    const name: string = n.lhs.value
    if (n.rhs.type === 'lambda') {
      // allow recursion: the name is visible inside its own body
      env.vars.set(name, fn([], ANY, { name }))
    }
    const t = this.infer(n.rhs, env)
    env.vars.set(name, t.k === 'fn' && !t.name ? { ...t, name } : t)
    return t
  }

  /* ---------- paths ---------- */

  private path(node: Ast, env: Env): Ty {
    const steps: Ast[] = node.steps
    const first = steps[0]
    const single = first.type === 'variable'
    let items: Ty = single ? env.ctx : elems(env.ctx)
    let multi = !single && canBeArray(env.ctx)
    const trail: Ty[] = [...env.parents, items]
    let penv = env
    let lastRaw: Ty = items
    let lastPlain = false
    let maybeUndef = false

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const last = i === steps.length - 1

      if (step.type === 'sort') {
        for (const term of step.terms as Ast[]) {
          const t = this.infer(term.expression, penv.child({ ctx: items, parents: trail.slice(0, -1) }))
          const bad = members(removeUndef(t)).filter((m) => !['num', 'str', 'any'].includes(m.k))
          if (bad.length) this.error(`Cannot sort by ${show(t)}; sort keys must be numbers or strings.`, term.expression)
        }
        lastRaw = items
        lastPlain = false
        continue
      }
      if (step.type === 'parent') {
        trail.pop()
        items = trail.length ? trail[trail.length - 1] : ANY
        if (!trail.length) trail.push(items)
        lastRaw = items
        lastPlain = false
        continue
      }

      const stepEnv = penv.child({ parents: trail.slice(0, -1) })
      // `a.[x, y]`: constructed arrays are kept whole instead of being flattened
      const cons = step.type === 'unary' && step.value === '['
      let result: Ty
      if (step.type === 'name') {
        result = this.lookupStep(items, step)
      } else {
        result = NEVER
        for (const m of members(items)) {
          result = union(result, this.stepOn(step, m, stepEnv))
        }
        if (members(items).length === 0) result = UNDEF
      }
      // filters / index stages apply per context item, before flattening
      for (const st of (step.stages ?? []) as Ast[]) {
        if (st.type === 'filter') result = this.filter(result, st.expr, penv, trail)
      }
      if (hasUndef(result)) maybeUndef = true
      const raw = result
      if (cons) result = arr(removeUndef(raw))

      const E = removeUndef(elems(result))
      if (step.focus !== undefined || step.index !== undefined) {
        penv = penv.child()
        if (step.index !== undefined) penv.vars.set(step.index, INT)
        if (step.focus !== undefined) {
          penv.vars.set(step.focus, E)
          if (canBeArray(result)) multi = true
          lastRaw = items
          lastPlain = false
          continue
        }
      }
      // an array produced by the *last* step is returned as-is, it does not make the path multi-valued
      if (canBeArray(raw) && !cons && !last) multi = true
      lastRaw = raw
      lastPlain = (step.type === 'name' || cons) && !step.stages?.length
      items = E
      trail.push(E)
    }

    const E = items
    let out: Ty
    if (node.group) {
      out = this.object(node.group.lhs, penv, E, multi || canBeArray(lastRaw))
    } else if (node.keepSingletonArray) {
      out = union(UNDEF, arr(E))
    } else if (multi || (!lastPlain && canBeArray(lastRaw))) {
      out = seq(E)
    } else {
      out = lastRaw
    }
    if (E.k === 'never' && !node.keepSingletonArray && !node.group) return UNDEF
    return maybeUndef && !node.keepSingletonArray && !node.group ? union(out, UNDEF) : out
  }

  /** property lookup over a union of items; reports unknown properties */
  private lookupStep(items: Ty, step: Ast): Ty {
    const name: string = step.value
    const { ty, found } = this.lookup(items, name)
    const real = members(items).filter((m) => m.k !== 'undef' && m.k !== 'never')
    if (!found && real.length > 0) {
      this.warn(`Property "${name}" does not exist on ${show(items)}; this evaluates to undefined.`, step, 'unknown-property')
    }
    return ty
  }

  private lookup(t: Ty, name: string): { ty: Ty; found: boolean } {
    let found = false
    const parts: Ty[] = []
    for (const m of members(t)) {
      switch (m.k) {
        case 'obj':
          if (name in m.props) {
            found = true
            parts.push(m.req.includes(name) ? removeUndef(m.props[name]) : union(m.props[name], UNDEF))
          } else if (m.extra) {
            found = true
            parts.push(union(m.extra, UNDEF))
          } else parts.push(UNDEF)
          break
        case 'arr': {
          const inner = this.lookup(m.item, name)
          if (inner.found) found = true
          parts.push(union(UNDEF, arr(elems(inner.ty))))
          break
        }
        case 'any':
          found = true
          parts.push(ANY)
          break
        case 'undef':
        case 'never':
          found = true
          parts.push(UNDEF)
          break
        default:
          parts.push(UNDEF)
      }
    }
    return { ty: union(...parts), found }
  }

  private stepOn(step: Ast, item: Ty, env: Env): Ty {
    switch (step.type) {
      case 'wildcard': {
        const vals = (m: Ty): Ty =>
          m.k === 'obj' ? union(...Object.values(m.props).map(removeUndef), m.extra || NEVER) : m.k === 'any' ? ANY : NEVER
        const v = union(...members(item).map(vals))
        return v.k === 'never' ? UNDEF : union(UNDEF, arr(elems(v)), v)
      }
      case 'descendant': {
        const out: Ty[] = []
        const walk = (t: Ty, d: number) => {
          for (const m of members(t)) {
            if (m.k === 'arr') walk(m.item, d)
            else {
              out.push(m)
              if (m.k === 'obj' && d < 6) {
                Object.values(m.props).forEach((p) => walk(removeUndef(p), d + 1))
                if (m.extra) walk(m.extra, d + 1)
              }
            }
          }
        }
        walk(item, 0)
        const all = union(...out)
        return all.k === 'never' ? UNDEF : union(UNDEF, arr(all))
      }
      default:
        return this.infer(step, env.child({ ctx: item }))
    }
  }

  private filter(r: Ty, expr: Ast, env: Env, parents: Ty[]): Ty {
    const E = removeUndef(elems(r))
    if (E.k === 'never') return UNDEF
    const p = this.infer(expr, env.child({ ctx: E, parents }))
    const defined = removeUndef(p)
    const ms = members(defined)
    if (ms.length === 0) {
      this.warn('This filter always evaluates to undefined, so nothing matches.', expr, 'dead-filter')
      return UNDEF
    }
    if (ms.every((m) => m.k === 'bool' && m.v === true)) return r
    if (ms.every((m) => m.k === 'bool' && m.v === false)) {
      this.warn('This filter is always false, so nothing matches.', expr, 'dead-filter')
      return UNDEF
    }
    const parts: Ty[] = [UNDEF]
    if (ms.some((m) => m.k === 'num' || m.k === 'any')) parts.push(E)
    if (ms.some((m) => m.k !== 'num')) parts.push(arr(E))
    return union(...parts)
  }

  /* ---------- operators ---------- */

  private binary(n: Ast, env: Env): Ty {
    const op: string = n.value
    const l = this.infer(n.lhs, env)
    const r = this.infer(n.rhs, env)
    const undef = hasUndef(l) || hasUndef(r)
    const lv = removeUndef(l)
    const rv = removeUndef(r)
    const lit = (t: Ty) => (t.k === 'num' || t.k === 'str' || t.k === 'bool') && t.v !== undefined

    switch (op) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%': {
        this.expect(lv, NUM, `Operator "${op}"`, n.lhs, 'number')
        this.expect(rv, NUM, `Operator "${op}"`, n.rhs, 'number')
        if (lv.k === 'num' && rv.k === 'num' && lv.v !== undefined && rv.v !== undefined) {
          const f: Record<string, (a: number, b: number) => number> = {
            '+': (a, b) => a + b,
            '-': (a, b) => a - b,
            '*': (a, b) => a * b,
            '/': (a, b) => a / b,
            '%': (a, b) => a % b,
          }
          const v = f[op](lv.v, rv.v)
          if (Number.isFinite(v)) return num(v)
        }
        const int = lv.k === 'num' && rv.k === 'num' && lv.int && rv.int && op !== '/'
        return union(int ? INT : NUM, undef ? UNDEF : NEVER)
      }
      case '&':
        if (lv.k === 'str' && rv.k === 'str' && lv.v !== undefined && rv.v !== undefined) {
          return str(lv.v + rv.v)
        }
        return STR
      case '=':
      case '!=': {
        if (lit(lv) && lit(rv) && !undef) {
          const eq = (lv as any).k === (rv as any).k && (lv as any).v === (rv as any).v
          return bool(op === '=' ? eq : !eq)
        }
        if (!undef && lv.k !== 'any' && rv.k !== 'any' && !overlaps(lv, rv)) {
          this.warn(
            `Comparing ${show(lv)} with ${show(rv)} is always ${op === '=' ? 'false' : 'true'}.`,
            n,
            'impossible-comparison',
          )
          return bool(op === '!=')
        }
        return BOOL
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const ok = union(NUM, STR)
        this.expect(lv, ok, `Operator "${op}"`, n.lhs, 'number or string')
        this.expect(rv, ok, `Operator "${op}"`, n.rhs, 'number or string')
        const lk = members(lv).map((m) => m.k)
        const rk = members(rv).map((m) => m.k)
        if (lk.length && rk.length && lk.every((k) => k === 'num') && rk.every((k) => k === 'str')) {
          this.error(`Cannot compare ${show(lv)} with ${show(rv)}; both sides must be the same type.`, n, 'T2009')
        } else if (lk.length && rk.length && lk.every((k) => k === 'str') && rk.every((k) => k === 'num')) {
          this.error(`Cannot compare ${show(lv)} with ${show(rv)}; both sides must be the same type.`, n, 'T2009')
        }
        if (lv.k === 'num' && rv.k === 'num' && lv.v !== undefined && rv.v !== undefined && !undef) {
          const f: Record<string, boolean> = {
            '<': lv.v < rv.v,
            '<=': lv.v <= rv.v,
            '>': lv.v > rv.v,
            '>=': lv.v >= rv.v,
          }
          return bool(f[op])
        }
        return union(BOOL, undef ? UNDEF : NEVER)
      }
      case 'and':
      case 'or': {
        const truth = (t: Ty): boolean | undefined => {
          const ms = members(t)
          if (ms.length === 0) return false
          if (ms.length === 1) {
            const m = ms[0]
            if (m.k === 'bool' && m.v !== undefined) return m.v
            if (m.k === 'null') return false
            if (m.k === 'str' && m.v !== undefined) return m.v !== ''
            if (m.k === 'num' && m.v !== undefined) return m.v !== 0
          }
          return undefined
        }
        const a = truth(l)
        const b = truth(r)
        if (op === 'and') {
          if (a === false || b === false) return bool(false)
          if (a === true && b === true) return bool(true)
        } else {
          if (a === true || b === true) return bool(true)
          if (a === false && b === false) return bool(false)
        }
        return BOOL
      }
      case 'in':
        return BOOL
      case '..': {
        this.expect(lv, INT, 'Range operator', n.lhs, 'integer')
        this.expect(rv, INT, 'Range operator', n.rhs, 'integer')
        return union(arr(INT), undef ? UNDEF : NEVER)
      }
      default:
        this.warn(`Unsupported operator "${op}".`, n)
        return ANY
    }
  }

  /** require `t` (already without undefined) to fit `want`, reporting error/warning */
  private expect(t: Ty, want: Ty, what: string, node: Ast, wantName: string) {
    if (t.k === 'never' || assignable(t, want)) return
    if (overlaps(t, want)) {
      this.warn(`${what} expects a ${wantName}, but the operand may be ${show(t)}.`, node, 'maybe-wrong-type')
    } else {
      this.error(`${what} expects a ${wantName}, but the operand is ${show(t)}.`, node, 'wrong-type')
    }
  }

  private unary(n: Ast, env: Env): Ty {
    switch (n.value) {
      case '-': {
        const t = this.infer(n.expression, env)
        const v = removeUndef(t)
        this.expect(v, NUM, 'Unary "-"', n.expression, 'number')
        if (v.k === 'num' && v.v !== undefined) return num(-v.v)
        return union(NUM, hasUndef(t) ? UNDEF : NEVER)
      }
      case '[': {
        const parts: Ty[] = []
        for (const e of n.expressions as Ast[]) {
          const t = this.infer(e, env)
          if (e.type === 'unary' && e.value === '[') parts.push(removeUndef(t))
          else parts.push(widen(elems(t)))
        }
        return arr(union(...parts))
      }
      case '{': {
        const items = elems(env.ctx)
        return this.object(n.lhs, env, items, canBeArray(env.ctx))
      }
      default:
        this.warn(`Unsupported unary operator "${n.value}".`, n)
        return ANY
    }
  }

  /** `{ k: v, ... }` constructors and `path{ k: v }` group-by */
  private object(pairs: Ast[][], env: Env, items: Ty, multi: boolean): Ty {
    const props: Record<string, Ty> = {}
    const req: string[] = []
    let extra: Ty | false = false
    const defined = new Set<string>()
    const valueCtx = multi ? union(items, arr(items)) : items
    for (const [k, v] of pairs) {
      const kt = removeUndef(this.infer(k, env.child({ ctx: items })))
      const vt = this.infer(v, env.child({ ctx: valueCtx }))
      const opt = hasUndef(vt)
      const val = widen(removeUndef(vt))
      const bad = members(kt).filter((m) => m.k !== 'str' && m.k !== 'any')
      if (bad.length) this.error(`Object keys must be strings, but this key is ${show(kt)}.`, k, 'T1003')
      const lits = members(kt)
      if (val.k === 'never') {
        this.warn('This value is always undefined, so the key is omitted from the result.', v, 'omitted-key')
        continue
      }
      if (lits.length > 0 && lits.every((m) => m.k === 'str' && m.v !== undefined)) {
        const exact = lits.length === 1
        for (const m of lits as { v: string }[]) {
          if (m.v in props && defined.has(m.v) && exact && !opt) {
            this.warn(`Key "${m.v}" is defined more than once; this fails at runtime.`, k, 'D1009')
          }
          props[m.v] = m.v in props ? union(props[m.v], val) : val
          if (exact && !opt) {
            if (!req.includes(m.v)) req.push(m.v)
          }
          defined.add(m.v)
        }
      } else {
        extra = extra === false ? val : union(extra, val)
      }
    }
    return obj(props, req, extra)
  }

  private condition(n: Ast, env: Env): Ty {
    const c = this.infer(n.condition, env)
    const cm = members(c)
    let known: boolean | undefined
    if (cm.length === 1 && cm[0].k === 'bool') known = cm[0].v
    else if (cm.length === 0 || (cm.length === 1 && cm[0].k === 'undef')) known = false

    // narrowing: `$exists(x) ? x : …` and `x ? x.y : …`
    const narrowed = new Map(env.narrowed)
    const cond: Ast = n.condition
    if (cond.type === 'function' && cond.procedure?.value === 'exists' && cond.arguments?.length === 1) {
      narrowed.set(astKey(cond.arguments[0]), 'def')
    } else if (cond.type === 'path' || cond.type === 'variable') {
      narrowed.set(astKey(cond), 'truthy')
    }
    const thenTy = known === false ? NEVER : this.infer(n.then, env.child({ narrowed }))
    const elseTy = known === true ? NEVER : n.else ? this.infer(n.else, env) : UNDEF
    if (known === true) this.info('This condition is always true; the else branch is dead.', n.condition, 'dead-branch')
    if (known === false) this.info('This condition is always false; the then branch is dead.', n.condition, 'dead-branch')
    return union(thenTy, elseTy)
  }

  /* ---------- functions ---------- */

  private lambda(n: Ast, env: Env): Ty {
    const params = (n.arguments as Ast[]).map(() => ANY)
    const f: FnTy = fn(params, ANY, { lambda: { node: n, env } })
    f.ret = this.runLambda(f, params)
    return f
  }

  private runLambda(f: FnTy, args: Ty[]): Ty {
    const { node, env } = f.lambda as { node: Ast; env: Env }
    if (this.depth >= MAX_DEPTH) return ANY
    this.depth++
    try {
      const scope = env.child()
      ;(node.arguments as Ast[]).forEach((p, i) => scope.vars.set(p.value, args[i] ?? UNDEF))
      return this.infer(node.body, scope)
    } finally {
      this.depth--
    }
  }

  call(f: Ty, args: Ty[]): Ty {
    return this.callValue(f, args, undefined, undefined)
  }

  private callValue(f: Ty, args: Ty[], node: Ast | undefined, env: Env | undefined): Ty {
    const out: Ty[] = []
    for (const m of members(f)) {
      if (m.k === 'fn') out.push(this.callFn(m, args, node, env))
      else if (m.k === 'any') out.push(ANY)
      else if (m.k !== 'undef') {
        this.error(`${show(m)} is not a function and cannot be called.`, node, 'T1006')
        out.push(ANY)
      } else {
        this.error('Cannot call an undefined function.', node, 'T1005')
        out.push(ANY)
      }
    }
    return union(...out)
  }

  private callFn(f: FnTy, args: Ty[], node: Ast | undefined, env: Env | undefined): Ty {
    if (f.builtin) return this.callBuiltin(f.builtin, args, node, env)
    if (f.lambda) return this.runLambda(f, args)
    if (f.sameAsArg) return args[0] ?? ANY
    // host function: validate arguments against the declared input
    f.params.forEach((p, i) => {
      const a = args[i]
      if (a === undefined) return
      this.expectArg(a, p, `Argument ${i + 1} of $${f.name ?? 'function'}`, node)
    })
    return f.ret
  }

  private expectArg(a: Ty, want: Ty, what: string, node: Ast | undefined) {
    const v = removeUndef(a)
    if (v.k === 'never' || assignable(v, want)) return
    if (overlaps(v, want)) {
      this.warn(`${what} should be ${show(want)}, but may be ${show(v)}.`, node, 'maybe-wrong-type')
    } else {
      this.error(`${what} must be ${show(want)}, but is ${show(v)}.`, node, 'wrong-type')
    }
  }

  private callBuiltin(name: string, input: Ty[], node: Ast | undefined, env: Env | undefined): Ty {
    const b = BUILTINS[name]
    const { params } = b.sig
    let args = [...input]
    const required = params.filter((p) => !p.optional).length
    const first = params[0]
    if (first?.ctx && env) {
      const c = removeUndef(env.ctx)
      const missing = args.length < required
      const mismatch = args.length > 0 && !overlaps(removeUndef(args[0]), first.ty) && overlaps(c, first.ty)
      if (missing || mismatch) args = [env.ctx, ...args]
    }
    const variadic = params.some((p) => p.variadic)
    if (args.length < required) {
      this.error(`$${name}() needs at least ${required} argument${required === 1 ? '' : 's'}, got ${args.length}.`, node, 'T0410')
    } else if (!variadic && args.length > params.length) {
      this.error(`$${name}() takes at most ${params.length} argument${params.length === 1 ? '' : 's'}, got ${args.length}.`, node, 'T0410')
    }
    args.forEach((a, i) => {
      const p = params[Math.min(i, params.length - 1)]
      if (!p || p.ty.k === 'any') return
      const want = p.wrap && p.ty.k === 'arr' ? union(p.ty, p.ty.item) : p.ty
      const v = removeUndef(a)
      if (v.k === 'never' || assignable(v, want)) return
      const label = `Argument ${i + 1} of $${name}()`
      if (overlaps(v, want)) {
        this.warn(`${label} should be ${show(p.ty)}, but may be ${show(v)}.`, node, 'maybe-wrong-type')
      } else {
        this.error(`${label} must be ${show(p.ty)}, but is ${show(v)}.`, node, 'wrong-type')
      }
    })
    let ret = b.ret ? b.ret(args, this) : b.sig.ret
    if (b.undefIn && args.length > 0 && hasUndef(args[0])) ret = union(ret, UNDEF)
    return ret
  }

  private callNode(n: Ast, env: Env, prepend?: Ty): Ty {
    const proc: Ast = n.procedure
    const argNodes = n.arguments as Ast[]
    if (argNodes.some((a) => a.type === 'operator' && a.value === '?')) {
      argNodes.forEach((a) => a.type !== 'operator' && this.infer(a, env))
      return fn([], ANY)
    }
    const args = argNodes.map((a) => this.infer(a, env))
    if (prepend !== undefined) args.unshift(prepend)
    if (proc.type === 'variable') {
      const name: string = proc.value
      const known =
        env.get(name) !== undefined ||
        this.opts.bindings?.[name] !== undefined ||
        this.opts.functions?.[name] !== undefined
      if (!known && BUILTINS[name]) return this.callBuiltin(name, args, n, env)
      if (!known) {
        this.error(`Unknown function $${name}().`, n, 'T1005')
        return ANY
      }
      return this.callValue(this.variable(proc, env), args, n, env)
    }
    return this.callValue(this.infer(proc, env), args, n, env)
  }

  private apply(n: Ast, env: Env): Ty {
    const l = this.infer(n.lhs, env)
    const rhs: Ast = n.rhs
    if (rhs.type === 'function') return this.callNode(rhs, env, l)
    const f = this.infer(rhs, env)
    if (members(f).every((m) => m.k !== 'fn' && m.k !== 'any')) {
      this.error(`The right side of "~>" must be a function, but is ${show(f)}.`, n, 'T2006')
      return ANY
    }
    if (members(l).some((m) => m.k === 'fn')) return fn([ANY], ANY) // composition
    return this.callValue(f, [l], n, env)
  }
}

/** Dry-run a JSONata expression against the type of its input. */
export function dryRunTy(expression: string, input: Ty, opts: TyOptions = {}): DryRunResult {
  const finish = (ty: Ty, diagnostics: Diagnostic[]): DryRunResult => {
    const optional = hasUndef(ty)
    const defined = removeUndef(ty)
    return {
      ty,
      schema: toSchema(defined),
      optional,
      alwaysUndefined: defined.k === 'never',
      type: show(ty),
      diagnostics,
      ok: !diagnostics.some((d) => d.severity === 'error'),
    }
  }

  if (expression.trim() === '') {
    return finish(UNDEF, [{ severity: 'warning', message: 'The expression is empty.', start: 0, end: 0 }])
  }

  let ast: Ast
  try {
    ast = jsonata(expression).ast() as Ast
  } catch (e) {
    const err = e as { message?: string; position?: number; token?: string; code?: string }
    const end = err.position ?? expression.length
    const len = err.token ? String(err.token).length : 1
    return finish(ANY, [
      {
        severity: 'error',
        message: err.message ?? 'Syntax error',
        code: err.code,
        start: Math.max(0, end - len),
        end,
      },
    ])
  }

  const inf = new Inferer(expression, opts)
  const env = new Env(input, input)
  let ty: Ty
  try {
    ty = inf.infer(ast, env)
  } catch (e) {
    inf.diags.push({ severity: 'error', message: `Dry-run failed: ${(e as Error).message}` })
    ty = ANY
  }
  return finish(ty, inf.diags)
}

/**
 * Dry-run a JSONata expression against a JSON Schema describing its input.
 * Returns a JSON Schema describing the output (plus whether it may be undefined).
 */
export function dryRun(
  expression: string,
  inputSchema: JSONSchema | undefined,
  opts: DryRunOptions = {},
): DryRunResult {
  const ctx = { defs: opts.defs }
  const bindings: Record<string, Ty> = {}
  for (const [k, v] of Object.entries(opts.bindings ?? {})) bindings[k] = fromSchema(v, ctx)
  const functions: Record<string, { input: Ty; output: Ty }> = {}
  for (const [k, v] of Object.entries(opts.functions ?? {})) {
    functions[k] = { input: fromSchema(v.input, ctx), output: fromSchema(v.output, ctx) }
  }
  return dryRunTy(expression, fromSchema(inputSchema, ctx), { bindings, functions })
}
