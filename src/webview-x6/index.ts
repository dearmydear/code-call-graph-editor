import { Graph, Shape, Cell, Node, Edge } from '@antv/x6';
import { Selection } from '@antv/x6-plugin-selection';
import { Snapline } from '@antv/x6-plugin-snapline';
import { Keyboard } from '@antv/x6-plugin-keyboard';
import { Clipboard } from '@antv/x6-plugin-clipboard';
import { History } from '@antv/x6-plugin-history';
import { renderMarkdown, toggleCheckbox, markdownStyles } from './markdownRenderer';
import { initI18n, t } from './i18n';
import { getEngine, getAllEngines, registerCustomLayoutFn, dagreQuickLayout } from './layoutEngines';
import type { LayoutNodeInput, LayoutEdgeInput } from './layoutEngines';
import dagre from '@dagrejs/dagre';

// 声明 VS Code API
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// CallGraph 数据结构
interface CallGraphNode {
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
  content?: string;  // Markdown 内容（note 节点使用）
  tags?: string[];
  status?: 'normal' | 'broken';
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  displayTags?: string[];  // 运行时计算的显示标签
}

interface CallGraphEdge {
  from: string;
  to: string;
  type?: 'call' | 'explain';
}

interface CallGraphData {
  title?: string;
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

interface TagConfig {
  predefinedTags: { name: string; color: string }[];
  showFileNameTag: boolean;
  fileNameTagColor: string;
  codeNodeColor: { fill: string; stroke: string };
  noteNodeColor: { fill: string; stroke: string };
  unboundCodeNodeColor: { fill: string; stroke: string };
}

let graph: Graph | null = null;
let currentData: CallGraphData | null = null;
let isInitializing = false;  // 标记是否正在初始化
let lastReceivedText = '';   // 上次收到的文档文本，用于去重
let contextMenu: HTMLElement | null = null;  // 右键菜单元素
let rightMouseDownPos: { x: number; y: number } | null = null;  // 右键按下位置，用于判断是点击还是拖动
let editingNode: Node | null = null;  // 当前正在编辑的节点
let editingOriginalText = '';  // 编辑前的原始文本
let editingEdge: Edge | null = null;  // 当前正在编辑的边
let nodeToolbar: HTMLElement | null = null;  // 节点工具栏
let nodeToolbarTimer: number = 0;  // 节点工具栏自动隐藏计时器
let isConnectingMode = false;  // 是否处于连接模式
let connectingSourceNode: Node | null = null;  // 连接模式的起始节点
let connectingHoverNode: Node | null = null;  // 连接模式下悬停的节点
let connectingLine: SVGLineElement | null = null;  // 连接模式的预览线
let connectingArrow: SVGPolygonElement | null = null;  // 连接线箭头
let selectedEdge: Edge | null = null;  // 当前选中的边
let alignmentToolbar: HTMLElement | null = null;  // 多选对齐工具栏
let autoLayoutBar: HTMLElement | null = null;  // 常驻自动布局按钮
let layoutDirection: 'TB' | 'LR' = 'TB';  // 布局方向
let currentLayoutAlgorithm = 'dagre';  // 当前布局算法

// ---- Tooltip 状态 ----
let tooltipEl: HTMLElement | null = null;      // tooltip DOM 元素
let tooltipTimer: number = 0;                  // 悬停延迟计时器
let tooltipCurrentNode: Node | null = null;    // 当前悬停的节点
const TOOLTIP_DELAY = 500;                     // 悬停延迟 (ms)

// 根据布局方向返回 manhattan router 的方向约束
function getRouterDirections(): { startDirections: string[]; endDirections: string[] } {
  if (layoutDirection === 'LR') {
    return { startDirections: ['right'], endDirections: ['left'] };
  }
  // TB (默认)
  return { startDirections: ['bottom'], endDirections: ['top'] };
}

// 刷新所有现有边的 router 配置（方向切换时调用）
function refreshEdgeRouters() {
  if (!graph) return;
  const dirs = getRouterDirections();
  graph.startBatch('refresh-routers');
  for (const edge of graph.getEdges()) {
    edge.setRouter({
      name: 'manhattan',
      args: {
        ...dirs,
        padding: 30,
      },
    });
  }
  graph.stopBatch('refresh-routers');
}

// 高亮选中节点关联的边，恢复非关联边的默认样式
function highlightConnectedEdges() {
  if (!graph) return;

  const selectedNodeIds = new Set(
    graph.getSelectedCells().filter(c => c.isNode()).map(c => c.id)
  );

  for (const edge of graph.getEdges()) {
    // 跳过被直接选中的边（由 edge:selected 管理）
    if (edge === selectedEdge) continue;

    const sourceId = edge.getSourceCellId();
    const targetId = edge.getTargetCellId();
    const isConnected = selectedNodeIds.has(sourceId) || selectedNodeIds.has(targetId);

    if (isConnected && selectedNodeIds.size > 0) {
      edge.attr('line/stroke', '#00aaff');
      edge.attr('line/strokeWidth', 3);
      edge.setZIndex(1);  // 高亮边渲染在默认边之上
    } else {
      // 恢复默认样式
      const data = edge.getData() || {};
      edge.attr('line/stroke', data.type === 'explain' ? '#FFC107' : '#8a8a8a');
      edge.attr('line/strokeWidth', 2);
      edge.setZIndex(0);
    }
  }
}

let tagConfig: TagConfig = {
  predefinedTags: [
    { name: '入口', color: '#4CAF50' },
    { name: '异步', color: '#2196F3' },
    { name: '循环', color: '#FF9800' },
    { name: '判断', color: '#9C27B0' },
    { name: '工具', color: '#00BCD4' },
    { name: '重要', color: '#F44336' },
  ],
  showFileNameTag: false,
  fileNameTagColor: '#607D8B',
  codeNodeColor: { fill: '#1e3a5f', stroke: '#4a9eff' },
  noteNodeColor: { fill: '#1A1A1A', stroke: '#555555' },
  unboundCodeNodeColor: { fill: '#3d2020', stroke: '#d48a8a' },
};

// 获取节点颜色（根据类型、状态和是否绑定）
function getNodeColors(isNote: boolean, isBroken: boolean, hasSymbol: boolean): { fill: string; stroke: string } {
  if (isBroken) {
    return { fill: '#3d2020', stroke: '#f44336' };
  }
  if (isNote) {
    return tagConfig.noteNodeColor;
  }
  // code 节点：检查是否绑定了 symbol
  if (!hasSymbol) {
    return tagConfig.unboundCodeNodeColor;
  }
  return tagConfig.codeNodeColor;
}

// 获取节点边框颜色（根据类型和状态）- 保留兼容性
function getNodeStrokeColor(isNote: boolean, isBroken: boolean): string {
  if (isBroken) return '#f44336';
  const colors = isNote ? tagConfig.noteNodeColor : tagConfig.codeNodeColor;
  return colors.stroke;
}

// 子菜单元素
let subMenu: HTMLElement | null = null;

// 生成唯一 ID
function generateUniqueId(): string {
  return `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Note 节点默认尺寸
const NOTE_DEFAULT_WIDTH = 240;
const NOTE_DEFAULT_HEIGHT = 160;
const NOTE_MIN_WIDTH = 120;
const NOTE_MIN_HEIGHT = 80;

// 创建节点的通用函数
function createNode(x: number, y: number, type: 'code' | 'note', label?: string): Node | null {
  if (!graph) return null;

  const id = generateUniqueId();
  const isNote = type === 'note';

  // 使用配置的节点颜色（新建的 code 节点没有 symbol，显示警告色）
  const nodeColors = getNodeColors(isNote, false, isNote); // note 节点不需要 symbol

  if (isNote) {
    // Note 节点使用 note-node 形状，支持 Markdown 渲染
    const displayLabel = label || '';
    const defaultContent = displayLabel || t('defaults.noteContent');
    const node = graph.addNode({
      id,
      shape: 'note-node',
      x,
      y,
      width: NOTE_DEFAULT_WIDTH,
      height: NOTE_DEFAULT_HEIGHT,
      attrs: {
        body: {
          fill: nodeColors.fill,
          stroke: nodeColors.stroke,
          strokeWidth: 2,
          rx: 8,
          ry: 8,
        },
      },
      data: {
        id,
        label: displayLabel || t('defaults.newNote'),
        type,
        content: defaultContent,
        status: 'normal',
        tags: [],
        displayTags: [],
        width: NOTE_DEFAULT_WIDTH,
        height: NOTE_DEFAULT_HEIGHT,
      },
    });

    // 渲染 Markdown 内容
    setTimeout(() => renderNoteNode(node), 50);

    console.log(`[创建节点] id: ${id}, type: note, position: (${x}, ${y})`);
    return node;
  } else {
    // Code 节点使用 tag-node 形状
    const displayLabel = label || t('defaults.newCode');
    const node = graph.addNode({
      id,
      shape: 'tag-node',
      x,
      y,
      width: 180,
      height: 60,
      attrs: {
        body: {
          fill: nodeColors.fill,
          stroke: nodeColors.stroke,
          strokeWidth: 2,
          rx: 6,
          ry: 6,
          width: 180,
          height: 60,
        },
        label: {
          text: displayLabel,
          fill: '#d4d4d4',
          fontSize: 13,
          textAnchor: 'middle',
          textVerticalAnchor: 'middle',
          refX: 0.5,
          refY: 0.5,
        },
        fo: {
          visibility: 'hidden',
        },
        tagsContainer: {
          innerHTML: '',
        },
      },
      data: {
        id,
        label: displayLabel,
        type,
        status: 'normal',
        tags: [],
        displayTags: [],
      },
    });

    console.log(`[创建节点] id: ${id}, type: code, position: (${x}, ${y})`);
    return node;
  }
}

// 菜单项接口（支持子菜单）
interface MenuItem {
  label: string;
  action?: () => void;
  subItems?: MenuItem[];
  checked?: boolean;
  colorDot?: string;  // 标签颜色圆点
}

// 创建右键菜单 DOM 元素
function createContextMenu(): HTMLElement {
  if (contextMenu) return contextMenu;

  contextMenu = document.createElement('div');
  contextMenu.id = 'context-menu';
  contextMenu.style.cssText = `
    position: fixed;
    background: #252526;
    border: 1px solid #454545;
    border-radius: 4px;
    padding: 4px 0;
    min-width: 150px;
    z-index: 10000;
    display: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    font-size: 13px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  document.body.appendChild(contextMenu);
  return contextMenu;
}

// 创建子菜单 DOM 元素
function createSubMenu(): HTMLElement {
  if (subMenu) return subMenu;

  subMenu = document.createElement('div');
  subMenu.id = 'sub-menu';
  subMenu.style.cssText = `
    position: fixed;
    background: #252526;
    border: 1px solid #454545;
    border-radius: 4px;
    padding: 4px 0;
    min-width: 120px;
    z-index: 10001;
    display: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    font-size: 13px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  document.body.appendChild(subMenu);
  return subMenu;
}

// 隐藏子菜单
function hideSubMenu() {
  if (subMenu) {
    subMenu.style.display = 'none';
  }
}

// 显示子菜单
function showSubMenu(parentItem: HTMLElement, items: MenuItem[]) {
  const menu = createSubMenu();
  menu.innerHTML = '';

  items.forEach((item) => {
    const menuItem = document.createElement('div');
    menuItem.style.cssText = `
      padding: 6px 20px;
      cursor: pointer;
      color: #cccccc;
      display: flex;
      align-items: center;
      gap: 8px;
    `;

    // 勾选标记
    if (item.checked !== undefined) {
      const check = document.createElement('span');
      check.textContent = item.checked ? '✓' : '';
      check.style.cssText = `width: 14px; font-size: 12px;`;
      menuItem.appendChild(check);
    }

    // 颜色圆点
    if (item.colorDot) {
      const dot = document.createElement('span');
      dot.style.cssText = `
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: ${item.colorDot};
        flex-shrink: 0;
      `;
      menuItem.appendChild(dot);
    }

    // 标签文字
    const labelSpan = document.createElement('span');
    labelSpan.textContent = item.label;
    menuItem.appendChild(labelSpan);

    menuItem.addEventListener('mouseenter', () => {
      menuItem.style.background = '#094771';
    });
    menuItem.addEventListener('mouseleave', () => {
      menuItem.style.background = 'transparent';
    });
    if (item.action) {
      menuItem.addEventListener('click', () => {
        item.action!();
        hideContextMenu();
        hideSubMenu();
      });
    }
    menu.appendChild(menuItem);
  });

  // 定位子菜单在父菜单项右侧
  const parentRect = parentItem.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  menu.style.display = 'block';
  const menuRect = menu.getBoundingClientRect();

  let finalX = parentRect.right + 2;
  let finalY = parentRect.top;

  // 如果超出右边界，显示在左侧
  if (finalX + menuRect.width > viewportWidth) {
    finalX = parentRect.left - menuRect.width - 2;
  }
  // 如果超出下边界，向上调整
  if (finalY + menuRect.height > viewportHeight) {
    finalY = viewportHeight - menuRect.height - 5;
  }

  menu.style.left = `${finalX}px`;
  menu.style.top = `${finalY}px`;
}

// 显示右键菜单（支持子菜单）
function showContextMenu(x: number, y: number, items: MenuItem[]) {
  const menu = createContextMenu();
  menu.innerHTML = '';
  hideSubMenu();

  items.forEach((item) => {
    const menuItem = document.createElement('div');
    menuItem.style.cssText = `
      padding: 6px 20px;
      cursor: pointer;
      color: #cccccc;
      display: flex;
      align-items: center;
      justify-content: space-between;
    `;

    const labelSpan = document.createElement('span');
    labelSpan.textContent = item.label;
    menuItem.appendChild(labelSpan);

    // 如果有子菜单，显示箭头
    if (item.subItems && item.subItems.length > 0) {
      const arrow = document.createElement('span');
      arrow.textContent = '▶';
      arrow.style.cssText = `font-size: 10px; margin-left: 10px;`;
      menuItem.appendChild(arrow);
    }

    menuItem.addEventListener('mouseenter', () => {
      menuItem.style.background = '#094771';
      if (item.subItems && item.subItems.length > 0) {
        showSubMenu(menuItem, item.subItems);
      } else {
        hideSubMenu();
      }
    });
    menuItem.addEventListener('mouseleave', () => {
      menuItem.style.background = 'transparent';
    });

    if (item.action && !item.subItems) {
      menuItem.addEventListener('click', () => {
        item.action!();
        hideContextMenu();
        hideSubMenu();
      });
    }
    menu.appendChild(menuItem);
  });

  // 确保菜单不超出视口
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  menu.style.display = 'block';
  const menuRect = menu.getBoundingClientRect();
  
  let finalX = x;
  let finalY = y;
  
  if (x + menuRect.width > viewportWidth) {
    finalX = viewportWidth - menuRect.width - 5;
  }
  if (y + menuRect.height > viewportHeight) {
    finalY = viewportHeight - menuRect.height - 5;
  }

  menu.style.left = `${finalX}px`;
  menu.style.top = `${finalY}px`;
}

// 隐藏右键菜单
function hideContextMenu() {
  if (contextMenu) {
    contextMenu.style.display = 'none';
  }
  hideSubMenu();
}

// 创建节点工具栏
function createNodeToolbar(): HTMLElement {
  if (nodeToolbar) return nodeToolbar;

  nodeToolbar = document.createElement('div');
  nodeToolbar.id = 'node-toolbar';
  nodeToolbar.style.cssText = `
    position: fixed;
    background: #2d2d30;
    border: 1px solid #454545;
    border-radius: 4px;
    padding: 4px;
    display: none;
    z-index: 9999;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    gap: 4px;
    flex-direction: row;
  `;

  document.body.appendChild(nodeToolbar);
  return nodeToolbar;
}

// 显示节点工具栏
function showNodeToolbar(node: Node) {
  const toolbar = createNodeToolbar();
  const data = node.getData() || {};
  const isCodeNode = data.type === 'code';

  toolbar.innerHTML = '';
  toolbar.style.display = 'flex';

  const btnStyle = `
    background: #0e639c;
    border: none;
    color: white;
    padding: 2px 6px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
  `;

  // 边连接按钮
  const connectBtn = document.createElement('button');
  connectBtn.innerHTML = '➚';
  connectBtn.title = t('toolbar.connectToNode');
  connectBtn.style.cssText = btnStyle;
  connectBtn.addEventListener('mouseenter', () => { connectBtn.style.background = '#1177bb'; });
  connectBtn.addEventListener('mouseleave', () => { connectBtn.style.background = '#0e639c'; });
  connectBtn.addEventListener('click', () => {
    startConnectingMode(node);
    hideNodeToolbar();
  });
  toolbar.appendChild(connectBtn);

  // 代码绑定按钮（仅 code 节点）
  if (isCodeNode) {
    const bindBtn = document.createElement('button');
    bindBtn.innerHTML = '📎';
    bindBtn.title = t('toolbar.bindMethod');
    bindBtn.style.cssText = btnStyle;
    bindBtn.addEventListener('mouseenter', () => { bindBtn.style.background = '#1177bb'; });
    bindBtn.addEventListener('mouseleave', () => { bindBtn.style.background = '#0e639c'; });
    bindBtn.addEventListener('click', () => {
      showMethodLibrary(node);
      hideNodeToolbar();
    });
    toolbar.appendChild(bindBtn);
  }

  // 选中所有子节点按钮
  const selectChildrenBtn = document.createElement('button');
  selectChildrenBtn.innerHTML = '⊞';
  selectChildrenBtn.title = t('toolbar.selectChildren');
  selectChildrenBtn.style.cssText = btnStyle;
  selectChildrenBtn.addEventListener('mouseenter', () => { selectChildrenBtn.style.background = '#1177bb'; });
  selectChildrenBtn.addEventListener('mouseleave', () => { selectChildrenBtn.style.background = '#0e639c'; });
  selectChildrenBtn.addEventListener('click', () => {
    selectAllDescendants(node);
    hideNodeToolbar();
  });
  toolbar.appendChild(selectChildrenBtn);

  // 计算工具栏位置（节点上方居中）
  if (!graph) return;
  const pos = node.getPosition();
  const size = node.getSize();
  const point = graph.localToPage(pos.x + size.width / 2, pos.y);

  // 先显示以获取尺寸
  toolbar.style.visibility = 'hidden';
  toolbar.style.display = 'flex';
  const toolbarRect = toolbar.getBoundingClientRect();
  toolbar.style.visibility = 'visible';

  // 居中并放在节点上方
  toolbar.style.left = `${point.x - toolbarRect.width / 2}px`;
  toolbar.style.top = `${point.y - toolbarRect.height - 8}px`;

  // 自动隐藏：3秒后隐藏工具栏
  clearTimeout(nodeToolbarTimer);
  nodeToolbarTimer = window.setTimeout(() => {
    hideNodeToolbar();
  }, 3000);
}

// 隐藏节点工具栏
function hideNodeToolbar() {
  clearTimeout(nodeToolbarTimer);
  if (nodeToolbar) {
    nodeToolbar.style.display = 'none';
  }
}

// 选中所有后代子节点（BFS 遍历）
function selectAllDescendants(node: Node) {
  if (!graph) return;

  const allEdges = graph.getEdges();
  const visited = new Set<string>();
  const queue = [node.id];
  visited.add(node.id);

  // BFS 遍历所有子节点
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const edge of allEdges) {
      const sourceId = edge.getSourceCellId();
      const targetId = edge.getTargetCellId();
      if (sourceId === parentId && !visited.has(targetId)) {
        visited.add(targetId);
        queue.push(targetId);
      }
    }
  }

  // 选中所有后代节点（包括当前节点自身）
  const nodesToSelect: Node[] = [];
  for (const nodeId of visited) {
    const cell = graph.getCellById(nodeId);
    if (cell && cell.isNode()) {
      nodesToSelect.push(cell as Node);
    }
  }

  graph.select(nodesToSelect);
}

// 开始连接模式
function startConnectingMode(sourceNode: Node) {
  isConnectingMode = true;
  connectingSourceNode = sourceNode;
  
  // 高亮源节点
  sourceNode.attr('body/stroke', '#00ff00');
  sourceNode.attr('body/strokeWidth', 3);
  
  console.log(`[连接模式] 开始连接，源节点: ${sourceNode.id}`);
  
  // 创建 SVG 覆盖层用于显示连接预览线
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'connecting-overlay';
  svg.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 9998;
  `;
  
  // 定义箭头 marker
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'arrowhead');
  marker.setAttribute('markerWidth', '10');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '3.5');
  marker.setAttribute('orient', 'auto');
  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', '0 0, 10 3.5, 0 7');
  polygon.setAttribute('fill', '#00ff00');
  marker.appendChild(polygon);
  defs.appendChild(marker);
  svg.appendChild(defs);
  
  // 创建连接线
  connectingLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  connectingLine.setAttribute('stroke', '#00ff00');
  connectingLine.setAttribute('stroke-width', '2');
  connectingLine.setAttribute('stroke-dasharray', '5,5');
  connectingLine.setAttribute('marker-end', 'url(#arrowhead)');
  
  // 设置起点为源节点中心
  if (graph) {
    const pos = sourceNode.getPosition();
    const size = sourceNode.getSize();
    const point = graph.localToPage(pos.x + size.width / 2, pos.y + size.height / 2);
    connectingLine.setAttribute('x1', String(point.x));
    connectingLine.setAttribute('y1', String(point.y));
    connectingLine.setAttribute('x2', String(point.x));
    connectingLine.setAttribute('y2', String(point.y));
  }
  
  svg.appendChild(connectingLine);
  document.body.appendChild(svg);
  
  // 添加鼠标移动监听
  document.addEventListener('mousemove', updateConnectingLine);
  
  // 显示提示
  const tip = document.createElement('div');
  tip.id = 'connect-tip';
  tip.textContent = t('connectMode.clickTarget');
  tip.style.cssText = `
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    background: #00aa00;
    color: white;
    padding: 8px 16px;
    border-radius: 4px;
    z-index: 10000;
    font-size: 13px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  `;
  document.body.appendChild(tip);
}

