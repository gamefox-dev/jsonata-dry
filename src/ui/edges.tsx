import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useStore } from '../store'
import { ERROR_COLOR, TRIGGER_COLOR, tyColor } from './typeColors'

/** data edges wear their type; trigger edges are dashed; errors turn red; dead branches fade */
export function TypedEdge(props: EdgeProps) {
  const { id, selected } = props
  const rep = useStore((s) => s.analysis.edges[id])
  const [path, labelX, labelY] = getBezierPath(props)
  const trigger = rep?.kind === 'trigger'
  const color = rep?.error
    ? ERROR_COLOR
    : trigger
      ? TRIGGER_COLOR
      : tyColor(rep?.type?.ty)
  const opacity = rep?.dead ? 0.35 : 1
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={18}
        className={rep?.async ? 'edge-async' : ''}
        style={{
          stroke: color,
          strokeWidth: selected ? 3 : 1.75,
          strokeDasharray: trigger || rep?.async || rep?.dead ? '6 4' : undefined,
          opacity,
        }}
      />
      {!trigger && rep?.type && (
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
