import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useRef } from 'react'
import { canConnect } from '../flow/model'
import { useStore } from '../store'
import { TypedEdge } from './edges'
import { nodeTypes } from './nodes'
import { KIND_STYLE } from './nodes/kinds'

const edgeTypes = { typed: TypedEdge }

function Inner() {
  const nodes = useStore((s) => s.doc.nodes)
  const edges = useStore((s) => s.doc.edges)
  const version = useStore((s) => s.version)
  const onNodesChange = useStore((s) => s.onNodesChange)
  const onEdgesChange = useStore((s) => s.onEdgesChange)
  const onConnect = useStore((s) => s.onConnect)
  const setSelection = useStore((s) => s.setSelection)
  const registerViewport = useStore((s) => s.registerViewport)
  const rf = useReactFlow()
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    registerViewport(() => {
      const r = box.current?.getBoundingClientRect()
      return rf.screenToFlowPosition({
        x: (r?.left ?? 0) + (r?.width ?? 400) / 2,
        y: (r?.top ?? 0) + (r?.height ?? 300) / 2,
      })
    })
    return () => registerViewport(null)
  }, [rf, registerViewport])

  // fit the view whenever a whole document is (re)loaded
  useEffect(() => {
    const t = setTimeout(() => void rf.fitView({ padding: 0.12, duration: 300 }), 60)
    return () => clearTimeout(t)
  }, [version, rf])

  const isValidConnection = useCallback(
    (c: Connection | Edge) => canConnect(c as Connection, nodes, edges),
    [nodes, edges],
  )

  return (
    <div ref={box} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={(_, n) => setSelection({ kind: 'node', id: n.id })}
        onEdgeClick={(_, e) => setSelection({ kind: 'edge', id: e.id })}
        onPaneClick={() => setSelection(null)}
        colorMode="dark"
        snapToGrid
        snapGrid={[10, 10]}
        minZoom={0.15}
        maxZoom={1.6}
        deleteKeyCode={['Backspace', 'Delete']}
        connectionRadius={28}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#27272a" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          maskColor="#09090bcc"
          nodeColor={(n) => KIND_STYLE[(n.type ?? 'transform') as keyof typeof KIND_STYLE]?.accent ?? '#71717a'}
          style={{ background: '#18181b' }}
        />
      </ReactFlow>
    </div>
  )
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  )
}