// 更新连接线终点
function updateConnectingLine(e: MouseEvent) {
  if (connectingLine) {
    connectingLine.setAttribute('x2', String(e.clientX));
    connectingLine.setAttribute('y2', String(e.clientY));
  }
}

// 取消连接模式
function cancelConnectingMode() {
  if (!isConnectingMode || !connectingSourceNode) return;

  // 恢复源节点样式
  const data = connectingSourceNode.getData() || {};
  const isNote = data.type === 'note';
  const isBroken = data.status === 'broken';
  connectingSourceNode.attr('body/stroke', getNodeStrokeColor(isNote, isBroken));
  connectingSourceNode.attr('body/strokeWidth', 2);

  // 恢复悬停节点样式
  if (connectingHoverNode) {
    const hoverData = connectingHoverNode.getData() || {};
    const hoverIsNote = hoverData.type === 'note';
    const hoverIsBroken = hoverData.status === 'broken';
    connectingHoverNode.attr('body/stroke', getNodeStrokeColor(hoverIsNote, hoverIsBroken));
    connectingHoverNode.attr('body/strokeWidth', 2);
    connectingHoverNode = null;
  }
  
  isConnectingMode = false;
  connectingSourceNode = null;
  
  // 移除预览线
  const overlay = document.getElementById('connecting-overlay');
  if (overlay) overlay.remove();
  connectingLine = null;
  
  // 移除鼠标监听
  document.removeEventListener('mousemove', updateConnectingLine);
  
  // 移除提示
  const tip = document.getElementById('connect-tip');
  if (tip) tip.remove();
  
  console.log('[连接模式] 已取消');
}

// 完成连接
function completeConnection(targetNode: Node) {
  if (!isConnectingMode || !connectingSourceNode || !graph) return;
  
  // 不能连接到自己
  if (connectingSourceNode.id === targetNode.id) {
    console.log('[连接模式] 不能连接到自己');
    cancelConnectingMode();
    return;
  }
  
  // 创建边
  graph.addEdge({
    source: connectingSourceNode.id,
    target: targetNode.id,
    connector: { name: 'rounded', args: { radius: 8 } },
    router: {
      name: 'manhattan',
      args: {
        ...getRouterDirections(),
        padding: 0,
      },
    },
    attrs: {
      line: {
        stroke: '#8a8a8a',
        strokeWidth: 2,
        targetMarker: {
          name: 'block',
          width: 12,
          height: 8,
        },
      },
    },
    data: { type: 'call' },
  });
  
  console.log(`[连接模式] 完成连接: ${connectingSourceNode.id} -> ${targetNode.id}`);
  
  // 恢复样式并退出连接模式
  cancelConnectingMode();
  notifyDocumentChanged();
}

// 显示方法库 - 请求扩展弹出方法库选择
function showMethodLibrary(node: Node) {
  console.log(`[方法库] 请求为节点 ${node.id} 绑定方法`);

  // 发送消息给扩展，请求显示方法库
  vscode.postMessage({
    type: 'requestMethodLibrary',
    nodeId: node.id,
  });
}

