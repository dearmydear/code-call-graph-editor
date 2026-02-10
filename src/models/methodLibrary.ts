/**
 * 数据模型：方法库
 * 用于保存常用方法，方便手动添加到调用图中
 */

import { SymbolSignature } from './callGraphDocument';

/**
 * 方法库中的方法条目
 */
export interface MethodLibraryItem {
  /** 唯一标识符（hash，稳定不变） */
  id: string;
  /** 方法/函数名（必填） */
  name: string;
  /** 符号特征，用于 LSP 查找 */
  symbol: SymbolSignature;
  /** 添加到库的时间戳 */
  addedAt: number;
  /** 备注说明（可选） */
  note?: string;
}

/**
 * 方法库
 */
export interface MethodLibrary {
  /** 库中的方法列表 */
  items: MethodLibraryItem[];
}

export default MethodLibrary;
