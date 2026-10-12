import type { Msg } from '../../flow/analyze'
import type { NodeKind } from '../../flow/model'

export const KIND_STYLE: Record<NodeKind, { accent: string; glyph: string; name: string }> = {
  input: { accent: '#34d399', glyph: '▶', name: 'Input' },
  transform: { accent: '#38bdf8', glyph: 'ƒ', name: 'Transform' },
  condition: { accent: '#fbbf24', glyph: '?', name: 'Condition' },
  branch: { accent: '#fb923c', glyph: '⑂', name: 'Branch' },
  loop: { accent: '#a78bfa', glyph: '↻', name: 'Loop' },
  call: { accent: '#fb7185', glyph: 'λ', name: 'Call' },
  return: { accent: '#818cf8', glyph: '⏎', name: 'Return' },
}

/** worst message severity, for border colouring */
export function worst(messages: Msg[]): 'error' | 'warning' | null {
  if (messages.some((m) => m.severity === 'error')) return 'error'
  if (messages.some((m) => m.severity === 'warning')) return 'warning'
  return null
}