// 开始编辑边 label
function startEditingEdge(edge: Edge, clearText: boolean = false, selectAll: boolean = false, initialChar?: string) {
  if (!graph) return;

  // 保存原始状态
  editingEdge = edge;
  editingOriginalText = edge.getLabelAt(0)?.attrs?.label?.text as string || '';

  // 获取边的中点位置
  const view = graph.findViewByCell(edge);
  if (!view) return;
  
  const path = view.container.querySelector('path');
  if (!path) return;
  
  const pathLength = (path as SVGPathElement).getTotalLength();
  const midPoint = (path as SVGPathElement).getPointAtLength(pathLength / 2);
  const point = graph.localToPage(midPoint.x, midPoint.y);

  // 创建输入框（单行，回车/失焦结束）
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'edge-text-editor';
  input.style.cssText = `
    position: fixed;
    left: ${point.x - 75}px;
    top: ${point.y - 15}px;
    width: 150px;
    height: 30px;
    background: #1e1e1e;
    border: 2px solid #007acc;
    color: #d4d4d4;
    font-size: 13px;
    text-align: center;
    outline: none;
    z-index: 10000;
    border-radius: 4px;
    box-sizing: border-box;
    padding: 0 8px;
  `;

  // 设置初始值
  if (clearText && initialChar) {
    input.value = initialChar;
  } else if (clearText) {
    input.value = '';
  } else {
    input.value = editingOriginalText;
  }

  document.body.appendChild(input);
  input.focus();

  // 全选或移到末尾
  if (selectAll && !clearText) {
    input.select();
  } else if (initialChar) {
    input.setSelectionRange(input.value.length, input.value.length);
  }

  // 完成编辑
  function finishEditing(save: boolean) {
    if (!editingEdge) return;

    if (save) {
      const newText = input.value.trim();
      if (newText) {
        editingEdge.setLabels([
          {
            attrs: {
              label: {
                text: newText,
                fill: '#cccccc',
                fontSize: 12,
              },
              rect: {
                fill: '#1e1e1e',
                stroke: '#0e639c',
                strokeWidth: 1,
                rx: 3,
                ry: 3,
              },
            },
          },
        ]);
      } else {
        // 清空 label
        editingEdge.setLabels([]);
      }
      
      console.log(`[编辑完成] 边: ${editingEdge.id}, 新文本: ${newText}`);
      notifyDocumentChanged();
    }

    // 清理
    input.remove();
    editingEdge = null;
    editingOriginalText = '';
  }

  // 事件监听
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Enter: 完成编辑
      e.preventDefault();
      finishEditing(true);
    } else if (e.key === 'Escape') {
      // Esc: 取消编辑
      e.preventDefault();
      finishEditing(false);
    }
  });

  input.addEventListener('blur', () => {
    // 失去焦点: 完成编辑
    finishEditing(true);
  });
}

// 开始编辑节点文本
function startEditingNode(node: Node, clearText: boolean = false, selectAll: boolean = false, initialChar?: string) {
  if (!graph) return;

  const data = node.getData() || {};
  const isNote = data.type === 'note';

  // Note 节点使用 Markdown 编辑器
  if (isNote) {
    startEditingNoteNode(node, clearText, initialChar);
    return;
  }

  // 保存原始状态
  editingNode = node;
  editingOriginalText = node.attr('label/text') as string || '';

  // 获取节点位置和大小
  const pos = node.getPosition();
  const size = node.getSize();
  const graphContainer = document.getElementById('graph-container');
  if (!graphContainer) return;

  // 获取缩放比例
  const zoom = graph.zoom();

  // 转换为屏幕坐标
  const point = graph.localToPage(pos.x, pos.y);

  // 计算实际屏幕尺寸（考虑缩放）
  const actualWidth = size.width * zoom;
  const actualHeight = size.height * zoom;

  // 创建多行文本框（支持换行）
  const textarea = document.createElement('textarea');
  textarea.id = 'node-text-editor';
  textarea.style.cssText = `
    position: fixed;
    left: ${point.x}px;
    top: ${point.y}px;
    width: ${actualWidth}px;
    height: ${actualHeight}px;
    background: #1e1e1e;
    border: 2px solid #007acc;
    color: #d4d4d4;
    font-size: ${13 * zoom}px;
    text-align: center;
    outline: none;
    z-index: 10000;
    border-radius: ${6 * zoom}px;
    box-sizing: border-box;
    padding: ${8 * zoom}px;
    resize: none;
    font-family: inherit;
    line-height: 1.4;
  `;

  // 设置初始值
  if (clearText && initialChar) {
    textarea.value = initialChar;
  } else if (clearText) {
    textarea.value = '';
  } else {
    textarea.value = editingOriginalText;
  }

  document.body.appendChild(textarea);
  textarea.focus();

  // 全选或移到末尾
  if (selectAll && !clearText) {
    textarea.select();
  } else if (initialChar) {
    // 光标移到末尾
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  // 完成编辑
  function finishEditing(save: boolean) {
    if (!editingNode) return;

    if (save) {
      const newText = textarea.value.trim() || editingOriginalText;
      editingNode.attr('label/text', newText);
      
      // 更新 data
      const data = editingNode.getData() || {};
      data.label = newText;
      editingNode.setData(data);
      
      console.log(`[编辑完成] 节点: ${editingNode.id}, 新文本: ${newText}`);
      notifyDocumentChanged();
    } else {
      // 取消编辑，恢复原文本
      editingNode.attr('label/text', editingOriginalText);
    }

    // 清理
    textarea.remove();
    editingNode = null;
    editingOriginalText = '';
  }

  // 事件监听
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Esc: 取消编辑
      e.preventDefault();
      finishEditing(false);
    }
    // Enter 正常换行，不做特殊处理
  });

  textarea.addEventListener('blur', () => {
    // 失去焦点: 完成编辑
    finishEditing(true);
  });
}

// Note 节点 Markdown 编辑
function startEditingNoteNode(node: Node, clearText: boolean = false, initialChar?: string) {
  if (!graph) return;

  const data = node.getData() || {};
  const originalContent = data.content || '';

  editingNode = node;
  editingOriginalText = originalContent;

  // 获取节点位置和大小
  const pos = node.getPosition();
  const size = node.getSize();
  const zoom = graph.zoom();
  const point = graph.localToPage(pos.x, pos.y);
  const actualWidth = size.width * zoom;
  const actualHeight = size.height * zoom;

  // 创建编辑区域
  const textarea = document.createElement('textarea');
  textarea.id = 'note-text-editor';
  textarea.style.cssText = `
    position: fixed;
    left: ${point.x}px;
    top: ${point.y}px;
    width: ${actualWidth}px;
    height: ${actualHeight}px;
    background: #1A1A1A;
    border: 2px solid #555555;
    color: #d4d4d4;
    font-size: ${12 * zoom}px;
    text-align: left;
    outline: none;
    z-index: 10000;
    border-radius: ${8 * zoom}px;
    box-sizing: border-box;
    padding: ${8 * zoom}px;
    resize: none;
    font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
    line-height: 1.5;
    overflow: auto;
    tab-size: 2;
    white-space: pre-wrap;
  `;

  // 设置初始值
  if (clearText && initialChar) {
    textarea.value = initialChar;
  } else if (clearText) {
    textarea.value = '';
  } else {
    textarea.value = originalContent;
  }

  document.body.appendChild(textarea);
  textarea.focus();

  // 光标位置
  if (initialChar) {
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  } else {
    textarea.select();
  }

  function finishEditing(save: boolean) {
    if (!editingNode) return;

    if (save) {
      const newContent = textarea.value;
      const nodeData = editingNode.getData() || {};
      nodeData.content = newContent;
      // 更新 label 为内容的第一行（用于搜索/索引）
      const firstLine = newContent.split('\n')[0].replace(/^#+\s*/, '').trim();
      nodeData.label = firstLine || t('defaults.newNote');
      editingNode.setData(nodeData);

      // 重新渲染 Markdown
      renderNoteNode(editingNode);

      console.log(`[Note编辑完成] 节点: ${editingNode.id}`);
      notifyDocumentChanged();
    }

    textarea.remove();
    editingNode = null;
    editingOriginalText = '';
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finishEditing(false);
    }
    // Tab 键插入缩进
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
    }
  });

  textarea.addEventListener('blur', () => {
    finishEditing(true);
  });
}

// 渲染 Note 节点的 Markdown 内容
function renderNoteNode(node: Node) {
  if (!graph) return;
  const data = node.getData() || {};
  const content = data.content || '';
  const html = renderMarkdown(content);

  // 查找节点的 DOM 元素
  const view = graph.findViewByCell(node);
  if (!view) return;

  const foEl = view.container.querySelector('.note-fo') as HTMLElement;
  if (!foEl) return;

  const mdDiv = foEl.querySelector('.md-content') as HTMLElement;
  if (mdDiv) {
    mdDiv.innerHTML = html;
    // 绑定 checkbox 点击事件
    bindCheckboxEvents(node, mdDiv);
  }
}

// 绑定 checkbox 点击事件
function bindCheckboxEvents(node: Node, container: HTMLElement) {
  const checkboxes = container.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach((cb, index) => {
    (cb as HTMLInputElement).addEventListener('change', (e) => {
      e.stopPropagation();
      const data = node.getData() || {};
      const newContent = toggleCheckbox(data.content || '', index);
      data.content = newContent;
      node.setData(data);

      // 重新渲染
      renderNoteNode(node);
      notifyDocumentChanged();

      console.log(`[Checkbox] 节点 ${node.id}, checkbox ${index} 切换`);
    });
  });
}

// 注册自定义节点（无端口）
Shape.Rect.define({
  shape: 'code-node',
  width: 180,
  height: 60,
  attrs: {
    body: {
      fill: '#1e1e1e',
      stroke: '#0e639c',
      strokeWidth: 2,
      rx: 6,
      ry: 6,
    },
    label: {
      fontSize: 13,
      fill: '#d4d4d4',
      textAnchor: 'middle',
      textVerticalAnchor: 'middle',
    },
  },
});

// 注册带标签的 HTML 节点
Graph.registerNode('tag-node', {
  inherit: 'rect',
  width: 180,
  height: 60,
  markup: [
    {
      tagName: 'rect',
      selector: 'body',
    },
    {
      tagName: 'text',
      selector: 'label',
    },
    {
      tagName: 'foreignObject',
      selector: 'fo',
      children: [
        {
          ns: 'http://www.w3.org/1999/xhtml',
          tagName: 'div',
          selector: 'tagsContainer',
          className: 'tags-container',
        },
      ],
    },
  ],
  attrs: {
    body: {
      fill: '#1e1e1e',
      stroke: '#0e639c',
      strokeWidth: 2,
      rx: 6,
      ry: 6,
    },
    label: {
      fontSize: 13,
      fill: '#d4d4d4',
      textAnchor: 'middle',
      textVerticalAnchor: 'middle',
      refX: 0.5,
      refY: 0.35,
    },
    fo: {
      refWidth: '100%',
      height: 24,
      y: 50,  // 使用绝对像素位置
      x: 0,
    },
    tagsContainer: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '4px',
        flexWrap: 'wrap',
        overflow: 'hidden',
        pointerEvents: 'none',
      },
    },
  },
});

// 注册 note-node 自定义节点 （支持 foreignObject 渲染 Markdown）
Graph.registerNode('note-node', {
  inherit: 'rect',
  width: NOTE_DEFAULT_WIDTH,
  height: NOTE_DEFAULT_HEIGHT,
  markup: [
    {
      tagName: 'rect',
      selector: 'body',
    },
    {
      tagName: 'foreignObject',
      selector: 'noteFo',
      className: 'note-fo',
      attrs: {
        width: '100%',
        height: '100%',
      },
      children: [
        {
          ns: 'http://www.w3.org/1999/xhtml',
          tagName: 'div',
          selector: 'mdContainer',
          className: 'md-content',
        },
      ],
    },
  ],
  attrs: {
    body: {
      fill: '#1A1A1A',
      stroke: '#555555',
      strokeWidth: 2,
      rx: 8,
      ry: 8,
    },
    noteFo: {
      refWidth: '100%',
      refHeight: '100%',
      x: 0,
      y: 0,
    },
  },
});

// 注入 Markdown 渲染样式
function injectMarkdownStyles() {
  if (document.getElementById('md-styles')) return;
  const style = document.createElement('style');
  style.id = 'md-styles';
  style.textContent = markdownStyles;
  document.head.appendChild(style);
}

// 生成标签 HTML（只显示用户标签，不显示文件名标签）
function generateTagsHtml(tags: string[]): string {
  if (!tags || tags.length === 0) return '';

  return tags.map((tag) => {
    const color = getTagColor(tag);
    return `<span style="
      background: ${color};
      color: white;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      white-space: nowrap;
      max-width: 80px;
      overflow: hidden;
      text-overflow: ellipsis;
    ">${escapeHtml(tag)}</span>`;
  }).join('');
}

// HTML 转义
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// Tooltip 功能：悬停代码节点 500ms 后显示详情
// ============================================================

/** 创建 tooltip DOM 元素（懒初始化） */
function ensureTooltipElement(): HTMLElement {
  if (tooltipEl) { return tooltipEl; }

  const el = document.createElement('div');
  el.className = 'cg-tooltip';
  el.style.cssText = `
    position: fixed;
    display: none;
    pointer-events: none;
    z-index: 10000;
    max-width: 420px;
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
    background: var(--vscode-editorHoverWidget-background, #2d2d2d);
    color: var(--vscode-editorHoverWidget-foreground, #cccccc);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
  `;
  document.body.appendChild(el);
  tooltipEl = el;
  return el;
}

/** 开始 tooltip 计时器，延迟后显示 */
function startTooltipTimer(node: Node, clientX: number, clientY: number) {
  cancelTooltip();
  tooltipCurrentNode = node;

  const data = node.getData() as CallGraphNode | undefined;
  // 只对 code 节点显示 tooltip（note 节点内容太长且已直接可见）
  if (!data || data.type === 'note') { return; }

  tooltipTimer = window.setTimeout(() => {
    showTooltip(node, data, clientX, clientY);
  }, TOOLTIP_DELAY);
}

