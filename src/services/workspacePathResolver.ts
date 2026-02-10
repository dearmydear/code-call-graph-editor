/**
 * 工作区路径解析器 - Phase 3
 * 处理工作区路径和绝对路径之间的转换
 */
import * as vscode from 'vscode';
import * as path from 'path';

export interface WorkspaceInfo {
  name: string;
  rootPath: string;
  folders: readonly vscode.WorkspaceFolder[];
}

export interface RelativePathInfo {
  relativePath: string;
  workspaceFolder?: string;
}

/**
 * 工作区路径解析器
 */
export class WorkspacePathResolver {
  /**
   * 获取当前工作区信息
   */
  static getCurrentWorkspace(): WorkspaceInfo | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }

    const rootFolder = folders[0];
    return {
      name: vscode.workspace.name || rootFolder.name,
      rootPath: rootFolder.uri.fsPath,
      folders: folders
    };
  }

  /**
   * 将绝对路径转换为工作区相对路径
   */
  static toWorkspaceRelative(absolutePath: string): RelativePathInfo {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return { relativePath: absolutePath };
    }

    // 尝试找到包含此路径的工作区文件夹
    for (const folder of folders) {
      const folderPath = folder.uri.fsPath;
      if (absolutePath.startsWith(folderPath)) {
        const relativePath = path.relative(folderPath, absolutePath);
        return {
          relativePath: relativePath.replace(/\\/g, '/'), // 统一使用正斜杠
          workspaceFolder: folder.name
        };
      }
    }

    // 如果不在任何工作区中，返回相对于第一个工作区的路径
    const firstFolder = folders[0];
    const relativePath = path.relative(firstFolder.uri.fsPath, absolutePath);
    return {
      relativePath: relativePath.replace(/\\/g, '/'),
      workspaceFolder: firstFolder.name
    };
  }

  /**
   * 将相对路径转换为绝对路径
   */
  static toAbsolute(relativePath: string, workspaceFolderName?: string): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }

    let targetFolder: vscode.WorkspaceFolder | undefined;

    if (workspaceFolderName) {
      // 查找指定的工作区文件夹
      targetFolder = folders.find(f => f.name === workspaceFolderName);
    }

    // 如果没有指定或没找到，使用第一个工作区文件夹
    if (!targetFolder) {
      targetFolder = folders[0];
    }

    return path.join(targetFolder.uri.fsPath, relativePath);
  }

  /**
   * 解析符号位置为 vscode.Uri
   */
  static resolveSymbolLocation(symbol: { file: string; workspaceFolder?: string }): vscode.Uri | null {
    const absolutePath = this.toAbsolute(symbol.file, symbol.workspaceFolder);
    if (!absolutePath) {
      return null;
    }

    return vscode.Uri.file(absolutePath);
  }

  /**
   * 规范化路径（统一使用正斜杠）
   */
  static normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }
}

/** 向后兼容的函数 */
export function resolveWorkspacePath(uri: string): string {
  return uri;
}
