/**
 * 调用图生成器 - Phase 3
 * 从 LSP 调用层次生成可视化的调用图数据
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { CallGraphDocument, Node, Edge } from '../models/callGraphDocument';
import { LSPCallHierarchyProvider, CallHierarchyNode } from './lspIntegration';
import { WorkspacePathResolver } from './workspacePathResolver';
import { normalizeSymbolName } from './methodLibrary';

export interface GenerateOptions {
  depth?: number;
  direction?: 'both' | 'callers' | 'callees';
}

/**
 * 调用图生成器
 */
export class CallGraphGenerator {
  private nodeMap: Map<string, Node>;
  private edges: Edge[];
  private visitedNodes: Set<string>;

  constructor() {
    this.nodeMap = new Map();
    this.edges = [];
    this.visitedNodes = new Set();
  }

  /**
   * 从代码位置生成调用图
   */
  async generateFromCodePosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    options: GenerateOptions = {}
  ): Promise<CallGraphDocument> {
    const { depth = 2, direction = 'both' } = options;

    // 获取工作区信息
    const workspace = WorkspacePathResolver.getCurrentWorkspace();
    if (!workspace) {
      throw new Error(vscode.l10n.t('Workspace not opened'));
    }

    // 获取 LSP 调用层次
    const lspProvider = new LSPCallHierarchyProvider();
    const hierarchy = await lspProvider.getCallHierarchy(document, position, depth);

    if (!hierarchy) {
      throw new Error(vscode.l10n.t('Unable to get call hierarchy. Ensure cursor is on a method definition'));
    }

    // 重置状态
    this.nodeMap.clear();
    this.edges = [];
    this.visitedNodes.clear();

    // 转换为图数据
    const graphData = await this.convertToGraphData(hierarchy, direction);

    // 应用布局
    this.applyLayout(graphData.nodes);

    // 获取根节点名称作为标题
    const rootNode = graphData.nodes[0];
    const title = rootNode ? vscode.l10n.t('Call graph for {0}', rootNode.label || rootNode.id) : vscode.l10n.t('Call graph');

    console.log(`[生成器] 节点数: ${graphData.nodes.length}, 边数: ${this.edges.length}`);
    if (this.edges.length > 0) {
      console.log('[生成器] 边列表:', this.edges);
    }

    // 构建 CallGraphDocument（简化格式）
    const callGraphDoc: CallGraphDocument = {
      title,
      nodes: graphData.nodes,
      edges: this.edges
    };

    return callGraphDoc;
  }

  /**
   * 将 LSP 调用层次转换为图数据
   */
  private async convertToGraphData(
    hierarchy: CallHierarchyNode,
    direction: 'both' | 'callers' | 'callees'
  ): Promise<{ nodes: Node[] }> {
    // 创建根节点
    const rootNode = await this.createNodeFromCallHierarchyItem(hierarchy, 'root', 0);
    this.nodeMap.set(rootNode.id, rootNode);

    // 处理调用者
    if (direction === 'both' || direction === 'callers') {
      await this.processCallers(hierarchy, rootNode.id, 1);
    }

    // 处理被调用者
    if (direction === 'both' || direction === 'callees') {
      await this.processCallees(hierarchy, rootNode.id, 1);
    }

    return { nodes: Array.from(this.nodeMap.values()) };
  }

  /**
   * 递归处理调用者
   */
  private async processCallers(node: CallHierarchyNode, parentId: string, level: number): Promise<void> {
    if (!node.callers || node.callers.length === 0) {
      return;
    }

    for (const caller of node.callers) {
      const callerId = this.generateNodeId(caller);

      // 防止重复处理
      if (!this.visitedNodes.has(callerId)) {
        this.visitedNodes.add(callerId);

        const callerNode = await this.createNodeFromCallHierarchyItem(caller, 'caller', level);
        this.nodeMap.set(callerNode.id, callerNode);

        // 创建边：caller -> parent（简化格式，省略 id/type）
        console.log(`[生成器] 添加边: ${callerId} -> ${parentId}`);
        this.edges.push({
          from: callerId,
          to: parentId
        });

        // 递归处理
        await this.processCallers(caller, callerId, level + 1);
      }
    }
  }

  /**
   * 递归处理被调用者
   */
  private async processCallees(node: CallHierarchyNode, parentId: string, level: number): Promise<void> {
    if (!node.callees || node.callees.length === 0) {
      return;
    }

    for (const callee of node.callees) {
      const calleeId = this.generateNodeId(callee);

      // 防止重复处理
      if (!this.visitedNodes.has(calleeId)) {
        this.visitedNodes.add(calleeId);

        const calleeNode = await this.createNodeFromCallHierarchyItem(callee, 'callee', level);
        this.nodeMap.set(calleeNode.id, calleeNode);

        // 创建边：parent -> callee（简化格式，省略 id/type）
        console.log(`[生成器] 添加边: ${parentId} -> ${calleeId}`);
        this.edges.push({
          from: parentId,
          to: calleeId
        });

        // 递归处理
        await this.processCallees(callee, calleeId, level + 1);
      }
    }
  }

  /**
   * 从 CallHierarchyItem 创建 Node（使用 SymbolSignature）
   */
  private async createNodeFromCallHierarchyItem(
    item: CallHierarchyNode,
    _nodeType: 'root' | 'caller' | 'callee',
    _level: number
  ): Promise<Node> {
    const pathInfo = WorkspacePathResolver.toWorkspaceRelative(item.uri.fsPath);
    
    // detail 字段对于方法是容器名，对于函数可能包含签名
    const isMethod = item.kind === vscode.SymbolKind.Method;
    const containerName = isMethod ? item.detail : undefined;

    // 从 selectionRange 获取符号的精确位置
    const selectionStart = item.selectionRange?.start || item.range.start;

    // 规范化符号名：C# 等语言的 name 可能包含参数和返回类型
    const normalized = normalizeSymbolName(item.name);

    // 通过 Hover API 获取函数签名，如规范化已提取到签名则作为备用
    const hoverSignature = await this.getSignatureFromHover(item.uri, selectionStart);
    const signature = hoverSignature || normalized.signature;

    return {
      id: this.generateNodeId(item),
      label: normalized.bareName,
      type: 'code',
      symbol: {
        name: normalized.bareName,
        uri: pathInfo.relativePath,
        containerName: containerName || undefined,
        line: selectionStart.line,
        signature: signature || undefined
      }
    };
  }

  /**
   * 通过 Hover API 获取函数签名（只保留参数类型）
   */
  private async getSignatureFromHover(uri: vscode.Uri, position: vscode.Position): Promise<string | undefined> {
    try {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        uri,
        position
      );

      if (!hovers || hovers.length === 0) {
        return undefined;
      }

      // 遍历 hover 内容，查找函数签名
      for (const hover of hovers) {
        for (const content of hover.contents) {
          const text = typeof content === 'string' 
            ? content 
            : (content as vscode.MarkdownString).value;
          
          // 从 hover 文本中提取签名
          const signature = this.extractSignatureFromHover(text);
          if (signature) {
            return signature;
          }
        }
      }
    } catch (error) {
      console.error('获取 Hover 签名失败:', error);
    }
    return undefined;
  }

  /**
   * 从 Hover 文本中提取参数类型签名
   * TypeScript hover 格式通常是: (method) ClassName.methodName(param: type): returnType
   */
  private extractSignatureFromHover(hoverText: string): string | undefined {
    if (!hoverText) {
      return undefined;
    }

    // 匹配 TypeScript 代码块中的签名
    // 格式如: ```typescript\n(method) Calculator.add(a: number, b: number): number\n```
    const codeBlockMatch = hoverText.match(/```typescript\s*\n?(.*?)\n?```/s);
    const signatureText = codeBlockMatch ? codeBlockMatch[1] : hoverText;

    // 匹配括号内的参数部分
    const paramsMatch = signatureText.match(/\(([^)]*)\)\s*(?::|=>)/);
    if (!paramsMatch) {
      // 尝试匹配无返回类型的情况
      const simpleMatch = signatureText.match(/\(([^)]*)\)\s*$/m);
      if (!simpleMatch) {
        return undefined;
      }
      return this.extractTypesFromParams(simpleMatch[1]);
    }

    return this.extractTypesFromParams(paramsMatch[1]);
  }

  /**
   * 从参数字符串中提取类型（只保留类型，不含参数名）
   * 例如: "a: number, b: number" -> "(number, number)"
   */
  private extractTypesFromParams(paramsStr: string): string {
    if (!paramsStr.trim()) {
      return '()';
    }

    const params = paramsStr.split(',').map(param => {
      const trimmed = param.trim();
      // 检查是否可选参数 (name?: type)
      const isOptional = trimmed.includes('?:') || trimmed.includes('?');
      // 提取类型部分（冒号后面的内容）
      const colonMatch = trimmed.match(/\??:\s*(.+)/);
      if (!colonMatch) {
        // 没有类型注解，返回 any
        return isOptional ? 'any?' : 'any';
      }
      let type = colonMatch[1].trim();
      // 移除可能的默认值
      const eqIndex = type.indexOf('=');
      if (eqIndex !== -1) {
        type = type.substring(0, eqIndex).trim();
      }
      return isOptional ? `${type}?` : type;
    });

    return `(${params.join(', ')})`;
  }

  /**
   * 生成节点唯一 ID
   */
  private generateNodeId(item: CallHierarchyNode): string {
    const pathInfo = WorkspacePathResolver.toWorkspaceRelative(item.uri.fsPath);
    const data = `${pathInfo.relativePath}:${item.range.start.line}:${item.range.start.character}:${item.name}`;
    return crypto.createHash('md5').update(data).digest('hex').substring(0, 16);
  }

  /**
   * 应用简单布局（纵向排列）
   */
  private applyLayout(nodes: Node[]): void {
    // 按层级分组
    const levelGroups = new Map<number, Node[]>();
    
    // 简单策略：根据节点在 map 中的顺序分配层级
    const processedIds = new Set<string>();
    
    // 找到根节点（没有incoming edges的节点）
    const rootNodes = nodes.filter(node => 
      !this.edges.some(edge => edge.to === node.id)
    );

    // BFS 布局
    const queue: Array<{ node: Node; level: number }> = rootNodes.map(n => ({ node: n, level: 0 }));
    
    while (queue.length > 0) {
      const { node, level } = queue.shift()!;
      
      if (processedIds.has(node.id)) {
        continue;
      }
      
      processedIds.add(node.id);
      
      if (!levelGroups.has(level)) {
        levelGroups.set(level, []);
      }
      levelGroups.get(level)!.push(node);
      
      // 添加子节点
      const childEdges = this.edges.filter(e => e.from === node.id);
      for (const edge of childEdges) {
        const childNode = nodes.find(n => n.id === edge.to);
        if (childNode && !processedIds.has(childNode.id)) {
          queue.push({ node: childNode, level: level + 1 });
        }
      }
    }

    // MindElixir 会自动布局，不需要手动分配坐标
  }
}

/** 向后兼容的函数 */
export function generateCallGraphFromJson(json: string): CallGraphDocument {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed.nodes)) parsed.nodes = [];
    if (!Array.isArray(parsed.edges)) parsed.edges = [];
    return parsed as CallGraphDocument;
  } catch (e) {
    return { nodes: [], edges: [] };
  }
}

export function emptyCallGraph(): CallGraphDocument {
  return { nodes: [], edges: [] };
}


