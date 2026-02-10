import { Node, Edge, MarkerType } from '@xyflow/react';
import { CodeNodeData } from '../nodes/CodeNode';

// CallGraph 数据结构
export interface CallGraphNode {
  id: string;
  label?: string;
  type?: 'code' | 'note';
  symbol?: {
    name: string;
    uri: string;
    containerName?: string;
    line?: number;
    signature?: string;
  };
  tags?: string[];
  status?: 'normal' | 'broken';
  x?: number;
  y?: number;
}

export interface CallGraphEdge {
  from: string;
  to: string;
  type?: 'call' | 'explain';
}

export interface CallGraphData {
  title?: string;
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

interface TagConfig {
  predefinedTags: { name: string; color: string }[];
  showFileNameTag: boolean;
  fileNameTagColor: string;
}

/**
 * 从文件路径提取文件名
 */
function extractFileName(filePath: string): string | null {
  if (!filePath) return null;
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

/**
 * 构建标签颜色映射
 */
function buildTagColors(tagConfig: TagConfig): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const tag of tagConfig.predefinedTags) {
    colors[tag.name] = tag.color;
  }
  return colors;
}

/**
 * 构建显示标签（文件名 + 自定义标签）
 */
function buildDisplayTags(node: CallGraphNode, tagConfig: TagConfig): string[] {
  const tags: string[] = [];
  
  // 添加文件名标签
  if (tagConfig.showFileNameTag && node.symbol?.uri) {
    const fileName = extractFileName(node.symbol.uri);
    if (fileName) {
      tags.push(fileName);
    }
  }
  
  // 添加自定义标签
  if (node.tags) {
    tags.push(...node.tags);
  }
  
  return tags;
}

/**
 * 使用 Dagre 进行自动布局
 * 由于没有安装 dagre，这里使用简单的分层布局
 */
function autoLayout(nodes: CallGraphNode[], edges: CallGraphEdge[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  
  // 构建邻接表
  const childrenMap = new Map<string, string[]>();
  const parentSet = new Set<string>();
  
  for (const edge of edges) {
    if (!childrenMap.has(edge.from)) {
      childrenMap.set(edge.from, []);
    }
    childrenMap.get(edge.from)!.push(edge.to);
    parentSet.add(edge.to);
  }
  
  // 找出根节点（没有父节点的节点）
  const rootNodes = nodes.filter(n => !parentSet.has(n.id));
  
  // BFS 分层
  const levels = new Map<string, number>();
  const queue: { id: string; level: number }[] = [];
  
  for (const root of rootNodes) {
    queue.push({ id: root.id, level: 0 });
  }
  
  while (queue.length > 0) {
    const { id, level } = queue.shift()!;
    if (levels.has(id)) continue;
    levels.set(id, level);
    
    const children = childrenMap.get(id) || [];
    for (const childId of children) {
      if (!levels.has(childId)) {
        queue.push({ id: childId, level: level + 1 });
      }
    }
  }
  
  // 处理孤立节点
  for (const node of nodes) {
    if (!levels.has(node.id)) {
      levels.set(node.id, 0);
    }
  }
  
  // 按层分组
  const levelGroups = new Map<number, string[]>();
  for (const [id, level] of levels) {
    if (!levelGroups.has(level)) {
      levelGroups.set(level, []);
    }
    levelGroups.get(level)!.push(id);
  }
  
  // 分配坐标
  const LEVEL_HEIGHT = 150;
  const NODE_SPACING = 200;
  
  for (const [level, nodeIds] of levelGroups) {
    const totalWidth = (nodeIds.length - 1) * NODE_SPACING;
    const startX = -totalWidth / 2;
    
    nodeIds.forEach((id, index) => {
      positions.set(id, {
        x: startX + index * NODE_SPACING + 500, // 偏移到画布中心
        y: level * LEVEL_HEIGHT + 100,
      });
    });
  }
  
  return positions;
}

/**
 * CallGraph JSON -> React Flow 格式
 */
export function convertToReactFlow(
  data: CallGraphData,
  tagConfig: TagConfig
): { nodes: Node<CodeNodeData>[]; edges: Edge[] } {
  if (!data || !data.nodes) {
    return { nodes: [], edges: [] };
  }
  
  const tagColors = buildTagColors(tagConfig);
  
  // 检查是否需要自动布局
  const needsLayout = data.nodes.some(n => n.x === undefined || n.y === undefined);
  const positions = needsLayout ? autoLayout(data.nodes, data.edges || []) : null;
  
  const nodes: Node<CodeNodeData>[] = data.nodes.map((node) => {
    const pos = positions?.get(node.id) || { x: node.x || 0, y: node.y || 0 };
    const displayTags = buildDisplayTags(node, tagConfig);
    
    return {
      id: node.id,
      type: 'codeNode',
      position: pos,
      draggable: true,
      selectable: true,
      connectable: true,
      data: {
        label: node.label || node.symbol?.name || node.id,
        type: node.type || 'code',
        tags: displayTags,
        symbol: node.symbol,
        status: node.status,
        tagColors: {
          ...tagColors,
          // 文件名标签颜色
          ...(node.symbol?.uri ? { [extractFileName(node.symbol.uri) || '']: tagConfig.fileNameTagColor } : {}),
        },
      },
    };
  });
  
  const edges: Edge[] = (data.edges || []).map((edge, index) => ({
    id: `e-${edge.from}-${edge.to}-${index}`,
    source: edge.from,
    target: edge.to,
    sourceHandle: 'source',
    targetHandle: 'target',
    type: 'smoothstep',
    animated: false,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 20,
      height: 20,
      color: edge.type === 'explain' ? '#FFC107' : 'var(--vscode-charts-lines, #8a8a8a)',
    },
    style: {
      strokeWidth: 2,
      stroke: edge.type === 'explain' ? '#FFC107' : 'var(--vscode-charts-lines, #8a8a8a)',
    },
  }));
  
  return { nodes, edges };
}

/**
 * React Flow 格式 -> CallGraph JSON
 */
export function convertToCallGraph(
  nodes: Node<CodeNodeData>[],
  edges: Edge[],
  title?: string
): CallGraphData {
  const callGraphNodes: CallGraphNode[] = nodes.map((node) => ({
    id: node.id,
    label: node.data.label,
    type: node.data.type,
    symbol: node.data.symbol,
    tags: node.data.tags?.filter(tag => {
      // 过滤掉文件名标签，只保留用户自定义标签
      const fileName = node.data.symbol?.uri ? extractFileName(node.data.symbol.uri) : null;
      return tag !== fileName;
    }),
    status: node.data.status,
    x: node.position.x,
    y: node.position.y,
  }));
  
  const callGraphEdges: CallGraphEdge[] = edges.map((edge) => ({
    from: edge.source,
    to: edge.target,
    type: edge.style?.stroke === '#FFC107' ? 'explain' : 'call',
  }));
  
  return {
    title,
    nodes: callGraphNodes,
    edges: callGraphEdges,
  };
}