/** 取消 tooltip 计时器并隐藏 */
function cancelTooltip() {
  if (tooltipTimer) {
    clearTimeout(tooltipTimer);
    tooltipTimer = 0;
  }
  tooltipCurrentNode = null;
  if (tooltipEl) {
    tooltipEl.style.display = 'none';
  }
}

/** 显示 tooltip */
function showTooltip(node: Node, data: CallGraphNode, mouseX: number, mouseY: number) {
  // 如果正在编辑节点或连接模式，不显示
  if (editingNode || isConnectingMode) { return; }
  // 如果鼠标已离开节点，不显示
  if (tooltipCurrentNode !== node) { return; }

  const el = ensureTooltipElement();
  const sym = data.symbol;

  // 构建 tooltip 内容
  const lines: string[] = [];

  // 方法名
  const displayName = data.label || sym?.name || node.id;
  // 如果 label 包含 \n，拆分为 方法名 和 类名
  const labelParts = displayName.split('\n');
  if (labelParts.length >= 2) {
    lines.push(`📦 ${labelParts[1]}.${labelParts[0]}`);
  } else {
    lines.push(`🔹 ${labelParts[0]}`);
  }

  if (sym) {
    // 签名
    if (sym.signature) {
      lines.push(`📝 ${sym.name}${sym.signature}`);
    }

    // 文件路径 + 行号
    if (sym.uri) {
      const lineStr = sym.line !== undefined ? `:${sym.line + 1}` : '';
      lines.push(`📄 ${sym.uri}${lineStr}`);
    }
  }

  // 状态
  if (data.status === 'broken') {
    lines.push('⚠️ 符号已失效');
  } else if (!sym) {
    lines.push('⚠️ 未绑定代码');
  }

  // 标签
  if (data.tags && data.tags.length > 0) {
    lines.push(`🏷️ ${data.tags.join(', ')}`);
  }

  el.textContent = lines.join('\n');
  el.style.display = 'block';

  // 定位：显示在鼠标下方偏右，避免超出视口
  const margin = 12;
  let left = mouseX + margin;
  let top = mouseY + margin;

  // 防止右侧超出
  if (left + el.offsetWidth > window.innerWidth - margin) {
    left = mouseX - el.offsetWidth - margin;
  }
  // 防止底部超出
  if (top + el.offsetHeight > window.innerHeight - margin) {
    top = mouseY - el.offsetHeight - margin;
  }

  el.style.left = `${Math.max(0, left)}px`;
  el.style.top = `${Math.max(0, top)}px`;
}

// 更新节点的标签 DOM
function updateNodeTagsDom(node: Node, displayTags?: string[]) {
  const view = graph?.findViewByCell(node);
  if (!view) {
    console.log(`[updateNodeTagsDom] 找不到节点视图: ${node.id}`);
    return;
  }
  
  // 如果没有传入 displayTags，则从节点数据获取
  const tags = displayTags ?? (node.getData() as CallGraphNode)?.displayTags ?? [];
  
  // 找到 tagsContainer 元素
  const container = view.container.querySelector('.tags-container') as HTMLElement;
  if (container) {
    const html = generateTagsHtml(tags);
    container.innerHTML = html;
    console.log(`[updateNodeTagsDom] 节点: ${node.id}, 标签数: ${tags.length}, HTML长度: ${html.length}`);
  } else {
    console.log(`[updateNodeTagsDom] 找不到 .tags-container: ${node.id}`);
  }
}

