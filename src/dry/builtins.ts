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
  elems,
  fn,
  hasUndef,
  members,
  obj,
  removeUndef,
  seq,
  str,
  union,
  type Ty,
} from './ty.ts'

/** Parsed JSONata function signature, e.g. `<s-nn?:s>` */
export interface Param {
  ty: Ty
  optional: boolean
  /** the context value is used when this argument is omitted (`-`) */
  ctx: boolean
  /** one or more (`+`) */
  variadic: boolean
  /** array parameter that also accepts a singleton (JSONata wraps it) */
  wrap: boolean
}
export interface Sig {
  params: Param[]
  ret: Ty
}

const OPEN_OBJ = obj({}, [], ANY)

function skipBrackets(s: string, i: number): number {
  if (s[i] !== '<') return i
  let depth = 0
  for (; i < s.length; i++) {
    if (s[i] === '<') depth++
    else if (s[i] === '>' && --depth === 0) return i + 1
  }
  return i
}

function parseType(s: string, i: number): [Ty, number] {
  const c = s[i]
  switch (c) {
    case 's':
      return [STR, i + 1]
    case 'n':
      return [NUM, i + 1]
    case 'b':
      return [BOOL, i + 1]
    case 'l':
      return [NULL, i + 1]
    case 'o':
      return [OPEN_OBJ, i + 1]
    case 'x':
    case 'j':
      return [ANY, i + 1]
    case 'f': {
      return [fn([], ANY), skipBrackets(s, i + 1)]
    }
    case 'a': {
      if (s[i + 1] === '<') {
        const [inner] = parseType(s, i + 2)
        return [arr(inner), skipBrackets(s, i + 1)]
      }
      return [arr(ANY), i + 1]
    }
    case '(': {
      const parts: Ty[] = []
      let j = i + 1
      while (s[j] !== ')') {
        const [t, next] = parseType(s, j)
        parts.push(t)
        j = next
      }
      return [union(...parts), j + 1]
    }
    default:
      return [ANY, i + 1]
  }
}

export function parseSig(sig: string): Sig {
  const body = sig.slice(1, -1)
  const colon = (() => {
    // the top-level ':' that separates params from the return type
    let depth = 0
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '<' || body[i] === '(') depth++
      else if (body[i] === '>' || body[i] === ')') depth--
      else if (body[i] === ':' && depth === 0) return i
    }
    return -1
  })()
  const paramStr = colon < 0 ? body : body.slice(0, colon)
  const retStr = colon < 0 ? 'x' : body.slice(colon + 1)
  const params: Param[] = []
  let i = 0
  while (i < paramStr.length) {
    const [ty, next] = parseType(paramStr, i)
    i = next
    const p: Param = { ty, optional: false, ctx: false, variadic: false, wrap: ty.k === 'arr' }
    while (i < paramStr.length && '?+-'.includes(paramStr[i])) {
      if (paramStr[i] === '?') p.optional = true
      else if (paramStr[i] === '+') p.variadic = true
      else p.ctx = true
      i++
    }
    params.push(p)
  }
  return { params, ret: parseType(retStr, 0)[0] }
}

/** services the inferer offers to builtin return-type functions */
export interface Helpers {
  call(f: Ty, args: Ty[]): Ty
}
type RetFn = (args: Ty[], h: Helpers) => Ty

export interface Builtin {
  sig: Sig
  /** result may be undefined when the first argument may be undefined */
  undefIn: boolean
  ret?: RetFn
}

const def = (sig: string, opts: { undefIn?: boolean; ret?: RetFn } = {}): Builtin => ({
  sig: parseSig(sig),
  undefIn: opts.undefIn ?? true,
  ret: opts.ret,
})

const num0 = (a?: Ty) => a ?? UNDEF
const objPartial = (t: Ty): Ty =>
  union(
    ...members(removeUndef(t)).map((m): Ty =>
      m.k === 'obj' ? obj(m.props, [], m.extra) : m.k === 'any' ? OPEN_OBJ : m,
    ),
  )

const mergeObjs = (types: Ty[]): Ty => {
  // successive objects override earlier ones
  let props: Record<string, Ty> = {}
  let req: string[] = []
  const extras: (Ty | false | undefined)[] = []
  for (const t of types) {
    for (const m of members(removeUndef(t))) {
      if (m.k !== 'obj') return OPEN_OBJ
      props = { ...props, ...m.props }
      req = [...new Set([...req, ...m.req])]
      extras.push(m.extra)
    }
  }
  let extra: Ty | false | undefined = false
  if (extras.some((e) => e === undefined)) extra = undefined
  else {
    const open = extras.filter((e): e is Ty => e !== false && e !== undefined)
    if (open.length) extra = union(...open)
  }
  return obj(props, req, extra)
}

