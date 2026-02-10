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
   * 支持多种编程语言的 Hover 格式：
   * - TypeScript: ```typescript\n(method) Class.method(a: number, b: string): void\n```
   * - Python:     ```python\n(function) def func(a: int, b: str) -> None\n```
   * - Go:         ```go\nfunc Foo(a int, b string) error\n```
   * - Java/C#:    ```java\nvoid method(int a, String b)\n```
   * - Rust:       ```rust\nfn foo(a: i32, b: &str) -> Result<()>\n```
   * - PHP:        ```php\nfunction foo(int $a, string $b): void\n```
   * - Ruby/Lua:   def func(a, b) / function func(a, b)
   */
  private extractSignatureFromHover(hoverText: string): string | undefined {
    if (!hoverText) {
      return undefined;
    }

    // 匹配任意语言的代码块（```typescript, ```python, ```go, ```csharp 等）
    const codeBlockMatch = hoverText.match(/```\w*\s*\n?([\s\S]*?)\n?```/);
    const signatureText = codeBlockMatch ? codeBlockMatch[1].trim() : hoverText;

    // 模式1: 括号后跟返回类型指示符
    // TypeScript/Rust/Kotlin:  (...): ReturnType  或  (...) => ReturnType
    // Python/Rust:             (...) -> ReturnType
    // PHP:                     (...): ReturnType
    const withReturnType = signatureText.match(/\(([^)]*)\)\s*(?::|=>|->)/);
    if (withReturnType) {
      return this.extractTypesFromParams(withReturnType[1]);
    }

    // 模式2: 括号在行末（无返回类型声明，如 Ruby/Lua/Python 无注解）
    const atEnd = signatureText.match(/\(([^)]*)\)\s*$/m);
    if (atEnd) {
      return this.extractTypesFromParams(atEnd[1]);
    }

    return undefined;
  }

  /**
   * 从参数字符串中提取类型信息
   * 自动检测参数格式，支持多种编程语言
   *
   * 支持的格式：
   * - "name: Type"       → TypeScript/Python/Rust/Kotlin/Swift（冒号分隔）
   * - "Type name"        → Java/C#/C++/Dart（类型在前）
   * - "name Type"        → Go（类型在后，无冒号）
   * - "Type $name"       → PHP（$前缀变量名）
   * - "*args, **kwargs"  → Python 可变参数
   * - "...args"          → JS/TS rest 参数
   * - "name=default"     → Python 默认值参数
   * - "name"             → 动态语言（无类型注解，保留参数名）
   */
  private extractTypesFromParams(paramsStr: string): string {
    if (!paramsStr.trim()) {
      return '()';
    }

    // 智能分割参数（处理泛型中的逗号，如 Map<K, V>）
    const paramTokens = this.splitParams(paramsStr);

    // 检测参数风格
    const style = this.detectParamStyle(paramTokens);

    const types = paramTokens.map(param => {
      return this.extractTypeFromSingleParam(param.trim(), style);
    }).filter(t => t !== '');

    return `(${types.join(', ')})`;
  }

  /**
   * 智能分割参数列表
   * 处理嵌套泛型中的逗号，如 Map<string, number> 不会被错误分割
   */
  private splitParams(paramsStr: string): string[] {
    const result: string[] = [];
    let current = '';
    let depth = 0;

    for (const char of paramsStr) {
      if (char === '<' || char === '[' || char === '{') {
        depth++;
        current += char;
      } else if (char === '>' || char === ']' || char === '}') {
        depth--;
        current += char;
      } else if (char === ',' && depth === 0) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      result.push(current);
    }

    return result;
  }

  /**
   * 检测参数风格
   * 通过分析参数列表的格式来判断语言类型
   */
  private detectParamStyle(params: string[]): 'colon' | 'type-before' | 'type-after-go' | 'php' | 'dynamic' {
    for (const param of params) {
      const trimmed = param.trim();
      if (!trimmed) { continue; }

      // 跳过特殊参数（*args, **kwargs, ...rest, self, this 等）
      if (trimmed.startsWith('*') || trimmed.startsWith('...')) { continue; }
      if (trimmed === 'self' || trimmed === 'cls' || trimmed === 'this') { continue; }

      // PHP 风格: 包含 $
      if (trimmed.includes('$')) { return 'php'; }

      // 冒号风格: name: Type（TypeScript/Python/Rust/Kotlin/Swift）
      if (/\w\s*\??\s*:/.test(trimmed)) { return 'colon'; }

      // 多 token 参数（有空格分隔）
      const cleanParam = trimmed.replace(/\s*=\s*.*$/, ''); // 去掉默认值
      const tokens = cleanParam.split(/\s+/).filter(t => t);
      if (tokens.length >= 2) {
        // 判断 "Type name"（Java/C#） vs "name Type"（Go）
        if (this.looksLikeType(tokens[0])) {
          return 'type-before';
        }
        return 'type-after-go';
      }
    }

    // 无类型注解 — 动态语言（Python 无注解 / Ruby / Lua / JS 等）
    return 'dynamic';
  }

  /**
   * 启发式判断：一个 token 是否看起来像类型名
   * 用于区分 "Type name"（Java）和 "name Type"（Go）
   */
  private looksLikeType(token: string): boolean {
    // 常见原始类型关键字
    const typeKeywords = new Set([
      // Java/C/C++
      'int', 'float', 'double', 'long', 'short', 'byte', 'char', 'bool', 'boolean',
      'string', 'void', 'unsigned', 'signed', 'const',
      // C# / Dart
      'String', 'Object', 'List', 'Map', 'Set', 'Array', 'Dictionary',
      'Int32', 'Int64', 'Single', 'Double', 'Boolean', 'Byte',
      // 常见泛型容器
      'ArrayList', 'HashMap', 'HashSet', 'LinkedList', 'TreeMap',
    ]);

    if (typeKeywords.has(token)) { return true; }

    // Java/C#/Dart 约定：类型名以大写字母开头
    if (/^[A-Z]/.test(token)) { return true; }

    // 数组类型: int[], String[]
    if (token.endsWith('[]')) { return true; }

    // 指针/引用类型: int*, char*, int&
    if (/[*&]$/.test(token)) { return true; }

    return false;
  }

  /**
   * 从单个参数中提取类型（或在无类型时保留参数名）
   */
  private extractTypeFromSingleParam(
    param: string,
    style: 'colon' | 'type-before' | 'type-after-go' | 'php' | 'dynamic'
  ): string {
    if (!param) { return ''; }

    // ── 特殊参数处理 ──

    // Python *args, **kwargs
    if (param.startsWith('**')) {
      const colonMatch = param.match(/^\*\*\w+\s*:\s*(.+)/);
      return colonMatch ? `**${colonMatch[1].trim()}` : param;
    }
    if (param.startsWith('*')) {
      const colonMatch = param.match(/^\*\w+\s*:\s*(.+)/);
      return colonMatch ? `*${colonMatch[1].trim()}` : param;
    }

    // JS/TS rest 参数 ...args
    if (param.startsWith('...')) {
      const colonMatch = param.match(/^\.\.\.\w+\s*:\s*(.+)/);
      if (colonMatch) { return `...${colonMatch[1].trim()}`; }
      return param;
    }

    // Python self/cls, JS this — 跳过
    if (param === 'self' || param === 'cls' || param === 'this') { return ''; }

    // 可选参数检测
    const isOptional = param.includes('?:') || (param.includes('?') && style === 'colon');

    switch (style) {
      case 'colon': {
        // TypeScript/Python/Rust/Kotlin: name: Type 或 name?: Type
        const colonMatch = param.match(/^\w[\w?]*\s*\??\s*:\s*(.+)/);
        if (colonMatch) {
          let type = colonMatch[1].trim();
          // 去除默认值
          const eqIndex = type.indexOf('=');
          if (eqIndex !== -1) {
            type = type.substring(0, eqIndex).trim();
          }
          return isOptional ? `${type}?` : type;
        }
        // 同一签名中可能有部分参数无类型 → 保留参数名
        return this.extractParamName(param);
      }

      case 'type-before': {
        // Java/C#/C++/Dart: Type name  或  Type name = default
        const cleanParam = param.replace(/\s*=\s*.*$/, '').trim();
        const tokens = cleanParam.split(/\s+/);
        if (tokens.length >= 2) {
          // 除最后一个 token（参数名）外，其余都是类型（如 "unsigned int name"）
          return tokens.slice(0, -1).join(' ');
        }
        return param;
      }

      case 'type-after-go': {
        // Go: name Type
        const tokens = param.trim().split(/\s+/);
        if (tokens.length >= 2) {
          return tokens.slice(1).join(' ');
        }
        return param;
      }

      case 'php': {
        // PHP: ?Type $name  或  $name
        const phpMatch = param.match(/^(\??\w[\w\\]*)\s+\$/);
        if (phpMatch) { return phpMatch[1]; }
        // $name 无类型 → 提取变量名（去掉 $）
        const nameMatch = param.match(/\$(\w+)/);
        return nameMatch ? nameMatch[1] : param;
      }

      case 'dynamic':
      default: {
        // 动态语言（Python 无注解 / Ruby / Lua / JS 等）— 保留参数名
        return this.extractParamName(param);
      }
    }
  }

  /**
   * 从参数中提取纯参数名（去除默认值等修饰）
   */
  private extractParamName(param: string): string {
    // 去除默认值: name=value → name
    const eqMatch = param.match(/^(\w+)\s*=/);
    if (eqMatch) { return eqMatch[1]; }

    // 提取纯名称
    const nameMatch = param.match(/^(\w+)/);
    return nameMatch ? nameMatch[1] : param;
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


