import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// 最小化样式 - 不覆盖 React Flow 默认样式
const style = document.createElement('style');
style.textContent = `
  html, body, #root {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
`;
document.head.appendChild(style);

// 渲染 React 应用
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
} else {
  console.error('Root container not found');
}