const valuesOf = (t: Ty): Ty =>
  union(
    ...members(removeUndef(t)).flatMap((m): Ty[] => {
      if (m.k === 'obj') return [...Object.values(m.props).map(removeUndef), m.extra || NEVER]
      if (m.k === 'arr') return [valuesOf(m.item)]
      return [m.k === 'any' ? ANY : NEVER]
    }),
  )

const TYPE_NAMES = union(
  ...['null', 'number', 'string', 'boolean', 'array', 'object', 'function'].map(str),
)

export const BUILTINS: Record<string, Builtin> = {
  // aggregation
  sum: def('<a<n>:n>', { ret: () => NUM }),
  count: def('<a:n>', { undefIn: false, ret: () => INT }),
  max: def('<a<n>:n>', { ret: () => union(NUM, UNDEF) }),
  min: def('<a<n>:n>', { ret: () => union(NUM, UNDEF) }),
  average: def('<a<n>:n>', { ret: () => union(NUM, UNDEF) }),
  // strings
  string: def('<x-b?:s>'),
  substring: def('<s-nn?:s>'),
  substringBefore: def('<s-s:s>'),
  substringAfter: def('<s-s:s>'),
  lowercase: def('<s-:s>'),
  uppercase: def('<s-:s>'),
  length: def('<s-:n>', { ret: () => INT }),
  trim: def('<s-:s>'),
  pad: def('<s-ns?:s>'),
  match: def('<s-f<s:o>n?:a<o>>', {
    ret: () =>
      seq(obj({ match: STR, index: INT, groups: arr(STR) }, ['match', 'index', 'groups'])),
  }),
  contains: def('<s-(sf):b>'),
  replace: def('<s-(sf)(sf)n?:s>'),
  split: def('<s-(sf)n?:a<s>>'),
  join: def('<a<s>s?:s>'),
  formatNumber: def('<n-so?:s>'),
  formatBase: def('<n-n?:s>'),
  formatInteger: def('<n-s:s>'),
  parseInteger: def('<s-s:n>', { ret: () => INT }),
  base64encode: def('<s-:s>'),
  base64decode: def('<s-:s>'),
  encodeUrlComponent: def('<s-:s>'),
  encodeUrl: def('<s-:s>'),
  decodeUrlComponent: def('<s-:s>'),
  decodeUrl: def('<s-:s>'),
  // numbers
  number: def('<(nsb)-:n>'),
  floor: def('<n-:n>', { ret: () => INT }),
  ceil: def('<n-:n>', { ret: () => INT }),
  round: def('<n-n?:n>'),
  abs: def('<n-:n>'),
  sqrt: def('<n-:n>'),
  power: def('<n-n:n>'),
  random: def('<:n>', { undefIn: false }),
  // booleans
  boolean: def('<x-:b>'),
  not: def('<x-:b>'),
  exists: def('<x:b>', { undefIn: false }),
  // arrays
  map: def('<af>', {
    ret: (a, h) => {
      const r = h.call(a[1], [elems(a[0]), INT, a[0]])
      return seq(r)
    },
  }),
  filter: def('<af>', { ret: (a) => seq(elems(a[0])) }),
  single: def('<af?>', { ret: (a) => union(elems(a[0]), UNDEF) }),
  reduce: def('<afj?:j>', {
    ret: (a, h) => {
      const item = elems(a[0])
      const hasInit = a.length > 2
      const acc0 = hasInit ? a[2] : item
      const r1 = h.call(a[1], [acc0, item, INT, a[0]])
      const r2 = h.call(a[1], [union(acc0, r1), item, INT, a[0]])
      return union(acc0, r2, hasInit ? NEVER : UNDEF)
    },
  }),
  zip: def('<a+>', { undefIn: false, ret: (a) => arr(arr(union(...a.map(elems)))) }),
  append: def('<xx:a>', {
    undefIn: false,
    ret: (a) => {
      const both = [a[0], a[1]].filter((x): x is Ty => x !== undefined)
      const e = union(...both.map(elems))
      const canBeEmpty = both.every((x) => hasUndef(x))
      return union(seq(e), canBeEmpty ? UNDEF : NEVER)
    },
  }),
  reverse: def('<a:a>', { ret: (a) => arr(elems(a[0])) }),
  shuffle: def('<a:a>', { ret: (a) => arr(elems(a[0])) }),
  sort: def('<af?:a>', { ret: (a) => arr(elems(a[0])) }),
  distinct: def('<x:x>', {
    ret: (a) =>
      union(
        ...members(a[0]).map((m): Ty => (m.k === 'arr' ? seq(m.item, { empty: false }) : m)),
      ),
  }),
  // objects
  keys: def('<x-:a<s>>', { ret: () => seq(STR) }),
  lookup: def('<x-s:x>', {
    ret: (a) => {
      const k = a[1]
      const lit = k && k.k === 'str' ? k.v : undefined
      const pick = (m: Ty): Ty => {
        if (m.k === 'obj') {
          if (lit !== undefined && lit in m.props) return m.props[lit]
          return union(...Object.values(m.props), m.extra || NEVER, UNDEF)
        }
        if (m.k === 'arr') return seq(pick(m.item))
        return m.k === 'any' ? ANY : UNDEF
      }
      return union(...members(removeUndef(a[0])).map(pick), UNDEF)
    },
  }),
  spread: def('<x-:a<o>>', {
    ret: (a) => seq(obj({}, [], valuesOf(a[0]))),
  }),
  merge: def('<a<o>:o>', {
    undefIn: true,
    ret: (a) => mergeObjs(members(elems(a[0]))),
  }),
  each: def('<o-f:a>', {
    ret: (a, h) => seq(h.call(a[1], [valuesOf(a[0]), STR, a[0]])),
  }),
  sift: def('<o-f?:o>', { ret: (a) => union(objPartial(a[0]), UNDEF) }),
  clone: def('<(oa)-:o>', { ret: (a) => num0(a[0]) }),
  // misc
  type: def('<x:s>', {
    ret: (a) => {
      const name = (m: Ty): Ty => {
        switch (m.k) {
          case 'str':
            return str('string')
          case 'num':
            return str('number')
          case 'bool':
            return str('boolean')
          case 'null':
            return str('null')
          case 'arr':
            return str('array')
          case 'obj':
            return str('object')
          case 'fn':
            return str('function')
          default:
            return m.k === 'any' ? TYPE_NAMES : NEVER
        }
      }
      return union(...members(removeUndef(a[0] ?? ANY)).map(name))
    },
  }),
  error: def('<s?:x>', { undefIn: false, ret: () => NEVER }),
  assert: def('<bs?:x>', { undefIn: false, ret: () => UNDEF }),
  eval: def('<sx?:x>', { ret: () => union(ANY, UNDEF) }),
  // date / time
  now: def('<s?s?:s>', { undefIn: false }),
  millis: def('<:n>', { undefIn: false, ret: () => INT }),
  toMillis: def('<s-s?:n>', { ret: () => INT }),
  fromMillis: def('<n-s?s?:s>'),
}

