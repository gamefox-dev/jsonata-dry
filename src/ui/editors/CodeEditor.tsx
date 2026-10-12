import Editor from '@monaco-editor/react'
import { useEffect, useRef } from 'react'
import {
  clearCompletionContext,
  monaco,
  setCompletionContext,
  setModelJsonSchema,
  setTypeNames,
  type CompletionContext,
} from './monaco'

export interface EditorMarker {
  start: number
  end: number
  severity: 'error' | 'warning' | 'info'
  message: string
}

const SEVERITY = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
}

export interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  language: 'json' | 'typescript' | 'jsonata'
  /** stable model path: one model (and undo stack) per path */
  path: string
  markers?: EditorMarker[]
  readOnly?: boolean
  completion?: CompletionContext
  /** named types, offered for `$ref` / `t.Ref()` */
  typeNames?: string[]
  /** JSON models only: validate and complete against this schema */
  jsonSchema?: unknown
}

/** Monaco wrapper. Lives in its own lazily loaded chunk because Monaco is large. */
export default function CodeEditor({
  value,
  onChange,
  language,
  path,
  markers,
  readOnly,
  completion,
  typeNames,
  jsonSchema,
}: CodeEditorProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)

  const applyMarkers = () => {
    const model = editorRef.current?.getModel()
    if (!model) return
    monaco.editor.setModelMarkers(
      model,
      'dry',
      (markers ?? []).map((m) => {
        const a = model.getPositionAt(m.start)
        const b = model.getPositionAt(Math.max(m.end, m.start + 1))
        return {
          severity: SEVERITY[m.severity],
          message: m.message,
          startLineNumber: a.lineNumber,
          startColumn: a.column,
          endLineNumber: b.lineNumber,
          endColumn: b.column,
        }
      }),
    )
  }
  useEffect(applyMarkers) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (typeNames) setTypeNames(typeNames)
  }, [typeNames])

  useEffect(() => {
    if (jsonSchema === undefined) return
    setModelJsonSchema(path, jsonSchema)
    return () => setModelJsonSchema(path, null)
  }, [path, jsonSchema])

  useEffect(() => {
    if (!completion) return
    const key = monaco.Uri.parse(path).toString()
    setCompletionContext(key, completion)
    return () => void clearCompletionContext(key)
  }, [completion, path])

  return (
    // `nokey`: Monaco types through an EditContext <div> (not a contenteditable), which React Flow's
    // global key handler would otherwise treat as the canvas: Space (pan) and Backspace/Delete
    // (remove the selected node) would be swallowed while typing.
    <div className="nokey h-full w-full">
      <Editor
        height="100%"
        theme="dry-dark"
        path={path}
        language={language}
        value={value}
        onChange={(v) => onChange?.(v ?? '')}
        onMount={(ed) => {
          editorRef.current = ed
          applyMarkers()
        }}
        loading={<div className="p-3 text-xs text-zinc-500">Loading editor…</div>}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 12,
          lineHeight: 18,
          lineNumbers: 'off',
          glyphMargin: false,
          folding: false,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          padding: { top: 8, bottom: 8 },
          wordWrap: 'on',
          renderLineHighlight: 'none',
          fixedOverflowWidgets: true,
          overviewRulerLanes: 0,
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          quickSuggestions: { other: true, comments: false, strings: true },
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: 'on',
          tabCompletion: 'on',
          snippetSuggestions: 'top',
          parameterHints: { enabled: true },
          suggest: {
            showWords: false,
            showStatusBar: true,
            preview: true,
            showIcons: true,
          },
          hover: { enabled: 'on', delay: 250 },
        }}
      />
    </div>
  )
}
