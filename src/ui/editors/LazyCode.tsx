import { lazy, Suspense } from 'react'
import type { CodeEditorProps } from './CodeEditor'

const CodeEditor = lazy(() => import('./CodeEditor'))

export function LazyCode(props: CodeEditorProps) {
  return (
    <Suspense fallback={<div className="p-3 text-xs text-zinc-500">Loading editor…</div>}>
      <CodeEditor {...props} />
    </Suspense>
  )
}
