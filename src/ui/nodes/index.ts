import type { NodeProps } from '@xyflow/react'
import type { ComponentType } from 'react'
import {
  BranchNode,
  CallNode,
  ConditionNode,
  InputNode,
  LoopNode,
  ReturnNode,
  TransformNode,
} from './components'

// React Flow hands every node the same props shape; each component narrows `data` itself
const as = (c: unknown) => c as ComponentType<NodeProps>

export const nodeTypes = {
  input: as(InputNode),
  transform: as(TransformNode),
  condition: as(ConditionNode),
  branch: as(BranchNode),
  loop: as(LoopNode),
  call: as(CallNode),
  return: as(ReturnNode),
}
