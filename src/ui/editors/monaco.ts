import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { BUILTIN_DOCS } from '../../dry/builtins'
import { completeAt, hoverAt } from '../../dry/complete'
import { show, type Ty } from '../../dry/ty'
import { buildMetaSchema } from './metaSchema'
import { locate, requiredArrayOwner } from './jsonPath'

/**
 * Monaco is bundled locally (workers via Vite's `?worker`) instead of being fetched from a CDN,
 * so the example works offline.
 */
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}
loader.config({ monaco })

/* ---------- JSONata language ---------- */

monaco.languages.register({ id: 'jsonata' })
monaco.languages.setLanguageConfiguration('jsonata', {
  comments: { blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string'] },
    { open: '`', close: '`' },
  ],
})
monaco.languages.setMonarchTokensProvider('jsonata', {
  tokenizer: {
    root: [
      [/\/\*/, 'comment', '@comment'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],
      [/`[^`]*`/, 'type.identifier'],
      [/\$\$|\$[A-Za-z_]\w*|\$/, 'variable'],
      [/\b(and|or|in|function|true|false|null)\b/, 'keyword'],
      [/\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'],
      [/:=|~>|\.\.|\?\?|\?:|!=|<=|>=|[-+*/%=<>&|^@#?:.,;]/, 'operator'],
      [/[A-Za-z_]\w*/, 'identifier'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
})

monaco.editor.defineTheme('dry-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'variable', foreground: '7dd3fc' },
    { token: 'keyword', foreground: 'c084fc' },
    { token: 'string', foreground: '86efac' },
    { token: 'number', foreground: 'fcd34d' },
    { token: 'operator', foreground: 'a1a1aa' },
    { token: 'type.identifier', foreground: 'fda4af' },
  ],
  colors: {
    'editor.background': '#0c0c0f',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorGutter.background': '#0c0c0f',
  },
})

/** what the expression editor knows about its surroundings, for completion */
export interface CompletionContext {
  /** type of `$`, or null when nothing is connected */
  input: Ty | null
  /** types of the extra named inputs, available as `$name` */
  bindings: Record<string, Ty>
}
const contexts = new Map<string, CompletionContext>()
export const setCompletionContext = (uri: string, ctx: CompletionContext) => contexts.set(uri, ctx)
export const clearCompletionContext = (uri: string) => contexts.delete(uri)

const K = monaco.languages.CompletionItemKind
const KIND = {
  field: K.Field,
  variable: K.Variable,
  function: K.Function,
  keyword: K.Keyword,
} as const

monaco.languages.registerCompletionItemProvider('jsonata', {
  triggerCharacters: ['$', '.', '[', '(', ',', ' '],
  provideCompletionItems(model, position) {
    const ctx = contexts.get(model.uri.toString())
    if (!ctx) return { suggestions: [] }
    const offset = model.getOffsetAt(position)
    const r = completeAt(model.getValue(), offset, ctx.input, ctx.bindings)
    const a = model.getPositionAt(r.from)
    const b = model.getPositionAt(r.to)
    const range = new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column)
    return {
      suggestions: r.items.map((it) => ({
        label: it.kind === 'variable' || it.kind === 'function' ? `$${it.name}` : it.name,
        kind: KIND[it.kind],
        insertText: it.insert,
        insertTextRules: it.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        filterText: it.filter,
        detail: it.detail,
        documentation: it.doc ? { value: it.doc } : undefined,
        sortText: `${it.rank}${it.optional ? 'b' : 'a'}${it.name}`,
        range,
        tags: undefined,
      })),
    }
  },
})

monaco.languages.registerHoverProvider('jsonata', {
  provideHover(model, position) {
    const ctx = contexts.get(model.uri.toString())
    if (!ctx) return null
    const h = hoverAt(model.getValue(), model.getOffsetAt(position), ctx.input, ctx.bindings)
    if (!h) return null
    const a = model.getPositionAt(h.start)
    const b = model.getPositionAt(h.end)
    const doc = h.kind === 'call' && h.name ? BUILTIN_DOCS[h.name] : undefined
    const contents = [
      {
        value:
          '```ts\n' +
          (h.kind === 'call' && h.name ? `$${h.name}(${doc?.args ?? ''}): ` : h.name ? `${h.kind === 'variable' ? '$' : ''}${h.name}: ` : '') +
          show(h.ty) +
          '\n```',
      },
      ...(doc ? [{ value: doc.doc }] : []),
    ]
    return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), contents }
  },
})

/* ---------- named types: suggested for `$ref` / `t.Ref()` ---------- */

