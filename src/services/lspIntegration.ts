/**
 * LSP 集成实现 - Phase 2
 * 使用 VS Code 内置的 LSP 命令查询调用层次
 */
import * as vscode from 'vscode';
import type { CallGraphDocument } from '../models/callGraphDocument';

/**
 * 调用层次节点数据结构
 */
export interface CallHierarchyNode {
  /** 符号名称 */
  name: string;
  /** 符号类型 */
  kind: vscode.SymbolKind;
  /** 文件 URI */
  uri: vscode.Uri;
  /** 符号范围 */
  range: vscode.Range;
  /** 调用者列表（谁调用了这个方法） */
  callers: CallHierarchyNode[];
  /** 被调用者列表（这个方法调用了谁） */
  callees: CallHierarchyNode[];
  /** 详细信息（可选） */
  detail?: string;
  /** 选择范围（可选） */
  selectionRange?: vscode.Range;
}

/**
 * LSP 调用层次查询提供者
 * Phase 2: 实现基于 VS Code LSP 的调用层次分析
 */
export class LSPCallHierarchyProvider {
  private visitedNodes: Set<string>;
  
  constructor() {
    this.visitedNodes = new Set();
  }

  /**
   * 获取指定位置的调用层次
   * @param document 文档
   * @param position 光标位置
   * @param depth 递归深度（默认 2）
   * @returns 调用层次树
   */
  async getCallHierarchy(
    document: vscode.TextDocument,
    position: vscode.Position,
    depth: number = 2
  ): Promise<CallHierarchyNode | null> {
    try {
      // 清空访问记录
      this.visitedNodes.clear();

      // 1. 准备调用层次查询
      const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        document.uri,
        position
      );

      if (!items || items.length === 0) {
        return null;
      }

      // 使用第一个匹配的符号
      const rootItem = items[0];
      
      // 2. 创建根节点
      const rootNode: CallHierarchyNode = {
        name: rootItem.name,
        kind: rootItem.kind,
        uri: rootItem.uri,
        range: rootItem.range,
        detail: rootItem.detail,
        selectionRange: rootItem.selectionRange,
        callers: [],
        callees: []
      };

      // 标记为已访问
      const nodeKey = this.getNodeKey(rootNode);
      this.visitedNodes.add(nodeKey);

      // 3. 递归获取调用者和被调用者
      if (depth > 0) {
        rootNode.callers = await this.getIncomingCalls(rootItem, depth - 1);
        rootNode.callees = await this.getOutgoingCalls(rootItem, depth - 1);
      }

      return rootNode;
    } catch (error) {
      console.error('获取调用层次失败:', error);
      return null;
    }
  }

  /**
   * 递归获取调用者（incoming calls）
   * @param item 当前符号
   * @param remainingDepth 剩余深度
   * @returns 调用者列表
   */
  private async getIncomingCalls(
    item: vscode.CallHierarchyItem,
    remainingDepth: number
  ): Promise<CallHierarchyNode[]> {
    if (remainingDepth < 0) {
      return [];
    }

    try {
      const incomingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        'vscode.provideIncomingCalls',
        item
      );

      if (!incomingCalls || incomingCalls.length === 0) {
        return [];
      }

      const callers: CallHierarchyNode[] = [];

      for (const call of incomingCalls) {
        const callerItem = call.from;
        const nodeKey = this.getNodeKey({
          name: callerItem.name,
          uri: callerItem.uri,
          range: callerItem.range
        } as CallHierarchyNode);

        // 防止循环引用
        if (this.visitedNodes.has(nodeKey)) {
          continue;
        }

        this.visitedNodes.add(nodeKey);

        const callerNode: CallHierarchyNode = {
          name: callerItem.name,
          kind: callerItem.kind,
          uri: callerItem.uri,
          range: callerItem.range,
          detail: callerItem.detail,
          selectionRange: callerItem.selectionRange,
          callers: remainingDepth > 0 ? await this.getIncomingCalls(callerItem, remainingDepth - 1) : [],
          callees: []
        };

        callers.push(callerNode);
      }

      return callers;
    } catch (error) {
      console.error('获取调用者失败:', error);
      return [];
    }
  }

  /**
   * 递归获取被调用者（outgoing calls）
   * @param item 当前符号
   * @param remainingDepth 剩余深度
   * @returns 被调用者列表
   */
  private async getOutgoingCalls(
    item: vscode.CallHierarchyItem,
    remainingDepth: number
  ): Promise<CallHierarchyNode[]> {
    if (remainingDepth < 0) {
      return [];
    }

    try {
      const outgoingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
        'vscode.provideOutgoingCalls',
        item
      );

      if (!outgoingCalls || outgoingCalls.length === 0) {
        return [];
      }

      const callees: CallHierarchyNode[] = [];

      for (const call of outgoingCalls) {
        const calleeItem = call.to;
        const nodeKey = this.getNodeKey({
          name: calleeItem.name,
          uri: calleeItem.uri,
          range: calleeItem.range
        } as CallHierarchyNode);

        // 防止循环引用
        if (this.visitedNodes.has(nodeKey)) {
          continue;
        }

        this.visitedNodes.add(nodeKey);

        const calleeNode: CallHierarchyNode = {
          name: calleeItem.name,
          kind: calleeItem.kind,
          uri: calleeItem.uri,
          range: calleeItem.range,
          detail: calleeItem.detail,
          selectionRange: calleeItem.selectionRange,
          callers: [],
          callees: remainingDepth > 0 ? await this.getOutgoingCalls(calleeItem, remainingDepth - 1) : []
        };

        callees.push(calleeNode);
      }

      return callees;
    } catch (error) {
      console.error('获取被调用者失败:', error);
      return [];
    }
  }

  /**
   * 生成节点唯一键（用于防止循环引用）
   */
  private getNodeKey(node: Partial<CallHierarchyNode>): string {
    return `${node.uri?.toString()}:${node.range?.start.line}:${node.range?.start.character}:${node.name}`;
  }
}

/** 初始化 LSP（占位） */
export async function initializeLsp(): Promise<void> {
  // TODO: 在需要时初始化 language server
  return;
}

/** 关闭/清理 LSP（占位） */
export async function shutdownLsp(): Promise<void> {
  // TODO: 清理资源
  return;
}

/** 示例：请求代码分析并返回一个 CallGraphDocument（占位） */
export async function requestCallGraphAnalysis(source: string): Promise<CallGraphDocument> {
  // 占位实现：返回一个空文档
  return { nodes: [], edges: [] } as CallGraphDocument;
}
