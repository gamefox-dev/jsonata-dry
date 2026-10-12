import { removeUndef, members, type Ty } from './ty.ts'

/** deterministic PRNG so failures are reproducible */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const STRINGS = ['a', 'b', 'abc', '', 'Hello World', '12', 'x,y']

/** generate a random JSON value of the given type */
export function sample(ty: Ty, r: () => number, depth = 0): unknown {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  switch (ty.k) {
    case 'any':
      return pick<unknown>([1, 'a', true, null, 2.5, [1, 2], { a: 1 }])
    case 'never':
    case 'undef':
      return undefined
    case 'null':
      return null
    case 'bool':
      return ty.v ?? r() > 0.5
    case 'num':
      return ty.v ?? (ty.int ? Math.floor(r() * 20) - 3 : Math.round(r() * 1000) / 10)
    case 'str':
      return ty.v ?? pick(STRINGS)
    case 'arr': {
      const n = depth > 3 ? 0 : Math.floor(r() * 4)
      return Array.from({ length: n }, () => sample(removeUndef(ty.item), r, depth + 1))
    }
    case 'obj': {
      const o: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(ty.props)) {
        if (ty.req.includes(k) || r() > 0.4) {
          const val = sample(removeUndef(v), r, depth + 1)
          if (val !== undefined) o[k] = val
        }
      }
      return o
    }
    case 'fn':
      return undefined
    case 'union': {
      const ms = members(removeUndef(ty))
      return sample(pick(ms), r, depth)
    }
  }
}