// 初始化图
function initGraph() {
  // 防止重复初始化
  if (graph) {
    console.log('Graph already initialized');
    return;
  }

  const container = document.getElementById('graph-container');
  if (!container) {
    console.error('Graph container not found');
    return;
  }

  graph = new Graph({
    container,
    autoResize: true,
    background: {
      color: 'var(--vscode-editor-background, #1e1e1e)',
    },
    grid: {
      visible: true,
      type: 'dot',
      args: {
        color: '#444',
        thickness: 1,
      },
    },
    panning: {
      enabled: true,
      eventTypes: ['rightMouseDown'],  // 右键拖拽平移画布
    },
    mousewheel: {
      enabled: true,
      modifiers: [],
      minScale: 0.2,
      maxScale: 3,
    },
    connecting: {
      router: {
        name: 'manhattan',
        args: {
          ...getRouterDirections(),
          padding: 30,
        },
      },
      connector: {
        name: 'rounded',
        args: { radius: 8 },
      },
      anchor: {
        name: 'center',
        args: {
          rotate: true,
          dx: 0,
        },
      },
      connectionPoint: 'boundary',  // 边从节点边框开始
      allowBlank: false,
      snap: { 
        radius: 1,  // 设置为最小值，使用最短距离连接
      },
      createEdge() {
        return new Shape.Edge({
          attrs: {
            line: {
              stroke: '#8a8a8a',
              strokeWidth: 2,
              targetMarker: {
                name: 'block',
                width: 12,
                height: 8,
              },
            },
          },
          zIndex: 0,
        });
      },
      validateConnection({ targetMagnet }) {
        return !!targetMagnet;
      },
    },
    highlighting: {
      magnetAdsorbed: {
        name: 'stroke',
        args: {
          attrs: {
            fill: '#5F95FF',
            stroke: '#5F95FF',
          },
        },
      },
    },
    interacting: {
      nodeMovable: true,
      edgeMovable: true,
      edgeLabelMovable: true,
    },
    embedding: {
      enabled: false,
    },
  });

  // 使用插件
  graph.use(
    new Selection({
      enabled: true,
      multiple: true,
      rubberband: true,
      movable: true,
      showNodeSelectionBox: true,
      showEdgeSelectionBox: false,  // 不显示边选中的虚线框
    })
  );

  graph.use(new Snapline({ enabled: true }));
  graph.use(new Keyboard({ enabled: true }));
  graph.use(new Clipboard({ enabled: true }));
  graph.use(new History({ enabled: true }));

  // 绑定键盘事件
  graph.bindKey(['ctrl+c', 'meta+c'], () => {
    const cells = graph!.getSelectedCells();
    if (cells.length) {
      graph!.copy(cells);
    }
    return false;
  });

  graph.bindKey(['ctrl+v', 'meta+v'], () => {
    if (!graph!.isClipboardEmpty()) {
      const cells = graph!.paste({ offset: 32 });
      graph!.cleanSelection();
      graph!.select(cells);
    }
    return false;
  });

  graph.bindKey(['ctrl+z', 'meta+z'], () => {
    if (graph!.canUndo()) {
      graph!.undo();
    }
    return false;
  });

  graph.bindKey(['ctrl+shift+z', 'meta+shift+z', 'ctrl+y', 'meta+y'], () => {
    if (graph!.canRedo()) {
      graph!.redo();
    }
    return false;
  });

  graph.bindKey(['delete', 'backspace'], () => {
    // 如果正在编辑，不处理删除
    if (editingNode || editingEdge) return false;
    
    const cells = graph!.getSelectedCells();
    if (cells.length) {
      graph!.removeCells(cells);
      notifyDocumentChanged();  // 标记文档已修改
    }
    return false;
  });
  
  // Esc 键处理
  graph.bindKey('escape', () => {
    // 如果处于连接模式，取消连接
    if (isConnectingMode) {
      cancelConnectingMode();
      return false;
    }
    return true;
  });

  // F2 - 编辑选中节点（保留文本）
  graph.bindKey('f2', () => {
    const cells = graph!.getSelectedCells();
    if (cells.length === 1) {
      if (cells[0].isNode()) {
        startEditingNode(cells[0] as Node, false, false);
      } else if (cells[0].isEdge()) {
        startEditingEdge(cells[0] as Edge, false, false);
      }
    }
    return false;
  });

  // 空格 - 全选文本并编辑（节点或边）
  graph.bindKey('space', () => {
    if (editingNode || editingEdge) return false;  // 已在编辑状态
    
    const cells = graph!.getSelectedCells();
    if (cells.length === 1) {
      if (cells[0].isNode()) {
        startEditingNode(cells[0] as Node, false, true);
        return false;
      } else if (cells[0].isEdge()) {
        startEditingEdge(cells[0] as Edge, false, true);
        return false;
      }
    }
    return true;  // 允许其他空格行为
  });

  // 节点双击 - 跳转到代码
  graph.on('node:dblclick', ({ node }) => {
    const data = node.getData();
    if (data?.type === 'note') {
      // Note 节点双击进入编辑模式
      startEditingNoteNode(node);
      return;
    }
    if (data?.symbol?.uri) {
      vscode.postMessage({
        type: 'nodeClick',
        node: data,
      });
    }
  });

  // 边双击 - 编辑 label
  graph.on('edge:dblclick', ({ edge }) => {
    startEditingEdge(edge, false, true);  // 双击全选
  });
  
  // 边选中 - 高亮显示
  graph.on('edge:selected', ({ edge }) => {
    // 恢复上一个选中的边
    if (selectedEdge && selectedEdge !== edge) {
      const oldData = selectedEdge.getData() || {};
      selectedEdge.attr('line/stroke', oldData.type === 'explain' ? '#FFC107' : '#8a8a8a');
      selectedEdge.attr('line/strokeWidth', 2);
      selectedEdge.setZIndex(0);
    }

    // 高亮当前边
    selectedEdge = edge;
    edge.attr('line/stroke', '#00aaff');
    edge.attr('line/strokeWidth', 3.5);
    edge.setZIndex(2);  // 直接选中的边渲染在最上层

    console.log(`[边选中] ${edge.id}`);
  });

  // 边取消选中 - 恢复样式
  graph.on('edge:unselected', ({ edge }) => {
    const data = edge.getData() || {};
    edge.attr('line/stroke', data.type === 'explain' ? '#FFC107' : '#8a8a8a');
    edge.attr('line/strokeWidth', 2);
    edge.setZIndex(0);

    if (selectedEdge === edge) {
      selectedEdge = null;
    }
  });
  
  // 边点击
  graph.on('edge:click', ({ edge }) => {
    hideContextMenu();
    hideNodeToolbar();
  });
  
  // 画布双击 - 创建节点
  graph.on('blank:dblclick', ({ e }) => {
    const pos = graph!.pageToLocal(e.pageX, e.pageY);
    const node = createNode(pos.x - 90, pos.y - 30, 'code');  // 居中创建
    if (node) {
      graph!.cleanSelection();
      graph!.select(node);
    }
  });

  // 画布右键菜单
  graph.on('blank:contextmenu', ({ e }) => {
    e.preventDefault();
    
    // 如果rightMouseDownPos为null，说明已经拖动过，不显示菜单
    if (!rightMouseDownPos) {
      return;
    }
    rightMouseDownPos = null;
    
    const pageX = e.pageX;
    const pageY = e.pageY;
    const pos = graph!.pageToLocal(pageX, pageY);
    
    showContextMenu(e.clientX, e.clientY, [
      {
        label: '📄 ' + t('contextMenu.createCodeNode'),
        action: () => {
          const node = createNode(pos.x - 90, pos.y - 30, 'code');
          if (node) {
            graph!.cleanSelection();
            graph!.select(node);
          }
        },
      },
      {
        label: '📝 ' + t('contextMenu.createNoteNode'),
        action: () => {
          const node = createNode(pos.x - 90, pos.y - 30, 'note');
          if (node) {
            graph!.cleanSelection();
            graph!.select(node);
          }
        },
      },
    ]);
  });

  // 节点右键菜单
  graph.on('node:contextmenu', ({ e, node }) => {
    e.preventDefault();
    e.stopPropagation();
    cancelTooltip();
    
    // 如果rightMouseDownPos为null，说明已经拖动过，不显示菜单
    if (!rightMouseDownPos) {
      return;
    }
    rightMouseDownPos = null;
    
    // 获取节点当前标签
    const nodeData = node.getData() as CallGraphNode;
    const nodeTags = nodeData?.tags || [];
    const isNote = nodeData?.type === 'note';
    
    // Note 节点不显示标签菜单
    const menuItems: MenuItem[] = [
      {
        label: '✏️ ' + t('contextMenu.editNode'),
        action: () => {
          startEditingNode(node, false, true);
        },
      },
    ];

    // Code 节点才显示标签菜单
    if (!isNote) {
      // 构建标签子菜单项
      const tagSubItems: MenuItem[] = tagConfig.predefinedTags.map(tag => {
        const hasTag = nodeTags.includes(tag.name);
        return {
          label: tag.name,
          colorDot: tag.color,
          checked: hasTag,
          action: () => {
            toggleNodeTag(node, tag.name);
          },
        };
      });
      
      // 添加自定义标签选项
      tagSubItems.push({
        label: '+ ' + t('contextMenu.newTag'),
        action: () => {
          promptNewTag(node);
        },
      });

      menuItems.push({
        label: '🏷️ ' + t('contextMenu.tags'),
        subItems: tagSubItems,
      });
    }

    menuItems.push({
      label: '🗑️ ' + t('contextMenu.deleteNode'),
      action: () => {
        graph!.removeNode(node);
        notifyDocumentChanged();
      },
    });
    
    showContextMenu(e.clientX, e.clientY, menuItems);
  });

  // 边右键菜单 - 删除边
  graph.on('edge:contextmenu', ({ e, edge }) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 如果rightMouseDownPos为null，说明已经拖动过，不显示菜单
    if (!rightMouseDownPos) {
      return;
    }
    rightMouseDownPos = null;
    
    showContextMenu(e.clientX, e.clientY, [
      {
        label: '🗑️ ' + t('contextMenu.deleteEdge'),
        action: () => {
          graph!.removeEdge(edge);
          notifyDocumentChanged();
        },
      },
    ]);
  });

  // 点击画布空白处隐藏菜单和工具栏
  graph.on('blank:click', () => {
    hideContextMenu();
    hideNodeToolbar();
    updateAlignmentToolbar();  // 点击空白区域时更新对齐工具栏
    
    // 如果处于连接模式，取消连接
    if (isConnectingMode) {
      cancelConnectingMode();
    }
  });

  // 点击节点
  graph.on('node:click', ({ node }) => {
    hideContextMenu();
    cancelTooltip();
    // 不隐藏工具栏，让 node:selected 事件处理工具栏显示

    // 如果处于连接模式，完成连接
    if (isConnectingMode) {
      completeConnection(node);
    }
  });
  
  // 节点悬停 - 连接模式下高亮 + tooltip
  graph.on('node:mouseenter', ({ node, e }) => {
    if (isConnectingMode && node !== connectingSourceNode) {
      // 恢复上一个悬停节点
      if (connectingHoverNode && connectingHoverNode !== node) {
        const prevData = connectingHoverNode.getData() || {};
        const prevIsNote = prevData.type === 'note';
        const prevIsBroken = prevData.status === 'broken';
        connectingHoverNode.attr('body/stroke', getNodeStrokeColor(prevIsNote, prevIsBroken));
        connectingHoverNode.attr('body/strokeWidth', 2);
      }

      // 高亮当前节点
      connectingHoverNode = node;
      node.attr('body/stroke', '#ffaa00');
      node.attr('body/strokeWidth', 3);
    }

    // Tooltip: 开始计时
    startTooltipTimer(node, e.clientX, e.clientY);
  });

  // 节点离开 - 恢复样式 + 隐藏 tooltip
  graph.on('node:mouseleave', ({ node }) => {
    if (isConnectingMode && connectingHoverNode === node) {
      const data = node.getData() || {};
      const isNote = data.type === 'note';
      const isBroken = data.status === 'broken';
      node.attr('body/stroke', getNodeStrokeColor(isNote, isBroken));
      node.attr('body/strokeWidth', 2);
      connectingHoverNode = null;
    }

    // Tooltip: 取消计时并隐藏
    cancelTooltip();
  });
  
  // 节点移动时更新工具栏位置
  graph.on('node:moving', ({ node }) => {
    hideContextMenu();  // 拖动节点时隐藏右键菜单
    cancelTooltip();    // 拖动时隐藏 tooltip
    const cells = graph!.getSelectedCells();
    if (cells.length === 1 && cells[0].id === node.id && nodeToolbar?.style.display !== 'none') {
      showNodeToolbar(node);
    }
  });

  // 节点移动结束后标记为已修改（防抖保存）
  let saveTimeout: NodeJS.Timeout | null = null;
  graph.on('node:change:position', ({ node }) => {
    if (isInitializing) return;  // 初始化时不保存
    // 更新 resize handle 位置
    const data = node.getData();
    if (data?.type === 'note' && resizeHandle) {
      updateResizeHandlePosition(node);
    }
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      notifyDocumentChanged();  // 标记文档已修改
    }, 500);
  });

  // 节点添加后标记为已修改（粘贴、撤销等）
  graph.on('node:added', ({ node }) => {
    if (!isInitializing) {
      console.log('[事件] 节点添加:', node.id);
      notifyDocumentChanged();
    }
  });

  // 节点删除后标记为已修改
  graph.on('node:removed', ({ node }) => {
    if (!isInitializing) {
      console.log('[事件] 节点删除:', node.id);
      notifyDocumentChanged();
    }
  });

  // 边添加后标记为已修改（拖拽创建、粘贴、撤销等）
  graph.on('edge:added', ({ edge }) => {
    if (!isInitializing) {
      console.log('[事件] 边添加:', edge.id);
      notifyDocumentChanged();
    }
  });
  
  // 边删除后标记为已修改
  graph.on('edge:removed', ({ edge }) => {
    if (!isInitializing) {
      console.log('[事件] 边删除:', edge.id);
      notifyDocumentChanged();
    }
  });

  // 边连接完成（用户手动拖拽端口创建边）
  graph.on('edge:connected', ({ edge }) => {
    if (!isInitializing) {
      console.log('[事件] 边连接完成:', edge.id);
      // edge:connected 后会触发 edge:added，所以这里不需要再次保存
    }
  });

  // 监听键盘输入 - 字母/数字/符号键触发编辑（节点或边）
  document.addEventListener('keydown', (e) => {
    // 如果正在编辑，不处理
    if (editingNode || editingEdge) return;
    if (!graph) return;
    
    // 检查是否有选中的单个元素
    const cells = graph.getSelectedCells();
    if (cells.length !== 1) return;
    
    const selectedCell = cells[0];
    
    // 忽略修饰键和功能键
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    
    // 检查是否是可打印字符（字母、数字、符号）
    // 单个字符且不是功能键
    if (e.key.length === 1 && !e.key.match(/^[\x00-\x1F]$/)) {
      // 非空格字符 - 清空文本并输入该字符
      if (e.key !== ' ') {
        e.preventDefault();
        if (selectedCell.isNode()) {
          startEditingNode(selectedCell as Node, true, false, e.key);
        } else if (selectedCell.isEdge()) {
          startEditingEdge(selectedCell as Edge, true, false, e.key);
        }
      }
    }
  });

  // 监听画布的鼠标右键按下事件，记录位置用于判断是点击还是拖动
  const graphContainerEl = document.getElementById('graph-container');
  if (graphContainerEl) {
    graphContainerEl.addEventListener('mousedown', (e) => {
      if (e.button === 2) { // 右键
        rightMouseDownPos = { x: e.clientX, y: e.clientY };
      }
    });
    // 监听mousemove，如果移动超过阈值则清除rightMouseDownPos
    graphContainerEl.addEventListener('mousemove', (e) => {
      if (rightMouseDownPos && e.buttons === 2) { // 右键按下且移动
        const deltaX = Math.abs(e.clientX - rightMouseDownPos.x);
        const deltaY = Math.abs(e.clientY - rightMouseDownPos.y);
        if (deltaX > 5 || deltaY > 5) {
          rightMouseDownPos = null; // 清除，表示这是拖动而非点击
        }
      }
    });
  }

  // Note 节点选中时显示 resize 手柄（HTML overlay）
  let resizeHandle: HTMLElement | null = null;
  let resizingNode: Node | null = null;
  let resizeStartPos = { x: 0, y: 0 };
  let resizeStartSize = { width: 0, height: 0 };

  function showResizeHandle(node: Node) {
    hideResizeHandle();
    const data = node.getData();
    if (data?.type !== 'note') return;

    const pos = node.getPosition();
    const size = node.getSize();
    const zoom = graph!.zoom();
    const bottomRight = graph!.localToPage(pos.x + size.width, pos.y + size.height);

    resizeHandle = document.createElement('div');
    resizeHandle.id = 'note-resize-handle';
    const handleSize = 20;
    resizeHandle.style.cssText = `
      position: fixed;
      left: ${bottomRight.x - handleSize}px;
      top: ${bottomRight.y - handleSize}px;
      width: ${handleSize}px;
      height: ${handleSize}px;
      cursor: nwse-resize;
      z-index: 9999;
      opacity: 0.7;
      pointer-events: auto;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    // 使用 SVG resize 图标（三条斜线）
    resizeHandle.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <line x1="11" y1="1" x2="1" y2="11" stroke="${tagConfig.noteNodeColor.stroke}" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="11" y1="5" x2="5" y2="11" stroke="${tagConfig.noteNodeColor.stroke}" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="11" y1="9" x2="9" y2="11" stroke="${tagConfig.noteNodeColor.stroke}" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    `;
    document.body.appendChild(resizeHandle);

    // Resize 手柄的拖拽事件
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizingNode = node;
      resizeStartPos = { x: e.clientX, y: e.clientY };
      resizeStartSize = node.getSize();
    });
  }

  function hideResizeHandle() {
    if (resizeHandle) {
      resizeHandle.remove();
      resizeHandle = null;
    }
  }

  function updateResizeHandlePosition(node: Node) {
    if (!resizeHandle || !graph) return;
    const pos = node.getPosition();
    const size = node.getSize();
    const bottomRight = graph.localToPage(pos.x + size.width, pos.y + size.height);
    const handleSize = 20;
    resizeHandle.style.left = `${bottomRight.x - handleSize}px`;
    resizeHandle.style.top = `${bottomRight.y - handleSize}px`;
  }

  // 节点选中时 —— 为 note 节点显示 resize handle，高亮关联边
  graph.on('node:selected', ({ node }) => {
    // 多选时不显示节点操作工具栏（连接/绑定按钮）
    const selectedNodes = graph!.getSelectedCells().filter(c => c.isNode());
    if (selectedNodes.length === 1) {
      showNodeToolbar(node);
    } else {
      hideNodeToolbar();
    }
    const data = node.getData();
    if (data?.type === 'note') {
      showResizeHandle(node);
    }
    updateAlignmentToolbar();  // 更新对齐工具栏
    highlightConnectedEdges();  // 高亮选中节点关联的边
  });

  // 节点取消选中 —— 隐藏
  graph.on('node:unselected', () => {
    hideNodeToolbar();
    hideResizeHandle();
    updateAlignmentToolbar();  // 更新对齐工具栏
    highlightConnectedEdges();  // 刷新边高亮状态
  });

  document.addEventListener('mousemove', (e) => {
    if (!resizingNode) return;
    const dx = e.clientX - resizeStartPos.x;
    const dy = e.clientY - resizeStartPos.y;
    const zoom = graph!.zoom();
    const newWidth = Math.max(NOTE_MIN_WIDTH, resizeStartSize.width + dx / zoom);
    const newHeight = Math.max(NOTE_MIN_HEIGHT, resizeStartSize.height + dy / zoom);
    resizingNode.resize(newWidth, newHeight);
    updateResizeHandlePosition(resizingNode);
  });

  document.addEventListener('mouseup', () => {
    if (resizingNode) {
      renderNoteNode(resizingNode);
      notifyDocumentChanged();
      resizingNode = null;
    }
  });

  // 画布缩放/平移时更新 resize handle 位置
  graph.on('scale', () => {
    const selected = graph!.getSelectedCells();
    if (selected.length === 1 && selected[0].isNode()) {
      const node = selected[0] as Node;
      const data = node.getData();
      if (data?.type === 'note') {
        updateResizeHandlePosition(node);
      }
    }
  });
  graph.on('translate', () => {
    const selected = graph!.getSelectedCells();
    if (selected.length === 1 && selected[0].isNode()) {
      const node = selected[0] as Node;
      const data = node.getData();
      if (data?.type === 'note') {
        updateResizeHandlePosition(node);
      }
    }
  });

  // 注入 Markdown 样式
  injectMarkdownStyles();

  // 初始化常驻自动布局按钮
  createAutoLayoutBar();

  console.log('X6 Graph initialized');
}

// 从文件名获取标签颜色
function getTagColor(tag: string): string {
  for (const t of tagConfig.predefinedTags) {
    if (t.name === tag) {
      return t.color;
    }
  }
  return tagConfig.fileNameTagColor;
}

// 从 URI 提取文件名
function extractFileName(uri: string): string | null {
  if (!uri) return null;
  const parts = uri.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

// 构建节点标签
function buildNodeLabel(node: CallGraphNode): string {
  // 直接使用用户设定的 label，不自动追加 containerName
  return node.label || node.symbol?.name || node.id;
}

// Dagre 同步初始布局（用于首次加载没有坐标的图）
function dagreInitialLayout(
  nodes: CallGraphNode[],
  edges: CallGraphEdge[]
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 80, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: node.width || 180, height: node.height || 60 });
  }
  for (const edge of edges) {
    g.setEdge(edge.from, edge.to);
  }

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const n = g.node(node.id);
    if (n) {
      positions.set(node.id, {
        x: 100 + n.x - (node.width || 180) / 2,
        y: 100 + n.y - (node.height || 60) / 2,
      });
    }
  }
  return positions;
}

