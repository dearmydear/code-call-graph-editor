/**
 * 数据模型：呼叫图文档与节点/边定义
 * 最终版数据结构 - 简化且功能完整
 */

/**
 * 符号特征（用于 LSP 查找定位）
 */
export interface SymbolSignature {
  /** 方法/函数名（必填） */
  name: string;
  /** 文件路径，相对于工作区（必填） */
  uri: string;
  /** 容器名：类名/模块名（可选，用于区分同名方法） */
  containerName?: string;
  /** 符号定义所在行号（可选，用于精确定位） */
  line?: number;
  /** 参数类型签名（可选，用于区分重载方法）如 "(number, number)" */
  signature?: string;
}

/**
 * 节点样式配置
 */
export interface NodeStyle {
  /** 节点颜色 */
  color?: string;
  /** 节点图标 */
  icon?: string;
  /** 节点宽度 */
  width?: number;
  /** 节点高度 */
  height?: number;
}

/**
 * 边样式配置
 */
export interface EdgeStyle {
  /** 边颜色 */
  color?: string;
  /** 是否虚线 */
  dashed?: boolean;
}

/**
 * 统一节点定义 - 代码节点或说明节点
 */
export interface Node {
  // === 必填 ===
  /** 唯一标识符（hash，稳定不变） */
  id: string;

  // === 可选 - 显示 ===
  /** 显示名称（可选，默认用 symbol.name） */
  label?: string;
  /** 节点类型：code=代码节点，note=说明节点（默认 'code'） */
  type?: 'code' | 'note';

  // === 可选 - 代码绑定（type=code 时使用） ===
  /** 符号特征，用于 LSP 查找 */
  symbol?: SymbolSignature;

  // === 可选 - 文本内容（type=note 时使用） ===
  /** Markdown 内容 */
  content?: string;

  // === 可选 - 状态 ===
  /** 节点状态：normal=正常，broken=失效（默认 'normal'） */
  status?: 'normal' | 'broken';

  // === 可选 - 标签 ===
  /** 
   * 自定义标签（如 '循环', '判断', '异步' 等功能标记）
   * 注意：文件名标签会在显示时自动从 symbol.uri 提取，无需手动设置
   */
  tags?: string[];

  // === 可选 - 样式 ===
  /** 样式配置 */
  style?: NodeStyle;
}

/**
 * 边定义 - 表示节点之间的关系
 */
export interface Edge {
  // === 必填 ===
  /** 源节点 id */
  from: string;
  /** 目标节点 id */
  to: string;

  // === 可选 ===
  /** 边标签 */
  label?: string;
  /** 边类型：call=调用关系，explain=说明关系 */
  type?: 'call' | 'explain';
  /** 样式配置 */
  style?: EdgeStyle;
}

/**
 * 调用图文档
 */
export interface CallGraphDocument {
  /** 文档标题 */
  title?: string;
  /** 文档描述 */
  description?: string;
  /** 节点列表 */
  nodes: Node[];
  /** 边列表 */
  edges: Edge[];
}

export default CallGraphDocument;
