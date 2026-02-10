import React, { memo } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';

// 节点数据接口
export interface CodeNodeData {
  label: string;
  type?: 'code' | 'note';
  tags?: string[];
  symbol?: {
    name: string;
    uri: string;
    containerName?: string;
    line?: number;
    signature?: string;
  };
  status?: 'normal' | 'broken';
  tagColors?: Record<string, string>;
}

// 自定义代码节点组件
export const CodeNode = memo(({ data, selected }: NodeProps<CodeNodeData>) => {
  const isBroken = data.status === 'broken';
  const isNote = data.type === 'note';
  
  return (
    <div
      style={{
        padding: '10px 15px',
        borderRadius: '8px',
        background: isNote 
          ? 'var(--vscode-editorWidget-background, #2d2d30)'
          : 'var(--vscode-editor-background, #1e1e1e)',
        border: `2px solid ${
          selected
            ? 'var(--vscode-focusBorder, #007fd4)'
            : isBroken
            ? '#f44336'
            : isNote
            ? '#FFC107'
            : 'var(--vscode-button-background, #0e639c)'
        }`,
        color: 'var(--vscode-editor-foreground, #d4d4d4)',
        minWidth: '120px',
        maxWidth: '250px',
        cursor: 'pointer',
        boxShadow: selected ? '0 0 10px rgba(0, 127, 212, 0.5)' : 'none',
      }}
    >
      {/* 输入连接点 */}
      <Handle
        type="target"
        position={Position.Top}
        id="target"
        isConnectable={true}
        style={{
          background: 'var(--vscode-button-background, #0e639c)',
          width: 10,
          height: 10,
          border: '2px solid var(--vscode-editor-background, #1e1e1e)',
        }}
      />

      {/* 节点内容 */}
      <div style={{ fontWeight: 600, marginBottom: data.tags?.length ? 6 : 0 }}>
        {data.label}
      </div>

      {/* 容器名（类名） */}
      {data.symbol?.containerName && (
        <div
          style={{
            fontSize: '11px',
            color: 'var(--vscode-descriptionForeground, #8a8a8a)',
            marginBottom: 4,
          }}
        >
          {data.symbol.containerName}
        </div>
      )}

      {/* 签名 */}
      {data.symbol?.signature && (
        <div
          style={{
            fontSize: '10px',
            color: 'var(--vscode-textPreformat-foreground, #d7ba7d)',
            fontFamily: 'var(--vscode-editor-font-family, Consolas)',
            marginBottom: 4,
          }}
        >
          {data.symbol.signature}
        </div>
      )}

      {/* 标签 */}
      {data.tags && data.tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: 4 }}>
          {data.tags.map((tag, index) => (
            <span
              key={index}
              style={{
                fontSize: '10px',
                padding: '2px 6px',
                borderRadius: '4px',
                background: data.tagColors?.[tag] || '#607D8B',
                color: '#fff',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* 输出连接点 */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="source"
        isConnectable={true}
        style={{
          background: 'var(--vscode-button-background, #0e639c)',
          width: 10,
          height: 10,
          border: '2px solid var(--vscode-editor-background, #1e1e1e)',
        }}
      />
    </div>
  );
});

CodeNode.displayName = 'CodeNode';
