import { describe, expect, test } from 'bun:test'
import { locate, requiredArrayOwner } from '../src/ui/editors/jsonPath'

const at = (src: string) => locate(src.replace('|', ''), src.indexOf('|'))

describe('json locate', () => {
  test('finds the required array and its owner', () => {
    const l = at('{"properties": {"a": {"type": "string"}}, "required": ["a", "|"]}')
    expect(l.inString).toBe(true)
    expect(requiredArrayOwner(l)).toEqual([])
  })
  test('nested owner path', () => {
    const l = at('{"properties": {"user": {"type": "object", "properties": {"id": {}}, "required": ["|"]}}}')
    expect(requiredArrayOwner(l)).toEqual(['properties', 'user'])
  })
  test('outside of required', () => {
    expect(requiredArrayOwner(at('{"enum": ["|"]}'))).toBeNull()
    expect(requiredArrayOwner(at('{"required": [], "x": "|"}'))).toBeNull()
  })
  test('empty array position', () => {
    const l = at('{"required": [|]}')
    expect(l.inString).toBe(false)
    expect(requiredArrayOwner(l)).toEqual([])
  })
  test('keys vs values', () => {
    expect(at('{"ty|').isKey).toBe(true)
    expect(at('{"type": "str|').isKey).toBe(false)
  })
})
