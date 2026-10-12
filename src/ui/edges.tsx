import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useStore } from '../store'
import { ERROR_COLOR, TRIGGER_COLOR, tyColor } from './typeColors'

/** data edges wear their type; trigger edges are dashed; errors turn red; dead branches fade */
export function TypedEdge(props: EdgeProps) {
  const { id, selected } = props
  const rep = useStore((s) => s.analysis.edges[id])
  const runActive = useStore((s) => s.run.view !== null)
  const re = useStore((s) => s.run.view?.edges[id])
  const [path, labelX, labelY] = getBezierPath(props)
  const trigger = rep?.kind === 'trigger'
  const color = rep?.error
    ? ERROR_COLOR
    : trigger
      ? TRIGGER_COLOR
      : tyColor(rep?.type?.ty)
  // while a run is shown: the wires that carried something light up, the rest recede
  const runColor = re?.current ? '#22d3ee' : re?.detached ? '#7dd3fc' : '#67e8f9'
  const opacity = runActive ? (re ? 1 : 0.12) : rep?.dead ? 0.35 : 1
  const stroke = re ? runColor : color
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={18}
        className={rep?.async || re?.current ? 'edge-async' : ''}
        style={{
          stroke,
          strokeWidth: selected || re?.current ? 3 : re ? 2.25 : 1.75,
          strokeDasharray:
            re?.current || trigger || rep?.async || (!re && rep?.dead) ? '6 4' : undefined,
          opacity,
        }}
      />
      {re && re.hasValue && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute max-w-48 truncate rounded border border-cyan-700 bg-cyan-950/90 px-1 py-px font-mono text-[9px] leading-3 text-cyan-100"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {(() => {
              const t = re.value === undefined ? 'undefined' : (JSON.stringify(re.value) ?? String(re.value))
              return t.length > 40 ? t.slice(0, 39) + '…' : t
            })()}
          </div>
        </EdgeLabelRenderer>
      )}
      {!runActive && !trigger && rep?.type && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded border px-1 py-px font-mono text-[9px] leading-3"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              opacity,
              color,
              borderColor: color + '55',
              background: '#09090bdd',
            }}
          >
            {rep.type.type.length > 30 ? rep.type.type.slice(0, 29) + '…' : rep.type.type}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