// 将 CallGraph 数据转换为 X6 数据
function convertToX6Data(data: CallGraphData): { nodes: Node.Metadata[]; edges: Edge.Metadata[] } {
  const needsLayout = data.nodes.some(n => n.x === undefined || n.y === undefined);
  const positions = needsLayout ? dagreInitialLayout(data.nodes, data.edges || []) : null;

  const nodes: Node.Metadata[] = data.nodes.map((node): Node.Metadata => {
    const pos = positions?.get(node.id) || { x: node.x || 100, y: node.y || 100 };
    const isBroken = node.status === 'broken';
    const isNote = node.type === 'note';
    const hasSymbol = !!node.symbol;

    // 使用配置的节点颜色
    const nodeColors = getNodeColors(isNote, isBroken, isNote || hasSymbol);
    const nodeFillColor = nodeColors.fill;
    const nodeStrokeColor = nodeColors.stroke;

    // Note 节点：使用 note-node 形状，支持 Markdown 渲染
    if (isNote) {
      const noteWidth = node.width || NOTE_DEFAULT_WIDTH;
      const noteHeight = node.height || NOTE_DEFAULT_HEIGHT;

      return {
        id: node.id,
        shape: 'note-node',
        x: pos.x,
        y: pos.y,
        width: noteWidth,
        height: noteHeight,
        attrs: {
          body: {
            fill: nodeFillColor,
            stroke: nodeStrokeColor,
            strokeWidth: 2,
            rx: 8,
            ry: 8,
          },
        },
        data: {
          ...node,
          width: noteWidth,
          height: noteHeight,
          displayTags: node.tags ? [...node.tags] : [],
        },
      };
    }

    // Code 节点：使用 tag-node 形状
    const displayTags = node.tags ? [...node.tags] : [];
    const hasTags = displayTags.length > 0;
    const nodeHeight = hasTags ? 80 : 60;

    return {
      id: node.id,
      shape: 'tag-node',
      x: pos.x,
      y: pos.y,
      width: 180,
      height: nodeHeight,
      attrs: {
        body: {
          fill: nodeFillColor,
          stroke: nodeStrokeColor,
          strokeWidth: 2,
          rx: 6,
          ry: 6,
          width: 180,
          height: nodeHeight,
        },
        label: {
          text: buildNodeLabel(node),
          fill: '#d4d4d4',
          fontSize: 13,
          textAnchor: 'middle',
          textVerticalAnchor: 'middle',
          refX: 0.5,
          refY: hasTags ? 0.35 : 0.5,
        },
        fo: {
          refWidth: '100%',
          height: 24,
          y: hasTags ? 50 : 80,
          x: 0,
          visibility: hasTags ? 'visible' : 'hidden',
        },
      },
      data: {
        ...node,
        displayTags,
      },
    };
  });

  const edges: Edge.Metadata[] = (data.edges || []).map((edge, index) => {
    console.log(`[边转换] from: ${edge.from}, to: ${edge.to}, type: ${edge.type}`);
    return {
      id: `e-${edge.from}-${edge.to}-${index}`,
      source: { cell: edge.from },
      target: { cell: edge.to },
      connector: { name: 'rounded', args: { radius: 8 } },
      router: {
        name: 'manhattan',
        args: {
          ...getRouterDirections(),
          padding: 30,
        },
      },
      attrs: {
        line: {
          stroke: edge.type === 'explain' ? '#FFC107' : '#8a8a8a',
          strokeWidth: 2,
          targetMarker: {
            name: 'block',
            width: 12,
            height: 8,
          },
        },
      },
      data: { type: edge.type || 'call' },
    };
  });

  console.log(`[转换完成] 节点: ${nodes.length}, 边: ${edges.length}`);

  return { nodes, edges };
}

// ============ Phase 12: 对齐工具栏与自动布局 ============

// 创建对齐工具栏按钮的通用样式
function createToolbarButton(icon: string, title: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.innerHTML = icon;
  btn.title = title;
  btn.style.cssText = `
    background: #3c3c3c;
    border: 1px solid #555;
    color: #ccc;
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 14px;
    min-width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
  `;
  btn.addEventListener('mouseenter', () => {
    btn.style.background = '#505050';
    btn.style.borderColor = '#888';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = '#3c3c3c';
    btn.style.borderColor = '#555';
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
    // 将焦点还给画布，确保键盘快捷键（如 Ctrl+Z 撤销）继续生效
    document.getElementById('graph-container')?.focus();
  });
  return btn;
}

// 创建分隔符
function createSeparator(): HTMLElement {
  const sep = document.createElement('div');
  sep.style.cssText = `
    width: 1px;
    height: 20px;
    background: #555;
    margin: 0 2px;
  `;
  return sep;
}

// 创建多选对齐浮动工具栏
function createAlignmentToolbar(): HTMLElement {
  if (alignmentToolbar) return alignmentToolbar;

  alignmentToolbar = document.createElement('div');
  alignmentToolbar.id = 'alignment-toolbar';
  alignmentToolbar.style.cssText = `
    position: fixed;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    background: #2d2d30;
    border: 1px solid #454545;
    border-radius: 6px;
    padding: 4px 8px;
    display: none;
    z-index: 9998;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
    gap: 4px;
    flex-direction: row;
    align-items: center;
  `;

  // 对齐按钮
  alignmentToolbar.appendChild(createToolbarButton('⬅', t('align.left'), () => alignNodes('left')));
  alignmentToolbar.appendChild(createToolbarButton('↔', t('align.centerH'), () => alignNodes('centerH')));
  alignmentToolbar.appendChild(createToolbarButton('➡', t('align.right'), () => alignNodes('right')));
  alignmentToolbar.appendChild(createSeparator());
  alignmentToolbar.appendChild(createToolbarButton('⬆', t('align.top'), () => alignNodes('top')));
  alignmentToolbar.appendChild(createToolbarButton('↕', t('align.centerV'), () => alignNodes('centerV')));
  alignmentToolbar.appendChild(createToolbarButton('⬇', t('align.bottom'), () => alignNodes('bottom')));
  alignmentToolbar.appendChild(createSeparator());
  alignmentToolbar.appendChild(createToolbarButton('┄', t('align.distributeH'), () => distributeNodes('horizontal')));
  alignmentToolbar.appendChild(createToolbarButton('┆', t('align.distributeV'), () => distributeNodes('vertical')));
  alignmentToolbar.appendChild(createSeparator());
  alignmentToolbar.appendChild(createToolbarButton('🔄', t('layout.autoLayoutSelected'), () => performAutoLayout(true)));

  document.body.appendChild(alignmentToolbar);
  return alignmentToolbar;
}

// 显示/隐藏对齐工具栏
function updateAlignmentToolbar() {
  if (!graph) return;
  const selectedCells = graph.getSelectedCells();
  const selectedNodes = selectedCells.filter(c => c.isNode());
  
  if (selectedNodes.length >= 2) {
    const toolbar = createAlignmentToolbar();
    toolbar.style.display = 'flex';
  } else {
    if (alignmentToolbar) {
      alignmentToolbar.style.display = 'none';
    }
  }
}

// 对齐选中节点
function alignNodes(direction: 'left' | 'right' | 'top' | 'bottom' | 'centerH' | 'centerV') {
  if (!graph) return;
  const selectedNodes = graph.getSelectedCells().filter(c => c.isNode()) as Node[];
  if (selectedNodes.length < 2) return;

  // 开始批量操作（支持一次性撤销）
  graph.startBatch('align');

  const positions = selectedNodes.map(n => ({
    node: n,
    pos: n.getPosition(),
    size: n.getSize(),
  }));

  switch (direction) {
    case 'left': {
      const minX = Math.min(...positions.map(p => p.pos.x));
      positions.forEach(p => p.node.setPosition(minX, p.pos.y));
      break;
    }
    case 'right': {
      const maxRight = Math.max(...positions.map(p => p.pos.x + p.size.width));
      positions.forEach(p => p.node.setPosition(maxRight - p.size.width, p.pos.y));
      break;
    }
    case 'top': {
      const minY = Math.min(...positions.map(p => p.pos.y));
      positions.forEach(p => p.node.setPosition(p.pos.x, minY));
      break;
    }
    case 'bottom': {
      const maxBottom = Math.max(...positions.map(p => p.pos.y + p.size.height));
      positions.forEach(p => p.node.setPosition(p.pos.x, maxBottom - p.size.height));
      break;
    }
    case 'centerH': {
      // 水平居中对齐：所有节点中心 X 对齐
      const centers = positions.map(p => p.pos.x + p.size.width / 2);
      const avgCenterX = centers.reduce((a, b) => a + b, 0) / centers.length;
      positions.forEach(p => p.node.setPosition(avgCenterX - p.size.width / 2, p.pos.y));
      break;
    }
    case 'centerV': {
      // 垂直居中对齐：所有节点中心 Y 对齐
      const centers = positions.map(p => p.pos.y + p.size.height / 2);
      const avgCenterY = centers.reduce((a, b) => a + b, 0) / centers.length;
      positions.forEach(p => p.node.setPosition(p.pos.x, avgCenterY - p.size.height / 2));
      break;
    }
  }

  graph.stopBatch('align');
  notifyDocumentChanged();
}

// 等距分布选中节点
function distributeNodes(direction: 'horizontal' | 'vertical') {
  if (!graph) return;
  const selectedNodes = graph.getSelectedCells().filter(c => c.isNode()) as Node[];
  if (selectedNodes.length < 3) return;  // 至少 3 个节点才有意义

  graph.startBatch('distribute');

  const items = selectedNodes.map(n => ({
    node: n,
    pos: n.getPosition(),
    size: n.getSize(),
  }));

  if (direction === 'horizontal') {
    // 按 X 坐标排序
    items.sort((a, b) => a.pos.x - b.pos.x);
    const first = items[0];
    const last = items[items.length - 1];
    const totalSpace = (last.pos.x + last.size.width) - first.pos.x;
    const totalNodeWidth = items.reduce((sum, item) => sum + item.size.width, 0);
    const gap = (totalSpace - totalNodeWidth) / (items.length - 1);
    
    let currentX = first.pos.x;
    items.forEach((item) => {
      item.node.setPosition(currentX, item.pos.y);
      currentX += item.size.width + gap;
    });
  } else {
    // 按 Y 坐标排序
    items.sort((a, b) => a.pos.y - b.pos.y);
    const first = items[0];
    const last = items[items.length - 1];
    const totalSpace = (last.pos.y + last.size.height) - first.pos.y;
    const totalNodeHeight = items.reduce((sum, item) => sum + item.size.height, 0);
    const gap = (totalSpace - totalNodeHeight) / (items.length - 1);
    
    let currentY = first.pos.y;
    items.forEach((item) => {
      item.node.setPosition(item.pos.x, currentY);
      currentY += item.size.height + gap;
    });
  }

  graph.stopBatch('distribute');
  notifyDocumentChanged();
}