let typeNames: string[] = []

const jsonDefaults = monaco.json.jsonDefaults
/** schemas for specific JSON models (e.g. the run input), keyed by model path */
const modelSchemas = new Map<string, unknown>()
const applyMetaSchema = () =>
  jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    enableSchemaRequest: false,
    schemas: [
      // every `schema-*.json` model is a JSON Schema being authored
      {
        uri: 'inmemory://meta/json-schema.json',
        fileMatch: ['*schema-*.json'],
        schema: buildMetaSchema(typeNames),
      },
      ...[...modelSchemas].map(([path, schema]) => ({
        uri: `inmemory://schemas/${path}`,
        fileMatch: ['*' + path],
        schema: schema as object,
      })),
    ],
  })
applyMetaSchema()

/** validate (and complete) the JSON model at `path` against `schema`; pass null to remove */
export function setModelJsonSchema(path: string, schema: unknown | null) {
  const had = modelSchemas.get(path)
  if (schema === null) modelSchemas.delete(path)
  else {
    if (JSON.stringify(had) === JSON.stringify(schema)) return
    modelSchemas.set(path, schema)
  }
  applyMetaSchema()
}

/** call when the set of named types changes */
export function setTypeNames(names: string[]) {
  if (names.join('\u0000') === typeNames.join('\u0000')) return
  typeNames = names
  applyMetaSchema()
}

/** `required: ["…"]` completes with the names of the sibling `properties` */
monaco.languages.registerCompletionItemProvider('json', {
  triggerCharacters: ['"'],
  provideCompletionItems(model, position) {
    const text = model.getValue()
    const offset = model.getOffsetAt(position)
    const loc = locate(text, offset)
    const owner = requiredArrayOwner(loc)
    if (!owner) return { suggestions: [] }
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      return { suggestions: [] }
    }
    let node: unknown = doc
    for (const k of owner) node = (node as Record<string | number, unknown> | undefined)?.[k]
    const o = node as { properties?: Record<string, unknown>; required?: unknown } | undefined
    const taken = new Set(Array.isArray(o?.required) ? (o?.required as string[]) : [])
    const word = model.getWordUntilPosition(position)
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
    return {
      suggestions: Object.keys(o?.properties ?? {})
        .filter((k) => !taken.has(k))
        .map((k) => ({
          label: k,
          kind: monaco.languages.CompletionItemKind.Property,
          insertText: loc.inString ? k : JSON.stringify(k),
          detail: 'property of this object',
          range,
        })),
    }
  },
})

/* ---------- TypeBox: the real typings ---------- */

const ts = monaco.typescript
const typeboxFiles = import.meta.glob('/node_modules/@sinclair/typebox/build/cjs/**/*.d.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
for (const [path, source] of Object.entries(typeboxFiles)) {
  ts.typescriptDefaults.addExtraLib(source, 'file://' + path)
}
ts.typescriptDefaults.addExtraLib(
  JSON.stringify({ name: '@sinclair/typebox', version: '0.34.0', types: 'build/cjs/index.d.ts' }),
  'file:///node_modules/@sinclair/typebox/package.json',
)
ts.typescriptDefaults.addExtraLib(
  `import type * as TB from '@sinclair/typebox'
declare global {
  /** TypeBox builder. \`t.Object({ name: t.String() })\` */
  const t: typeof TB.Type
  /** TypeBox builder (same as \`t\`) */
  const Type: typeof TB.Type
  type Static<T extends TB.TSchema> = TB.Static<T>
  type TSchema = TB.TSchema
}
export {}
`,
  'file:///typebox-globals.d.ts',
)
ts.typescriptDefaults.setCompilerOptions({
  target: ts.ScriptTarget.ES2020,
  allowNonTsExtensions: true,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  strict: true,
  noEmit: true,
})
ts.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
  // `return` at the top level is how multi-statement programs end
  diagnosticCodesToIgnore: [1108, 1375, 1378, 2451, 6133],
})

/** `t.Ref("` completes with the named types */
monaco.languages.registerCompletionItemProvider('typescript', {
  triggerCharacters: ['"', "'", '`'],
  provideCompletionItems(model, position) {
    const before = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column))
    if (!/\b(?:t|Type)\.Ref\(\s*["'`][\w$-]*$/.test(before)) return { suggestions: [] }
    const word = model.getWordUntilPosition(position)
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
    return {
      suggestions: typeNames.map((n) => ({
        label: n,
        kind: monaco.languages.CompletionItemKind.Reference,
        insertText: n,
        detail: 'named type',
        range,
      })),
    }
  },
})

export { monaco }
