import type { TypeInfo } from '../flow/analyze'
import { tyColor } from './typeColors'

/** compact one-line type label with a colour dot */
export function TypeChip({
  info,
  max = 34,
  className = '',
}: {
  info: TypeInfo | null | undefined
  max?: number
  className?: string
}) {
  if (!info) return <span className={`text-[10px] text-zinc-600 ${className}`}>—</span>
  const text = info.type.length > max ? info.type.slice(0, max - 1) + '…' : info.type
  return (
    <span
      title={info.type}
      className={`inline-flex max-w-full items-center gap-1 rounded bg-zinc-800/80 px-1.5 py-px font-mono text-[10px] leading-4 text-zinc-300 ${className}`}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: tyColor(info.ty) }} />
      <span className="truncate">{text}</span>
    </span>
  )
}
