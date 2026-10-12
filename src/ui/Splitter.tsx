import { useRef } from 'react'

/** Drag handle between panels. `col` resizes horizontally, `row` vertically. */
export function Splitter({
  orientation,
  onResize,
  onReset,
}: {
  orientation: 'col' | 'row'
  /** pixels moved since the last event */
  onResize: (delta: number) => void
  onReset?: () => void
}) {
  const last = useRef<number | null>(null)
  const horizontal = orientation === 'col'
  const pos = (e: { clientX: number; clientY: number }) => (horizontal ? e.clientX : e.clientY)
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className={`group relative z-20 shrink-0 bg-zinc-800 outline-none transition-colors hover:bg-indigo-500/60 focus-visible:bg-indigo-500/60 ${
        horizontal ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'
      }`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        last.current = pos(e)
      }}
      onPointerMove={(e) => {
        if (last.current === null) return
        const p = pos(e)
        onResize(p - last.current)
        last.current = p
      }}
      onPointerUp={() => (last.current = null)}
      onPointerCancel={() => (last.current = null)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 12
        const keys = horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
        if (e.key === keys[0]) onResize(-step)
        if (e.key === keys[1]) onResize(step)
      }}
    >
      {/* generous invisible hit area */}
      <div className={`absolute ${horizontal ? '-left-1.5 -right-1.5 inset-y-0' : '-top-1.5 -bottom-1.5 inset-x-0'}`} />
    </div>
  )
}