/** one-line documentation and argument names, shown in completion and hover */
export const BUILTIN_DOCS: Record<string, { args: string; doc: string }> = {
  sum: { args: 'array', doc: 'Sum of an array of numbers.' },
  count: { args: 'array', doc: 'Number of items in an array (0 for undefined).' },
  max: { args: 'array', doc: 'Largest number in an array.' },
  min: { args: 'array', doc: 'Smallest number in an array.' },
  average: { args: 'array', doc: 'Mean of an array of numbers.' },
  string: { args: 'arg[, prettify]', doc: 'Casts any value to a string (JSON-encoded for objects and arrays).' },
  substring: { args: 'str, start[, length]', doc: 'Part of a string from a start index, optionally limited in length.' },
  substringBefore: { args: 'str, chars', doc: 'Part of a string before the first occurrence of chars.' },
  substringAfter: { args: 'str, chars', doc: 'Part of a string after the first occurrence of chars.' },
  lowercase: { args: 'str', doc: 'Lower-cases a string.' },
  uppercase: { args: 'str', doc: 'Upper-cases a string.' },
  length: { args: 'str', doc: 'Number of characters in a string.' },
  trim: { args: 'str', doc: 'Trims and normalises whitespace.' },
  pad: { args: 'str, width[, char]', doc: 'Pads a string to a width (negative width pads on the left).' },
  match: { args: 'str, pattern[, limit]', doc: 'Regex matches as objects with match, index and groups.' },
  contains: { args: 'str, pattern', doc: 'Whether a string contains a substring or regex match.' },
  replace: { args: 'str, pattern, replacement[, limit]', doc: 'Replaces occurrences of a pattern.' },
  split: { args: 'str, separator[, limit]', doc: 'Splits a string into an array of strings.' },
  join: { args: 'array[, separator]', doc: 'Joins an array of strings.' },
  formatNumber: { args: 'number, picture[, options]', doc: 'Formats a number with an XPath picture string.' },
  formatBase: { args: 'number[, radix]', doc: 'Formats a number in the given radix (default 10).' },
  formatInteger: { args: 'number, picture', doc: 'Formats an integer, e.g. "w" for words or "I" for roman numerals.' },
  parseInteger: { args: 'str, picture', doc: 'Parses an integer from a formatted string.' },
  base64encode: { args: 'str', doc: 'Base64-encodes a string.' },
  base64decode: { args: 'str', doc: 'Decodes a base64 string.' },
  encodeUrlComponent: { args: 'str', doc: 'Percent-encodes a URL component.' },
  encodeUrl: { args: 'str', doc: 'Percent-encodes a whole URL.' },
  decodeUrlComponent: { args: 'str', doc: 'Decodes a percent-encoded URL component.' },
  decodeUrl: { args: 'str', doc: 'Decodes a percent-encoded URL.' },
  number: { args: 'arg', doc: 'Casts a string or boolean to a number.' },
  floor: { args: 'number', doc: 'Rounds down to an integer.' },
  ceil: { args: 'number', doc: 'Rounds up to an integer.' },
  round: { args: 'number[, precision]', doc: 'Rounds half to even, optionally to a number of decimals.' },
  abs: { args: 'number', doc: 'Absolute value.' },
  sqrt: { args: 'number', doc: 'Square root.' },
  power: { args: 'base, exponent', doc: 'base raised to exponent.' },
  random: { args: '', doc: 'A pseudo-random number in [0, 1).' },
  boolean: { args: 'arg', doc: 'Casts a value to a boolean using JSONata truthiness.' },
  not: { args: 'arg', doc: 'Logical negation of the boolean cast of the argument.' },
  exists: { args: 'arg', doc: 'Whether the argument evaluates to anything (not undefined).' },
  map: { args: 'array, function', doc: 'Applies function(value, index, array) to every item.' },
  filter: { args: 'array, function', doc: 'Keeps items for which function(value, index, array) is truthy.' },
  single: { args: 'array[, function]', doc: 'The one item matching function; errors unless exactly one does.' },
  reduce: { args: 'array, function[, init]', doc: 'Folds an array with function(accumulator, value, index, array).' },
  zip: { args: 'array1, array2', doc: 'Convolves arrays into an array of tuples.' },
  append: { args: 'array1, array2', doc: 'Concatenates two arrays (or values).' },
  reverse: { args: 'array', doc: 'Reverses an array.' },
  shuffle: { args: 'array', doc: 'Randomly reorders an array.' },
  sort: { args: 'array[, function]', doc: 'Sorts an array, optionally with function(a, b) returning a > b.' },
  distinct: { args: 'array', doc: 'Removes duplicate values.' },
  keys: { args: 'object', doc: 'The keys of an object (or of all objects in an array).' },
  lookup: { args: 'object, key', doc: 'The value of a key.' },
  spread: { args: 'object', doc: 'Splits an object into an array of single-key objects.' },
  merge: { args: 'array', doc: 'Merges an array of objects into one.' },
  each: { args: 'object, function', doc: 'Applies function(value, key, object) to every key/value pair.' },
  sift: { args: 'object, function', doc: 'Keeps the pairs for which function(value, key, object) is truthy.' },
  clone: { args: 'value', doc: 'Deep copy of a value.' },
  type: { args: 'value', doc: 'The JSON type name of a value.' },
  error: { args: '[message]', doc: 'Throws an error with a message.' },
  assert: { args: 'condition[, message]', doc: 'Throws when the condition is false.' },
  eval: { args: 'expr[, context]', doc: 'Evaluates a JSONata expression from a string.' },
  now: { args: '[picture[, timezone]]', doc: 'The current timestamp as an ISO 8601 string.' },
  millis: { args: '', doc: 'The current time in milliseconds since the epoch.' },
  toMillis: { args: 'timestamp[, picture]', doc: 'Parses an ISO 8601 timestamp to milliseconds.' },
  fromMillis: { args: 'number[, picture[, timezone]]', doc: 'Formats milliseconds as an ISO 8601 timestamp.' },
}
