import { useCallback, useEffect, useState } from 'react'
import { EXAMPLES } from './flow/examples'
import { useStore } from './store'
import { BottomPanel } from './ui/BottomPanel'
import { Canvas } from './ui/Canvas'
import { LeftPanel } from './ui/LeftPanel'
import { Splitter } from './ui/Splitter'
import { TypeChip } from './ui/TypeChip'

/** a number that survives reloads (best effort) and stays within bounds */
function usePersistedSize(key: string, initial: number, min: number) {
  const [value, setValue] = useState(() => {
    try {
      const raw = Number(localStorage.getItem(key))
      return Number.isFinite(raw) && raw >= min ? raw : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, String(value))
    } catch {
      /* ignore */
    }
  }, [key, value])
  return [value, setValue] as const
}

function Toolbar() {
  const analysis = useStore((s) => s.analysis)
  const exampleId = useStore((s) => s.exampleId)
  const loadExample = useStore((s) => s.loadExample)
  const clear = useStore((s) => s.clear)
  const setSelection = useStore((s) => s.setSelection)
  const startRun = useStore((s) => s.startRun)
  const running = useStore((s) => s.run.running)
  const errors = analysis.messages.filter((m) => m.severity === 'error').length
  const warnings = analysis.messages.filter((m) => m.severity === 'warning').length
  const example = EXAMPLES.find((e) => e.id === exampleId)

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold tracking-tight text-zinc-100">jsonata-dry</span>
        <span className="hidden text-xs text-zinc-500 md:inline">typesafe flows from JSONata dry-runs</span>
      </div>
      <div className="mx-2 h-5 w-px bg-zinc-800" />
      <select
        className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
        value={exampleId ?? ''}
        title={example?.description}
        onChange={(e) => e.target.value && loadExample(e.target.value)}
      >
        {exampleId === null && <option value="">Custom flow</option>}
        {EXAMPLES.map((e) => (
          <option key={e.id} value={e.id}>
            {e.title}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={running}
        className="rounded bg-emerald-500 px-3 py-1 text-xs font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-60"
        title="Execute the flow with a sample (or your own) input and replay it on the canvas"
        onClick={() => {
          setSelection({ kind: 'run' })
          void startRun()
        }}
      >
        ▶ Run
      </button>
      <button
        type="button"
        className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        onClick={() => {
          if (confirm('Clear the canvas? Named types and functions are removed too.')) clear()
        }}
      >
        New
      </button>

      <div className="ml-auto flex items-center gap-3 text-xs">
        <span className="hidden text-zinc-500 lg:inline">flow returns</span>
        <TypeChip info={analysis.returnType} max={52} className="hidden lg:inline-flex" />
        <span
          className={`rounded-full px-2.5 py-0.5 font-medium ${
            errors
              ? 'bg-red-500/15 text-red-300'
              : warnings
                ? 'bg-amber-500/15 text-amber-300'
                : 'bg-emerald-500/15 text-emerald-300'
          }`}
        >
          {errors
            ? `${errors} error${errors === 1 ? '' : 's'}`
            : warnings
              ? `${warnings} warning${warnings === 1 ? '' : 's'}`
              : 'typesafe'}
        </span>
      </div>
    </header>
  )
}

export default function App() {
  const [leftW, setLeftW] = usePersistedSize('jsonata-dry:leftW', 264, 160)
  const [bottomH, setBottomH] = usePersistedSize('jsonata-dry:bottomH', 360, 100)
  const clampW = useCallback((w: number) => Math.max(180, Math.min(w, Math.round(window.innerWidth * 0.5))), [])
  const clampH = useCallback((h: number) => Math.max(120, Math.min(h, window.innerHeight - 160)), [])

  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <div style={{ width: clampW(leftW) }} className="min-h-0 shrink-0">
          <LeftPanel />
        </div>
        <Splitter orientation="col" onResize={(d) => setLeftW((w) => clampW(w + d))} onReset={() => setLeftW(264)} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1">
            <Canvas />
          </main>
          <Splitter
            orientation="row"
            // dragging up (negative delta) grows the bottom panel
            onResize={(d) => setBottomH((h) => clampH(h - d))}
            onReset={() => setBottomH(360)}
          />
          <div style={{ height: clampH(bottomH) }} className="shrink-0">
            <BottomPanel />
          </div>
        </div>
      </div>
    </div>
  )
}
