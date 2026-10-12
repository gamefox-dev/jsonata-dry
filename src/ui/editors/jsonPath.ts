/**
 * Minimal JSON(-ish) scanner: where in the document structure is `offset`?
 * Tolerates incomplete documents, which is the normal state while typing.
 */
export interface JsonFrame {
  kind: 'object' | 'array'
  /** the key (objects) or index (arrays) the cursor's value belongs to */
  key?: string | number
}

export interface JsonLocation {
  inString: boolean
  /** true when the string at the cursor is an object key rather than a value */
  isKey: boolean
  stack: JsonFrame[]
}

export function locate(text: string, offset: number): JsonLocation {
  const stack: JsonFrame[] = []
  let expectKey = false
  let i = 0
  const end = Math.min(offset, text.length)
  while (i < end) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const closed = j < text.length
      if (offset > i && offset <= j && !(closed && offset === j + 1)) {
        // the cursor is inside this string
        return { inString: true, isKey: expectKey && stack.at(-1)?.kind === 'object', stack }
      }
      const top = stack.at(-1)
      if (top?.kind === 'object' && expectKey) {
        try {
          top.key = JSON.parse(text.slice(i, j + 1)) as string
        } catch {
          top.key = text.slice(i + 1, j)
        }
      }
      i = j + 1
      continue
    }
    if (c === '{') {
      stack.push({ kind: 'object' })
      expectKey = true
    } else if (c === '[') {
      stack.push({ kind: 'array', key: 0 })
      expectKey = false
    } else if (c === '}' || c === ']') {
      stack.pop()
      expectKey = false
    } else if (c === ':') {
      expectKey = false
    } else if (c === ',') {
      const top = stack.at(-1)
      if (top?.kind === 'array') top.key = (top.key as number) + 1
      else expectKey = true
    }
    i++
  }
  return { inString: false, isKey: expectKey && stack.at(-1)?.kind === 'object', stack }
}

/**
 * If the cursor is inside the `required` array of an object schema, return the path of that schema
 * from the document root; otherwise null.
 */
export function requiredArrayOwner(loc: JsonLocation): (string | number)[] | null {
  const { stack } = loc
  const n = stack.length
  if (n < 2) return null
  if (stack[n - 1].kind !== 'array' || stack[n - 2].kind !== 'object' || stack[n - 2].key !== 'required') return null
  return stack.slice(0, n - 2).map((f) => f.key as string | number)
}