// 创建常驻自动布局按钮（画布右上角）
function createAutoLayoutBar(): HTMLElement {
  if (autoLayoutBar) return autoLayoutBar;

  autoLayoutBar = document.createElement('div');
  autoLayoutBar.id = 'auto-layout-bar';
  autoLayoutBar.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: #2d2d30;
    border: 1px solid #454545;
    border-radius: 6px;
    padding: 4px 8px;
    display: flex;
    z-index: 9998;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    gap: 4px;
    flex-direction: row;
    align-items: center;
  `;

  // 布局算法下拉选择器
  const algorithmSelect = document.createElement('select');
  algorithmSelect.id = 'layout-algorithm-select';
  algorithmSelect.title = t('layout.selectAlgorithm');
  algorithmSelect.style.cssText = `
    background: #3c3c3c;
    border: 1px solid #555;
    color: #ccc;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 12px;
    height: 28px;
    cursor: pointer;
    outline: none;
    min-width: 110px;
  `;

  // 按分组归类引擎
  const engines = getAllEngines();
  const groups = new Map<string, typeof engines>();
  for (const engine of engines) {
    const groupKey = engine.group;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(engine);
  }

  const groupLabels: Record<string, string> = {
    hierarchical: t('layout.group.hierarchical'),
    tree: t('layout.group.tree'),
  };

  for (const [groupKey, groupEngines] of groups) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = groupLabels[groupKey] || groupKey;
    for (const engine of groupEngines) {
      const option = document.createElement('option');
      option.value = engine.id;
      option.textContent = engine.name;
      if (engine.id === currentLayoutAlgorithm) {
        option.selected = true;
      }
      optgroup.appendChild(option);
    }
    algorithmSelect.appendChild(optgroup);
  }

  algorithmSelect.addEventListener('change', () => {
    currentLayoutAlgorithm = algorithmSelect.value;
    // 更新方向按钮状态
    const engine = getEngine(currentLayoutAlgorithm);
    if (dirBtn) {
      dirBtn.style.opacity = engine.supportsDirection ? '1' : '0.4';
      dirBtn.style.pointerEvents = engine.supportsDirection ? 'auto' : 'none';
    }
  });
  autoLayoutBar.appendChild(algorithmSelect);

  // 自动布局按钮
  autoLayoutBar.appendChild(createToolbarButton('🔄', t('layout.autoLayout'), () => {
    const hasSelection = graph ? graph.getSelectedCells().filter(c => c.isNode()).length > 0 : false;
    performAutoLayout(hasSelection);
  }));

  // 方向切换按钮
  const dirBtn = createToolbarButton('↓', t('layout.directionTB'), () => {
    layoutDirection = layoutDirection === 'TB' ? 'LR' : 'TB';
    dirBtn.innerHTML = layoutDirection === 'TB' ? '↓' : '→';
    dirBtn.title = layoutDirection === 'TB' ? t('layout.directionTB') : t('layout.directionLR');
    // 刷新所有现有边的路由方向
    refreshEdgeRouters();
  });
  autoLayoutBar.appendChild(dirBtn);

  // 适应画布按钮
  autoLayoutBar.appendChild(createToolbarButton('⊡', t('layout.fitCanvas'), () => {
    if (graph) {
      graph.zoomToFit({ padding: 40, maxScale: 1.5 });
    }
  }));

  document.body.appendChild(autoLayoutBar);
  return autoLayoutBar;
}

// 单链对齐后处理：当父节点只有一个子节点且子节点只有一个父节点时，强制对齐
function alignSingleChains(
  positions: Map<string, { x: number; y: number }>,
  edges: LayoutEdgeInput[],
  nodes: LayoutNodeInput[],
  direction: 'TB' | 'LR'
): void {
  // 构建出度和入度统计
  const childrenCount = new Map<string, number>();  // 每个节点有几个子节点
  const parentCount = new Map<string, number>();    // 每个节点有几个父节点
  const childOf = new Map<string, string>();        // 一对一关系：子 -> 父

  for (const edge of edges) {
    childrenCount.set(edge.source, (childrenCount.get(edge.source) || 0) + 1);
    parentCount.set(edge.target, (parentCount.get(edge.target) || 0) + 1);
  }

  // 找出所有一对一链条的边
  for (const edge of edges) {
    if (childrenCount.get(edge.source) === 1 && parentCount.get(edge.target) === 1) {
      childOf.set(edge.target, edge.source);
    }
  }

  // 构建节点宽高映射
  const sizeMap = new Map<string, { width: number; height: number }>();
  for (const node of nodes) {
    sizeMap.set(node.id, { width: node.width, height: node.height });
  }

  // 对每个一对一子节点，将其坐标对齐到父节点
  for (const [childId, parentId] of childOf) {
    const parentPos = positions.get(parentId);
    const childPos = positions.get(childId);
    if (!parentPos || !childPos) continue;

    const parentSize = sizeMap.get(parentId);
    const childSize = sizeMap.get(childId);

    if (direction === 'TB') {
      // TB 模式：子节点 x 中心对齐父节点 x 中心
      const parentCenterX = parentPos.x + (parentSize ? parentSize.width / 2 : 0);
      const childHalfWidth = childSize ? childSize.width / 2 : 0;
      childPos.x = parentCenterX - childHalfWidth;
    } else {
      // LR 模式：子节点 y 中心对齐父节点 y 中心
      const parentCenterY = parentPos.y + (parentSize ? parentSize.height / 2 : 0);
      const childHalfHeight = childSize ? childSize.height / 2 : 0;
      childPos.y = parentCenterY - childHalfHeight;
    }
  }
}

// 执行自动布局
async function performAutoLayout(selectedOnly: boolean) {
  if (!graph) return;

  const allNodes = graph.getNodes();
  const allEdges = graph.getEdges();

  let targetNodes: Node[];
  let layoutEdges: LayoutEdgeInput[];
  let offsetX: number;
  let offsetY: number;

  if (selectedOnly) {
    // 局部布局：只布局选中的节点
    const selectedNodes = graph.getSelectedCells().filter(c => c.isNode()) as Node[];
    if (selectedNodes.length === 0) return;
    targetNodes = selectedNodes;

    const selectedIds = new Set(selectedNodes.map(n => n.id));

    // 提取选中节点间的边关系
    layoutEdges = allEdges
      .filter(e => {
        const sourceId = (e.getSourceCellId());
        const targetId = (e.getTargetCellId());
        return selectedIds.has(sourceId) && selectedIds.has(targetId);
      })
      .map(e => ({
        source: e.getSourceCellId(),
        target: e.getTargetCellId(),
      }));

    // 计算选中区域的左上角作为布局起点
    const positions = selectedNodes.map(n => n.getPosition());
    offsetX = Math.min(...positions.map(p => p.x));
    offsetY = Math.min(...positions.map(p => p.y));
  } else {
    // 全局布局：布局所有节点
    targetNodes = allNodes;
    layoutEdges = allEdges.map(e => ({
      source: e.getSourceCellId(),
      target: e.getTargetCellId(),
    }));
    offsetX = 100;
    offsetY = 100;
  }

  // 转换为布局引擎输入格式（使用实际节点尺寸）
  const layoutNodes: LayoutNodeInput[] = targetNodes.map(n => {
    const size = n.getSize();
    return {
      id: n.id,
      width: size.width,
      height: size.height,
    };
  });

  // 执行布局引擎
  const engine = getEngine(currentLayoutAlgorithm);
  const result = await engine.execute(layoutNodes, layoutEdges, layoutDirection, offsetX, offsetY);

  // 后处理：单链对齐（父节点只有一个子节点且子节点只有一个父节点时，强制对齐）
  alignSingleChains(result.positions, layoutEdges, layoutNodes, layoutDirection);

  // 应用位置
  graph.startBatch('auto-layout');
  result.positions.forEach((pos, id) => {
    const node = graph!.getCellById(id) as Node;
    if (node) {
      node.setPosition(pos.x, pos.y);
    }
  });
  graph.stopBatch('auto-layout');

  // 刷新边的路由方向
  refreshEdgeRouters();

  notifyDocumentChanged();
}

// 改进的自动布局算法（子节点居中对齐父节点）
function improvedAutoLayout(
  nodes: CallGraphNode[],
  edges: CallGraphEdge[],
  direction: 'TB' | 'LR' = 'TB',
  offsetX: number = 100,
  offsetY: number = 100,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  const NODE_SPACING = 260;  // 同层节点间距（增大以减少边拐弯）
  const LEVEL_SPACING = 180;  // 层级间距（增大以给路由算法更多空间）
  const nodeIds = new Set(nodes.map(n => n.id));

  // 构建邻接表（只考虑参与布局的节点）
  const childrenMap = new Map<string, string[]>();
  const parentMap = new Map<string, string[]>();
  
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    if (!childrenMap.has(edge.from)) childrenMap.set(edge.from, []);
    childrenMap.get(edge.from)!.push(edge.to);
    if (!parentMap.has(edge.to)) parentMap.set(edge.to, []);
    parentMap.get(edge.to)!.push(edge.from);
  }

  // 找出根节点（没有入边，或入边来源不在布局范围内）
  const rootNodes = nodes.filter(n => {
    const parents = parentMap.get(n.id) || [];
    return parents.length === 0;
  });

  // 如果没有根节点（全是环），取第一个节点作为根
  if (rootNodes.length === 0 && nodes.length > 0) {
    rootNodes.push(nodes[0]);
  }

  // BFS 分层（处理环：已访问跳过）
  const levels = new Map<string, number>();
  const queue: { id: string; level: number }[] = [];

  for (const root of rootNodes) {
    queue.push({ id: root.id, level: 0 });
  }

  while (queue.length > 0) {
    const { id, level } = queue.shift()!;
    if (levels.has(id)) {
      // 已分层的节点，取更大的层级（确保被调用者在下方）
      if (level > levels.get(id)!) {
        levels.set(id, level);
      }
      continue;
    }
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
    if (!levelGroups.has(level)) levelGroups.set(level, []);
    levelGroups.get(level)!.push(id);
  }

  // 计算每个节点的子树宽度（自底向上）
  const subtreeWidth = new Map<string, number>();
  const maxLevel = Math.max(...Array.from(levels.values()), 0);

  // 先初始化所有节点宽度为 1
  for (const node of nodes) {
    subtreeWidth.set(node.id, 1);
  }

  // 自底向上计算子树宽度
  for (let level = maxLevel; level >= 0; level--) {
    const nodesAtLevel = levelGroups.get(level) || [];
    for (const nodeId of nodesAtLevel) {
      const children = (childrenMap.get(nodeId) || []).filter(cId => {
        // 只统计层级更深的子节点（避免回边干扰）
        const childLevel = levels.get(cId);
        return childLevel !== undefined && childLevel > level;
      });
      if (children.length > 0) {
        const totalChildWidth = children.reduce((sum, cId) => sum + (subtreeWidth.get(cId) || 1), 0);
        subtreeWidth.set(nodeId, Math.max(totalChildWidth, 1));
      }
    }
  }

  // 层内节点排序：使用重心法（Barycenter）减少边交叉
  // 原理：每个节点的理想位置 = 其父节点位置的平均值
  for (let level = 1; level <= maxLevel; level++) {
    const nodesAtLevel = levelGroups.get(level) || [];
    const nodeBarycenter = new Map<string, number>();

    for (const nodeId of nodesAtLevel) {
      const parents = (parentMap.get(nodeId) || []).filter(pId => {
        const parentLevel = levels.get(pId);
        return parentLevel !== undefined && parentLevel < level;
      });
      if (parents.length > 0) {
        // 计算父节点在上一层的索引平均值
        const parentLevel = level - 1;
        const parentLevelNodes = levelGroups.get(parentLevel) || [];
        const parentPositions = parents.map(pId => parentLevelNodes.indexOf(pId)).filter(i => i >= 0);
        if (parentPositions.length > 0) {
          const avg = parentPositions.reduce((a, b) => a + b, 0) / parentPositions.length;
          nodeBarycenter.set(nodeId, avg);
        }
      }
    }

    // 按重心值排序，没有父节点的保持原位
    nodesAtLevel.sort((a, b) => {
      const ba = nodeBarycenter.get(a) ?? Infinity;
      const bb = nodeBarycenter.get(b) ?? Infinity;
      return ba - bb;
    });
    levelGroups.set(level, nodesAtLevel);
  }

  // 自顶向下分配坐标（子节点居中到父节点下方）
  const nodeSlotStart = new Map<string, number>();  // 每个节点在其层级上的起始 slot 位置

  // 根节点按子树宽度分配起始位置
  let currentSlot = 0;
  const sortedRoots = (levelGroups.get(0) || []);
  for (const rootId of sortedRoots) {
    nodeSlotStart.set(rootId, currentSlot);
    currentSlot += subtreeWidth.get(rootId) || 1;
  }

  // 逐层分配子节点位置
  for (let level = 0; level <= maxLevel; level++) {
    const nodesAtLevel = levelGroups.get(level) || [];
    for (const nodeId of nodesAtLevel) {
      const parentSlot = nodeSlotStart.get(nodeId) || 0;
      const children = (childrenMap.get(nodeId) || []).filter(cId => {
        const childLevel = levels.get(cId);
        return childLevel !== undefined && childLevel > level;
      });

      let childSlotStart = parentSlot;
      for (const childId of children) {
        if (!nodeSlotStart.has(childId)) {
          nodeSlotStart.set(childId, childSlotStart);
          childSlotStart += subtreeWidth.get(childId) || 1;
        }
      }
    }
  }

  // 将 slot 转换为坐标
  for (const node of nodes) {
    const level = levels.get(node.id) || 0;
    const slotStart = nodeSlotStart.get(node.id) || 0;
    const width = subtreeWidth.get(node.id) || 1;
    // 节点居中在其子树宽度范围内
    const slotCenter = slotStart + width / 2;

    if (direction === 'TB') {
      positions.set(node.id, {
        x: offsetX + slotCenter * NODE_SPACING,
        y: offsetY + level * LEVEL_SPACING,
      });
    } else {
      // LR: X 和 Y 互换
      positions.set(node.id, {
        x: offsetX + level * LEVEL_SPACING,
        y: offsetY + slotCenter * NODE_SPACING,
      });
    }
  }

  return positions;
}

// 注册自定义布局函数到布局引擎系统
registerCustomLayoutFn(improvedAutoLayout);

// 简单的自动布局（兼容旧调用）
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
  
  // 找出根节点
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
  const LEVEL_HEIGHT = 120;
  const NODE_SPACING = 220;
  
  for (const [level, nodeIds] of levelGroups) {
    const totalWidth = (nodeIds.length - 1) * NODE_SPACING;
    const startX = 100;
    
    nodeIds.forEach((id, index) => {
      positions.set(id, {
        x: startX + index * NODE_SPACING,
        y: 100 + level * LEVEL_HEIGHT,
      });
    });
  }
  
  return positions;
}

// 将 X6 数据转换回 CallGraph 格式
function convertToCallGraph(): CallGraphData {
  if (!graph || !currentData) return { nodes: [], edges: [] };

  const x6Nodes = graph.getNodes();
  const x6Edges = graph.getEdges();

  const nodes: CallGraphNode[] = x6Nodes.map((node) => {
    const data = node.getData() || {};
    const pos = node.getPosition();
    const size = node.getSize();
    const isNote = data.type === 'note';

    const result: CallGraphNode = {
      id: node.id,
      label: data.label,
      type: data.type,
      symbol: data.symbol,
      tags: data.tags,
      status: data.status,
      x: pos.x,
      y: pos.y,
    };

    // Note 节点保存 content 和尺寸
    if (isNote) {
      result.content = data.content;
      result.width = size.width;
      result.height = size.height;
    }

    return result;
  });

  const edges: CallGraphEdge[] = x6Edges.map((edge) => {
    const source = edge.getSourceCell();
    const target = edge.getTargetCell();
    const data = edge.getData() || {};
    console.log(`[保存边] from: ${source?.id}, to: ${target?.id}, type: ${data.type}`);
    return {
      from: source?.id || '',
      to: target?.id || '',
      type: data.type || 'call',
    };
  });

  console.log(`[保存完成] 节点: ${nodes.length}, 边: ${edges.length}`);

  return {
    title: currentData.title,
    nodes,
    edges,
  };
}

// 切换节点标签
function toggleNodeTag(node: Node, tagName: string) {
  const data = node.getData() as CallGraphNode;
  const currentTags = data?.tags || [];
  
  let newTags: string[];
  if (currentTags.includes(tagName)) {
    // 移除标签
    newTags = currentTags.filter(t => t !== tagName);
    console.log(`[移除标签] 节点: ${node.id}, 移除: ${tagName}, 剩余: [${newTags.join(', ')}]`);
  } else {
    // 添加标签
    newTags = [...currentTags, tagName];
    console.log(`[添加标签] 节点: ${node.id}, 添加: ${tagName}, 全部: [${newTags.join(', ')}]`);
  }
  
  // 更新节点显示（传入新的 tags 值）
  updateNodeDisplayWithTags(node, newTags);
  notifyDocumentChanged();
}

// 提示输入新标签
function promptNewTag(node: Node) {
  const tagName = prompt(t('prompt.enterTagName'));
  if (tagName && tagName.trim()) {
    const trimmedName = tagName.trim();
    
    // 检查是否已存在于预定义标签
    const exists = tagConfig.predefinedTags.some(t => t.name === trimmedName);
    if (!exists) {
      // 生成随机颜色
      const colors = ['#E91E63', '#673AB7', '#3F51B5', '#009688', '#795548', '#FF5722'];
      const randomColor = colors[Math.floor(Math.random() * colors.length)];
      tagConfig.predefinedTags.push({ name: trimmedName, color: randomColor });
    }
    
    // 添加标签到节点
    const data = node.getData() as CallGraphNode;
    const currentTags = data?.tags || [];
    if (!currentTags.includes(trimmedName)) {
      const newTags = [...currentTags, trimmedName];
      updateNodeDisplayWithTags(node, newTags);
      notifyDocumentChanged();
    }
  }
}

// 更新节点显示（使用指定的 tags）
function updateNodeDisplayWithTags(node: Node, newTags: string[]) {
  const data = node.getData() as CallGraphNode;

  console.log(`[updateNodeDisplayWithTags] 节点: ${node.id}, 新 tags: [${newTags.join(', ')}]`);

  // 直接使用用户标签作为显示标签（不再添加文件名标签）
  const displayTags = [...newTags];

  const hasTags = displayTags.length > 0;
  const newHeight = hasTags ? 80 : 60;

  // 更新节点尺寸
  node.resize(180, newHeight);
  node.attr('body/height', newHeight);

  // 一次性更新所有数据，使用 overwrite: true 确保完全覆盖
  const newData = { ...data, tags: newTags, displayTags };
  node.setData(newData, { overwrite: true });

  console.log(`[setData 完成] tags: [${newTags.join(', ')}]`);

  // 更新标签区域位置
  if (hasTags) {
    node.attr('label/refY', 0.35);
    node.attr('fo/visibility', 'visible');
    node.attr('fo/y', 50);
  } else {
    node.attr('label/refY', 0.5);
    node.attr('fo/visibility', 'hidden');
  }

  // 更新标签 DOM - 直接传入 displayTags
  updateNodeTagsDom(node, displayTags);

  console.log(`[节点更新完成] id: ${node.id}, displayTags: [${displayTags.join(', ')}]`);
}

// 更新节点显示（重新设置属性）
function updateNodeDisplay(node: Node) {
  // 重新获取最新数据
  const data = node.getData() as CallGraphNode;
  const tags = data?.tags || [];

  console.log(`[updateNodeDisplay] 节点: ${node.id}, 当前 tags: [${tags.join(', ')}]`);

  // 直接使用用户标签作为显示标签（不再添加文件名标签）
  const displayTags = [...tags];

  const hasTags = displayTags.length > 0;
  const newHeight = hasTags ? 80 : 60;

  // 更新节点尺寸
  node.resize(180, newHeight);
  node.attr('body/height', newHeight);

  // 只更新 displayTags，不覆盖其他字段
  const currentData = node.getData() as CallGraphNode;  // 再次获取确保最新
  node.setData({ ...currentData, displayTags });

  // 更新标签区域位置
  if (hasTags) {
    node.attr('label/refY', 0.35);
    node.attr('fo/visibility', 'visible');
    node.attr('fo/y', 50);  // 使用绝对像素值
  } else {
    node.attr('label/refY', 0.5);
    node.attr('fo/visibility', 'hidden');
  }

  // 更新标签 DOM - 直接传入 displayTags
  updateNodeTagsDom(node, displayTags);

  console.log(`[节点更新完成] id: ${node.id}, displayTags: [${displayTags.join(', ')}]`);
}

// 文档修改通知
function notifyDocumentChanged() {
  if (isInitializing) return;  // 初始化时不通知
  
  const data = convertToCallGraph();
  const text = JSON.stringify(data, null, 2);
  
  // 更新本地记录，这样扩展端触发的 update 会被去重跳过
  lastReceivedText = text;
  
  vscode.postMessage({
    type: 'edit',
    data,
  });
}

// 更新图数据（仅在外部数据到来时调用）
function updateGraph(data: CallGraphData) {
  if (!graph) return;

  console.log('📊 updateGraph: 节点数:', data.nodes?.length, '边数:', data.edges?.length);

  // 标记初始化开始
  isInitializing = true;

  currentData = data;
  
  // 清空现有内容
  graph.clearCells();
  
  const { nodes, edges } = convertToX6Data(data);
  
  // 批量添加节点和边
  if (nodes.length > 0) {
    graph.addNodes(nodes);
  }
  if (edges.length > 0) {
    graph.addEdges(edges);
  }

  // 延迟居中、更新标签 DOM 和重置标志
  setTimeout(() => {
    if (graph) {
      graph.centerContent();

      // 更新所有节点的标签 DOM
      graph.getNodes().forEach(node => {
        updateNodeTagsDom(node);
        // 渲染 note 节点的 Markdown 内容
        const data = node.getData();
        if (data?.type === 'note') {
          renderNoteNode(node);
        }
      });
    }
    // 初始化完成
    isInitializing = false;
  }, 100);
}

// ============ 测试模式 ============
// 设置为 true 来测试手动创建的节点，忽略系统数据
const TEST_MODE = false;  // 关闭测试模式，使用系统数据但改用 rect 节点

function createTestNodes() {
  if (!graph) return;
  
  console.log('=== 创建测试节点 ===');
  
  // 手动创建几个简单的测试节点
  const node1 = graph.addNode({
    id: 'test-node-1',
    shape: 'rect',
    x: 100,
    y: 100,
    width: 120,
    height: 50,
    attrs: {
      body: {
        fill: '#1e1e1e',
        stroke: '#0e639c',
        strokeWidth: 2,
        rx: 6,
        ry: 6,
      },
      label: {
        text: '测试节点 A',
        fill: '#d4d4d4',
        fontSize: 14,
      },
    },
  });
  
  const node2 = graph.addNode({
    id: 'test-node-2',
    shape: 'rect',
    x: 300,
    y: 100,
    width: 120,
    height: 50,
    attrs: {
      body: {
        fill: '#1e1e1e',
        stroke: '#4CAF50',
        strokeWidth: 2,
        rx: 6,
        ry: 6,
      },
      label: {
        text: '测试节点 B',
        fill: '#d4d4d4',
        fontSize: 14,
      },
    },
  });
  
  const node3 = graph.addNode({
    id: 'test-node-3',
    shape: 'rect',
    x: 200,
    y: 250,
    width: 120,
    height: 50,
    attrs: {
      body: {
        fill: '#1e1e1e',
        stroke: '#FF9800',
        strokeWidth: 2,
        rx: 6,
        ry: 6,
      },
      label: {
        text: '测试节点 C',
        fill: '#d4d4d4',
        fontSize: 14,
      },
    },
  });
  
  // 添加边
  graph.addEdge({
    source: node1,
    target: node3,
    attrs: {
      line: {
        stroke: '#8a8a8a',
        strokeWidth: 2,
        targetMarker: {
          name: 'block',
          width: 12,
          height: 8,
        },
      },
    },
  });
  
  graph.addEdge({
    source: node2,
    target: node3,
    attrs: {
      line: {
        stroke: '#8a8a8a',
        strokeWidth: 2,
        targetMarker: {
          name: 'block',
          width: 12,
          height: 8,
        },
      },
    },
  });
  
  console.log('测试节点创建完成，共创建 3 个节点和 2 条边');
  console.log('Graph 节点数:', graph.getNodes().length);
  console.log('Graph 边数:', graph.getEdges().length);
  
  // 居中显示
  setTimeout(() => {
    graph?.centerContent();
  }, 100);
}

// 处理来自扩展的消息
window.addEventListener('message', (event) => {
  const message = event.data;

  // 测试模式下忽略系统数据
  if (TEST_MODE && message.type === 'update') {
    console.log('⚠️ 测试模式已启用，忽略系统数据');
    return;
  }

  switch (message.type) {
    case 'update':
      // 收到文档文本
      const text = message.text || '';
      
      // 去重：如果文本与上次相同，不重新渲染
      if (text === lastReceivedText) {
        console.log('📊 文本未变化，跳过重新渲染');
        return;
      }
      lastReceivedText = text;
      
      // 解析 JSON
      let data: CallGraphData;
      if (text.trim().length === 0) {
        data = { nodes: [], edges: [] };
      } else {
        try {
          data = JSON.parse(text);
        } catch (e) {
          console.error('JSON 解析失败:', e);
          return;
        }
      }
      
      console.log('📊 updateGraph: 节点数:', data.nodes?.length, '边数:', data.edges?.length);
      updateGraph(data);
      break;
      
    case 'tagConfig':
      tagConfig = message.config;
      // 标签配置变化时不重新渲染整个图，只需更新节点样式
      break;

    case 'i18nStrings':
      // 接收国际化字符串
      if (message.strings) {
        initI18n(message.strings);
      }
      break;
      
    case 'navigationFailed':
      // 跳转失败，标记节点为 broken
      if (graph && message.nodeId) {
        const node = graph.getCellById(message.nodeId);
        if (node && node.isNode()) {
          const data = node.getData() || {};
          data.status = 'broken';
          node.setData(data);
          
          // 更新节点样式为红色边框
          node.attr('body/stroke', '#f44336');
          node.attr('body/strokeWidth', 2);
          
          console.log(`[跳转失败] 节点 ${message.nodeId} 标记为 broken，原因: ${message.reason}`);
          
          // 保存到文件
          notifyDocumentChanged();
        }
      }
      break;
      
    case 'navigationSuccess':
      // 跳转成功，如果节点之前是 broken，恢复为正常
      if (graph && message.nodeId) {
        const node = graph.getCellById(message.nodeId);
        if (node && node.isNode()) {
          const data = node.getData() || {};
          if (data.status === 'broken') {
            data.status = 'normal';
            node.setData(data);

            // 恢复正常样式
            const isNote = data.type === 'note';
            node.attr('body/stroke', getNodeStrokeColor(isNote, false));
            node.attr('body/strokeWidth', 2);

            console.log(`[跳转成功] 节点 ${message.nodeId} 恢复为正常状态`);

            // 保存到文件
            notifyDocumentChanged();
          }
        }
      }
      break;

    case 'bindMethod':
      // 绑定方法到节点（不修改节点文字，只更新 symbol 信息）
      if (graph && message.nodeId && message.method) {
        const node = graph.getCellById(message.nodeId);
        if (node && node.isNode()) {
          const data = node.getData() || {};

          // 更新 symbol 信息
          data.symbol = {
            name: message.method.name,
            uri: message.method.uri,
            containerName: message.method.containerName,
            line: message.method.line,
            signature: message.method.signature,
          };

          // 更新状态为正常
          data.status = 'normal';

          node.setData(data);

          // 更新节点颜色（code 节点绑定了 symbol，使用正常颜色）
          const isNote = data.type === 'note';
          const nodeColors = getNodeColors(isNote, false, true);
          node.attr('body/fill', nodeColors.fill);
          node.attr('body/stroke', nodeColors.stroke);

          console.log(`[绑定成功] 节点 ${message.nodeId} 绑定方法: ${message.method.name}`);

          // 保存到文件
          notifyDocumentChanged();
        }
      }
      break;
  }
});

// 防止重复初始化
let initialized = false;

function initialize() {
  if (initialized) return;
  initialized = true;
  
  initGraph();
  
  // 测试模式：创建测试节点
  if (TEST_MODE) {
    console.log('⚠️ 测试模式已启用');
    createTestNodes();
  }
  
  // 通知扩展 WebView 已就绪
  vscode.postMessage({ type: 'ready' });
}

// 初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
