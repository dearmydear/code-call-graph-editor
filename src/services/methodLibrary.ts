import * as vscode from 'vscode';

/**
 * 方法库中的方法项
 */
export interface MethodItem {
  id: string;                    // 唯一标识
  name: string;                  // 方法名
  uri: string;                   // 相对文件路径
  containerName?: string;        // 容器名（类名、模块名等）
  line: number;                  // 行号
  signature?: string;            // 方法签名
  addedAt: number;               // 添加时间戳
}

/**
 * 方法库管理器
 * 使用 workspaceState 存储方法列表
 */
export class MethodLibrary {
  private static readonly STORAGE_KEY = 'callGraph.methodLibrary';

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * 获取所有方法
   */
  getAll(): MethodItem[] {
    return this.context.workspaceState.get<MethodItem[]>(MethodLibrary.STORAGE_KEY, []);
  }

  /**
   * 添加方法到库
   */
  async add(method: Omit<MethodItem, 'id' | 'addedAt'>): Promise<MethodItem> {
    const methods = this.getAll();

    // 检查是否已存在（同一文件、同一行）
    const existing = methods.find(m => m.uri === method.uri && m.line === method.line);
    if (existing) {
      vscode.window.showInformationMessage(vscode.l10n.t('Method "{0}" is already in the method library', method.name));
      return existing;
    }

    const newMethod: MethodItem = {
      ...method,
      id: `method-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      addedAt: Date.now(),
    };

    methods.push(newMethod);
    await this.context.workspaceState.update(MethodLibrary.STORAGE_KEY, methods);

    vscode.window.showInformationMessage(vscode.l10n.t('Added method "{0}" to method library', method.name));
    return newMethod;
  }

  /**
   * 从库中移除方法
   */
  async remove(id: string): Promise<void> {
    const methods = this.getAll();
    const index = methods.findIndex(m => m.id === id);
    if (index >= 0) {
      const removed = methods.splice(index, 1)[0];
      await this.context.workspaceState.update(MethodLibrary.STORAGE_KEY, methods);
      vscode.window.showInformationMessage(vscode.l10n.t('Removed "{0}" from method library', removed.name));
    }
  }

  /**
   * 清空方法库
   */
  async clear(): Promise<void> {
    await this.context.workspaceState.update(MethodLibrary.STORAGE_KEY, []);
    vscode.window.showInformationMessage(vscode.l10n.t('Method library cleared'));
  }

  /**
   * 根据ID获取方法
   */
  getById(id: string): MethodItem | undefined {
    return this.getAll().find(m => m.id === id);
  }
}

/**
 * 从当前光标位置获取符号信息
 */
export async function getSymbolAtCursor(
  editor: vscode.TextEditor
): Promise<Omit<MethodItem, 'id' | 'addedAt'> | null> {
  const document = editor.document;
  const position = editor.selection.active;
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  if (!workspaceFolder) {
    vscode.window.showErrorMessage(vscode.l10n.t('No open workspace'));
    return null;
  }

  try {
    // 获取文档符号
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );

    if (!symbols || symbols.length === 0) {
      vscode.window.showWarningMessage(vscode.l10n.t('No recognizable symbols in current file'));
      return null;
    }

    // 查找包含光标位置的符号
    const symbol = findSymbolAtPosition(symbols, position);

    if (!symbol) {
      vscode.window.showWarningMessage(vscode.l10n.t('No method or function found at cursor position'));
      return null;
    }

    // 只允许方法、函数、构造函数
    const allowedKinds = [
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Constructor,
    ];

    if (!allowedKinds.includes(symbol.kind)) {
      vscode.window.showWarningMessage(vscode.l10n.t('"{0}" is not a method or function', symbol.name));
      return null;
    }

    // 计算相对路径
    const relativePath = vscode.workspace.asRelativePath(document.uri);

    // 查找容器名
    const containerName = findContainerName(symbols, symbol);

    // 规范化符号名：不同语言的 DocumentSymbolProvider 返回格式不同
    // C# 会在 name 中包含参数和返回类型，需要拆分
    const normalized = normalizeSymbolName(symbol.name, symbol.detail);

    return {
      name: normalized.bareName,
      uri: relativePath,
      containerName,
      line: symbol.selectionRange.start.line,
      signature: normalized.signature,
    };
  } catch (error) {
    console.error('获取符号失败:', error);
    vscode.window.showErrorMessage(vscode.l10n.t('Failed to get symbol: {0}', String(error)));
    return null;
  }
}

/**
 * 递归查找包含指定位置的符号
 */
function findSymbolAtPosition(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position
): vscode.DocumentSymbol | null {
  for (const symbol of symbols) {
    if (symbol.range.contains(position)) {
      // 先检查子符号
      if (symbol.children && symbol.children.length > 0) {
        const child = findSymbolAtPosition(symbol.children, position);
        if (child) {
          return child;
        }
      }
      // 返回当前符号
      return symbol;
    }
  }
  return null;
}

/**
 * 查找符号的容器名（父级类/模块名）
 */
function findContainerName(
  symbols: vscode.DocumentSymbol[],
  target: vscode.DocumentSymbol
): string | undefined {
  for (const symbol of symbols) {
    if (symbol.children) {
      for (const child of symbol.children) {
        if (child === target) {
          return symbol.name;
        }
      }
      // 递归搜索子符号的子集
      if (symbol.children.length > 0) {
        const containerInChildren = findContainerName(symbol.children, target);
        if (containerInChildren) {
          return containerInChildren;
        }
      }
    }
  }
  return undefined;
}

/**
 * 从符号名称中提取纯方法名和签名
 * 不同语言的 DocumentSymbolProvider 返回格式不同：
 * - TypeScript: name="methodName", detail="(param: type): returnType"
 * - C#: name="MethodName(ParamType1, ParamType2?) : ReturnType", detail="ReturnType"
 * - 其他语言可能有更多变体
 *
 * 此函数统一提取出：
 * - bareName: 纯方法名（不含参数和返回类型）
 * - signature: 参数签名，格式 "(type1, type2)"
 */
export function normalizeSymbolName(rawName: string, rawDetail?: string): { bareName: string; signature?: string } {
  // 匹配 "MethodName(params) : ReturnType" 或 "MethodName(params)" 格式
  const match = rawName.match(/^([^(]+)\(([^)]*)\)\s*(?::\s*.*)?$/);
  if (match) {
    const bareName = match[1].trim();
    const paramsStr = match[2].trim();
    const signature = `(${paramsStr})`;
    return { bareName, signature };
  }

  // 没有括号，纯方法名
  return { bareName: rawName, signature: rawDetail || undefined };
}

/**
 * 将方法名清理为安全的文件名
 * 移除 Windows 不允许的字符：< > : " / \ | ? *
 * 同时移除括号等特殊字符
 */
export function sanitizeFileName(name: string): string {
  // 先提取纯方法名
  const { bareName } = normalizeSymbolName(name);
  // 替换文件系统不允许的字符
  return bareName.replace(/[<>:"/\\|?*()]/g, '');
}
