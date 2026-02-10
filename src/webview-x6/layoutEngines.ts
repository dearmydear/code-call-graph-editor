/**
 * Layout engine abstraction layer
 * Provides a unified interface for multiple graph layout algorithms
 */
import dagre from '@dagrejs/dagre';
import ELK from 'elkjs/lib/elk.bundled.js';

// === Types ===

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
}

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
}

export type LayoutDirection = 'TB' | 'LR';

export interface LayoutEngine {
  id: string;
  name: string;
  group: string;
  supportsDirection: boolean;
  execute(
    nodes: LayoutNodeInput[],
    edges: LayoutEdgeInput[],
    direction: LayoutDirection,
    offsetX: number,
    offsetY: number
  ): Promise<LayoutResult>;
}

// === Dagre Engine ===

class DagreLayoutEngine implements LayoutEngine {
  id = 'dagre';
  name = 'Dagre';
  group = 'hierarchical';
  supportsDirection = true;

  async execute(
    nodes: LayoutNodeInput[],
    edges: LayoutEdgeInput[],
    direction: LayoutDirection,
    offsetX: number,
    offsetY: number
  ): Promise<LayoutResult> {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: direction,
      nodesep: 80,
      ranksep: 120,
      marginx: 0,
      marginy: 0,
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const node of nodes) {
      g.setNode(node.id, { width: node.width, height: node.height });
    }
    for (const edge of edges) {
      g.setEdge(edge.source, edge.target);
    }

    dagre.layout(g);

    const positions = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      const n = g.node(node.id);
      if (n) {
        // dagre returns center coordinates; convert to top-left
        positions.set(node.id, {
          x: offsetX + n.x - node.width / 2,
          y: offsetY + n.y - node.height / 2,
        });
      }
    }
    return { positions };
  }
}

// === ELK Engines ===

class ElkLayeredEngine implements LayoutEngine {
  id = 'elk-layered';
  name = 'ELK Layered';
  group = 'hierarchical';
  supportsDirection = true;
  private elk = new ELK();

  async execute(
    nodes: LayoutNodeInput[],
    edges: LayoutEdgeInput[],
    direction: LayoutDirection,
    offsetX: number,
    offsetY: number
  ): Promise<LayoutResult> {
    const elkDirection = direction === 'TB' ? 'DOWN' : 'RIGHT';

    const elkGraph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': elkDirection,
        'elk.spacing.nodeNode': '80',
        'elk.layered.spacing.nodeNodeBetweenLayers': '120',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      },
      children: nodes.map(n => ({
        id: n.id,
        width: n.width,
        height: n.height,
      })),
      edges: edges.map((e, i) => ({
        id: `e${i}`,
        sources: [e.source],
        targets: [e.target],
      })),
    };

    const result = await this.elk.layout(elkGraph);

    const positions = new Map<string, { x: number; y: number }>();
    if (result.children) {
      for (const child of result.children) {
        positions.set(child.id, {
          x: offsetX + (child.x || 0),
          y: offsetY + (child.y || 0),
        });
      }
    }
    return { positions };
  }
}

class ElkMrTreeEngine implements LayoutEngine {
  id = 'elk-mrtree';
  name = 'ELK Tree';
  group = 'tree';
  supportsDirection = true;
  private elk = new ELK();

  async execute(
    nodes: LayoutNodeInput[],
    edges: LayoutEdgeInput[],
    direction: LayoutDirection,
    offsetX: number,
    offsetY: number
  ): Promise<LayoutResult> {
    const elkDirection = direction === 'TB' ? 'DOWN' : 'RIGHT';

    const elkGraph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'mrtree',
        'elk.direction': elkDirection,
        'elk.spacing.nodeNode': '80',
        'elk.mrtree.spacing.nodeNodeBetweenLayers': '120',
      },
      children: nodes.map(n => ({
        id: n.id,
        width: n.width,
        height: n.height,
      })),
      edges: edges.map((e, i) => ({
        id: `e${i}`,
        sources: [e.source],
        targets: [e.target],
      })),
    };

    const result = await this.elk.layout(elkGraph);

    const positions = new Map<string, { x: number; y: number }>();
    if (result.children) {
      for (const child of result.children) {
        positions.set(child.id, {
          x: offsetX + (child.x || 0),
          y: offsetY + (child.y || 0),
        });
      }
    }
    return { positions };
  }
}

// === Custom Engine (wraps existing improvedAutoLayout) ===

export type ImprovedAutoLayoutFn = (
  nodes: { id: string }[],
  edges: { from: string; to: string }[],
  direction: 'TB' | 'LR',
  offsetX: number,
  offsetY: number
) => Map<string, { x: number; y: number }>;

let improvedAutoLayoutFn: ImprovedAutoLayoutFn | null = null;

export function registerCustomLayoutFn(fn: ImprovedAutoLayoutFn): void {
  improvedAutoLayoutFn = fn;
}

class CustomLayoutEngine implements LayoutEngine {
  id = 'custom';
  name = 'Custom (BFS)';
  group = 'hierarchical';
  supportsDirection = true;

  async execute(
    nodes: LayoutNodeInput[],
    edges: LayoutEdgeInput[],
    direction: LayoutDirection,
    offsetX: number,
    offsetY: number
  ): Promise<LayoutResult> {
    if (!improvedAutoLayoutFn) {
      return { positions: new Map() };
    }
    const edgesConverted = edges.map(e => ({ from: e.source, to: e.target }));
    const positions = improvedAutoLayoutFn(nodes, edgesConverted, direction, offsetX, offsetY);
    return { positions };
  }
}

// === Engine Registry ===

const engines: LayoutEngine[] = [
  new DagreLayoutEngine(),
  new ElkLayeredEngine(),
  new CustomLayoutEngine(),
  new ElkMrTreeEngine(),
];

export function getEngine(id: string): LayoutEngine {
  return engines.find(e => e.id === id) || engines[0];
}

export function getAllEngines(): LayoutEngine[] {
  return engines;
}

/**
 * Quick dagre layout for initial data loading (synchronous-style)
 */
export async function dagreQuickLayout(
  nodes: { id: string; width?: number; height?: number }[],
  edges: { from: string; to: string }[]
): Promise<Map<string, { x: number; y: number }>> {
  const engine = new DagreLayoutEngine();
  const layoutNodes = nodes.map(n => ({
    id: n.id,
    width: n.width || 180,
    height: n.height || 60,
  }));
  const layoutEdges = edges.map(e => ({
    source: e.from,
    target: e.to,
  }));
  const result = await engine.execute(layoutNodes, layoutEdges, 'TB', 100, 100);
  return result.positions;
}
