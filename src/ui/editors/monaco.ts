import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { BUILTINS } from '../../dry/builtins'

const BUILTIN_NAMES = Object.keys(BUILTINS).sort()

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
  fields: string[]
  variables: string[]
}
const contexts = new Map<string, CompletionContext>()
export const setCompletionContext = (uri: string, ctx: CompletionContext) => contexts.set(uri, ctx)
export const clearCompletionContext = (uri: string) => contexts.delete(uri)

monaco.languages.registerCompletionItemProvider('jsonata', {
  triggerCharacters: ['$', '.'],
  provideCompletionItems(model, position) {
    const ctx = contexts.get(model.uri.toString())
    const word = model.getWordUntilPosition(position)
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
    const K = monaco.languages.CompletionItemKind
    const suggestions: monaco.languages.CompletionItem[] = [
      ...(ctx?.fields ?? []).map((f) => ({
        label: f,
        kind: K.Field,
        insertText: /^[A-Za-z_]\w*$/.test(f) ? f : '`' + f + '`',
        range,
        detail: 'field of the input',
      })),
      ...(ctx?.variables ?? []).map((v) => ({
        label: '$' + v,
        kind: K.Variable,
        insertText: '$' + v,
        range: new monaco.Range(position.lineNumber, Math.max(1, word.startColumn - 1), position.lineNumber, word.endColumn),
        detail: 'connected variable',
      })),
      ...BUILTIN_NAMES.map((n) => ({
        label: '$' + n,
        kind: K.Function,
        insertText: '$' + n + '($0)',
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range: new monaco.Range(position.lineNumber, Math.max(1, word.startColumn - 1), position.lineNumber, word.endColumn),
        detail: 'JSONata function',
      })),
    ]
    return { suggestions }
  },
})

/* ---------- TypeBox typings for the schema editor ---------- */

const TYPEBOX_DTS = `
interface TSchema { readonly [key: string]: unknown }
interface TOptions { title?: string; description?: string; default?: unknown; examples?: unknown[]; [k: string]: unknown }
interface TBuilder {
  String(options?: TOptions & { minLength?: number; maxLength?: number; pattern?: string; format?: string }): TSchema
  Number(options?: TOptions & { minimum?: number; maximum?: number }): TSchema
  Integer(options?: TOptions & { minimum?: number; maximum?: number }): TSchema
  Boolean(options?: TOptions): TSchema
  Null(options?: TOptions): TSchema
  Any(options?: TOptions): TSchema
  Unknown(options?: TOptions): TSchema
  Never(options?: TOptions): TSchema
  Literal(value: string | number | boolean, options?: TOptions): TSchema
  Object(properties: Record<string, TSchema>, options?: TOptions & { additionalProperties?: boolean | TSchema }): TSchema
  Array(items: TSchema, options?: TOptions & { minItems?: number; maxItems?: number }): TSchema
  Tuple(items: TSchema[], options?: TOptions): TSchema
  Record(key: TSchema, value: TSchema, options?: TOptions): TSchema
  Union(anyOf: TSchema[], options?: TOptions): TSchema
  Intersect(allOf: TSchema[], options?: TOptions): TSchema
  Optional(schema: TSchema): TSchema
  Partial(schema: TSchema): TSchema
  Required(schema: TSchema): TSchema
  Pick(schema: TSchema, keys: string[]): TSchema
  Omit(schema: TSchema, keys: string[]): TSchema
  Ref(name: string): TSchema
}
/** TypeBox builder (alias of Type) */
declare const t: TBuilder
declare const Type: TBuilder
`
const ts = monaco.typescript
ts.typescriptDefaults.addExtraLib(TYPEBOX_DTS, 'file:///typebox-globals.d.ts')
ts.typescriptDefaults.setCompilerOptions({
  target: ts.ScriptTarget.ES2020,
  allowNonTsExtensions: true,
  noLib: false,
  strict: true,
})
ts.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
  // `return` at the top level is how multi-statement programs end
  diagnosticCodesToIgnore: [1108, 1375, 1378, 2451, 6133],
})

export { monaco }
