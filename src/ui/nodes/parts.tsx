import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import { useEffect, type ReactNode } from 'react'
import type { NodeKind } from '../../flow/model'
import type { NodeReport, TypeInfo } from '../../flow/analyze'
import { KIND_STYLE, worst } from './kinds'
import { useStore } from '../../store'
import { TypeChip } from '../TypeChip'
import { ERROR_COLOR, TRIGGER_COLOR, WARN_COLOR, tyColor } from '../typeColors'

export function NodeShell({
  id,
  kind,
  title,
  selected,
  report,
  gates,
  hasTrigger = true,
  headerExtra,
  children,
}: {
  id: string
  kind: NodeKind
  title: string
  selected?: boolean
  report: NodeReport | undefined
  /** bottom trigger gates */
  gates?: { id: string; label: string; color?: string }[]
  hasTrigger?: boolean
  headerExtra?: ReactNode
  children: ReactNode
}) {
  const style = KIND_STYLE[kind]
  const status = report?.status ?? 'live'
  const sev = report ? worst(report.messages) : null
  const lazy = useStore((s) => s.doc.edges.some((e) => e.target === id && e.targetHandle === 'trigger'))
  const updateInternals = useUpdateNodeInternals()
  const gateKey = gates?.map((g) => g.id).join() ?? ''
  // handle sets change with the node's configuration
  const handleKey = useStore((s) => {
    const n = s.doc.nodes.find((x) => x.id === id)
    if (!n) return ''
    const d = n.data as Record<string, unknown>
    return `${n.type}:${String(d.mode ?? '')}:${((d.variables as string[] | undefined) ?? []).join(',')}`
  })
  useEffect(() => {
    updateInternals(id)
  }, [id, gateKey, handleKey, updateInternals])

  const border = selected
    ? 'border-indigo-400 ring-2 ring-indigo-400/40'
    : sev === 'error'
      ? 'border-red-500/70'
      : sev === 'warning'
        ? 'border-amber-500/60'
        : 'border-zinc-700'
  const dim = status === 'unreachable' ? 'opacity-45' : status === 'dead' ? 'opacity-55' : ''
  const dashed = status !== 'live' ? 'border-dashed' : ''
  const msgs = report?.messages.filter((m) => m.severity !== 'info') ?? []

  return (
    <div
      className={`relative w-[280px] rounded-lg border bg-zinc-900 text-xs shadow-xl shadow-black/40 ${border} ${dim} ${dashed}`}
    >
      {hasTrigger && (
        <Handle
          type="target"
          position={Position.Top}
          id="trigger"
          className="trigger"
          style={{ background: lazy ? TRIGGER_COLOR : '#18181b', borderColor: TRIGGER_COLOR }}
          title="Trigger gate: connect to make this node lazy"
        />
      )}
      <div
        className="flex items-center gap-2 rounded-t-lg border-b border-zinc-800 px-3 py-1.5"
        style={{ background: style.accent + '18' }}
      >
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-bold text-zinc-950"
          style={{ background: style.accent }}
        >
          {style.glyph}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-100">{title}</span>
        {lazy && (
          <span
            className="rounded px-1 text-[9px] font-semibold uppercase tracking-wide"
            style={{ color: TRIGGER_COLOR, background: TRIGGER_COLOR + '22' }}
            title="Lazy: waits for its trigger gate"
          >
            lazy
          </span>
        )}
        {headerExtra}
        {status === 'dead' && (
          <span className="rounded bg-zinc-700/60 px-1 text-[9px] font-semibold uppercase text-zinc-300" title={report?.deadReason}>
            dead
          </span>
        )}
        {report?.async && (
          <span className="rounded bg-sky-500/20 px-1 text-[9px] font-semibold uppercase text-sky-300" title="Runs in a detached async branch">
            async
          </span>
        )}
      </div>

      <div className="px-3 py-1.5">{children}</div>

      {msgs.length > 0 && (
        <div
          className="border-t border-zinc-800 px-3 py-1 text-[10px]"
          style={{ color: sev === 'error' ? ERROR_COLOR : WARN_COLOR }}
          title={msgs.map((m) => m.message).join('\n')}
        >
          <span className="line-clamp-2">
            {msgs.length > 1 ? `${msgs.length} issues · ` : ''}
            {msgs[0].message}
          </span>
        </div>
      )}

      {gates && gates.length > 0 && (
        <div className="relative flex h-6 items-end justify-around border-t border-zinc-800/60 px-2 pb-0.5">
          {gates.map((g) => (
            <div key={g.id} className="relative flex h-full flex-1 items-center justify-center">
              <span className="text-[10px] font-medium" style={{ color: g.color ?? TRIGGER_COLOR }}>
                {g.label}
              </span>
              <Handle
                type="source"
                position={Position.Bottom}
                id={g.id}
                className="trigger"
                style={{ left: '50%', background: g.color ?? TRIGGER_COLOR, borderColor: '#18181b' }}
                title={`Trigger gate "${g.label}"`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** a labelled data input row (handle on the left edge) */
export function DataIn({
  id,
  label,
  info,
  side = 'left',
}: {
  id: string
  label: string
  info?: TypeInfo | null
  side?: 'left' | 'right'
}) {
  const color = tyColor(info?.ty)
  const pos = side === 'left' ? Position.Left : Position.Right
  return (
    <div className={`relative -mx-3 flex h-6 items-center gap-2 px-3 ${side === 'right' ? 'flex-row-reverse' : ''}`}>
      <Handle
        type="target"
        position={pos}
        id={id}
        style={{ background: info ? color : '#18181b', borderColor: info ? '#18181b' : '#71717a' }}
      />
      <span className="shrink-0 text-[11px] text-zinc-400">{label}</span>
      <TypeChip info={info} />
    </div>
  )
}

/** a labelled data output row (handle on the right edge) */
export function DataOut({
  id,
  label,
  info,
  detached,
}: {
  id: string
  label: string
  info?: TypeInfo | null
  detached?: boolean
}) {
  const color = tyColor(info?.ty)
  return (
    <div className="relative -mx-3 flex h-6 flex-row-reverse items-center gap-2 px-3">
      <Handle type="source" position={Position.Right} id={id} style={{ background: color, borderColor: '#18181b' }} />
      <span className="shrink-0 text-[11px] text-zinc-400">
        {label}
        {detached ? ' (async)' : ''}
      </span>
      <TypeChip info={info} className="ml-auto" />
    </div>
  )
}

export function CodePreview({ text, lines = 3 }: { text: string; lines?: number }) {
  return (
    <pre
      className="my-1 overflow-hidden whitespace-pre-wrap rounded bg-zinc-950 px-2 py-1 font-mono text-[10.5px] leading-4 text-zinc-300"
      style={{
        display: '-webkit-box',
        WebkitLineClamp: lines,
        WebkitBoxOrient: 'vertical',
        overflowWrap: 'anywhere',
      }}
    >
      {text || ' '}
    </pre>
  )
}
