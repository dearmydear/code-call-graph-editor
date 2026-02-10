// 简化测试版本 - 按照官方教程
import { useState, useCallback } from 'react';
import { ReactFlow, applyNodeChanges, applyEdgeChanges, addEdge, Controls, Background } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// 最简单的测试节点
const initialNodes = [
  { id: 'n1', position: { x: 100, y: 100 }, data: { label: 'Node 1' } },
  { id: 'n2', position: { x: 100, y: 250 }, data: { label: 'Node 2' } },
  { id: 'n3', position: { x: 300, y: 175 }, data: { label: 'Node 3' } },
];

const initialEdges = [
  { id: 'e1-2', source: 'n1', target: 'n2' },
  { id: 'e1-3', source: 'n1', target: 'n3' },
];

export default function App() {
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);

  const onNodesChange = useCallback(
    (changes: any) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );
  
  const onEdgesChange = useCallback(
    (changes: any) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );
  
  const onConnect = useCallback(
    (params: any) => setEdges((eds) => addEdge(params, eds)),
    [],
  );

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
      >
        <Controls />
        <Background />
      </ReactFlow>
    </div>
  );
}
