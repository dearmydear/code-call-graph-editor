/**
 * Markdown 渲染工具模块
 * 封装 markdown-it 初始化与渲染，支持 GFM task-list checkbox
 */
import MarkdownIt from 'markdown-it';
// @ts-ignore - no typings available
import taskLists from 'markdown-it-task-lists';

// 初始化 markdown-it，启用 task-lists 插件（checkbox 可点击）
const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
}).use(taskLists, { enabled: true, label: true, labelAfter: true });

/**
 * 将 Markdown 文本渲染为 HTML
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  return md.render(text);
}

/**
 * 切换 Markdown 文本中指定索引的 checkbox 状态
 * @param text 原始 Markdown 文本
 * @param checkboxIndex 第几个 checkbox（从 0 开始）
 * @returns 更新后的 Markdown 文本
 */
export function toggleCheckbox(text: string, checkboxIndex: number): string {
  let currentIndex = 0;
  return text.replace(/\[([ xX])\]/g, (match, state) => {
    if (currentIndex === checkboxIndex) {
      currentIndex++;
      // 切换状态
      return state === ' ' ? '[x]' : '[ ]';
    }
    currentIndex++;
    return match;
  });
}

/**
 * 暗色主题下 Markdown 渲染的内联样式
 */
export const markdownStyles = `
.md-content {
  color: #d4d4d4;
  font-size: 12px;
  line-height: 1.5;
  padding: 8px 10px;
  word-wrap: break-word;
  overflow-wrap: break-word;
  text-align: left;
  user-select: none;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
}
.md-content h1, .md-content h2, .md-content h3,
.md-content h4, .md-content h5, .md-content h6 {
  color: #e0e0e0;
  margin: 4px 0 2px 0;
  line-height: 1.3;
}
.md-content h1 { font-size: 16px; }
.md-content h2 { font-size: 14px; }
.md-content h3 { font-size: 13px; }
.md-content p {
  margin: 2px 0;
}
.md-content ul, .md-content ol {
  padding-left: 18px;
  margin: 2px 0;
}
.md-content li {
  margin: 1px 0;
}
.md-content code {
  background: rgba(255,255,255,0.1);
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 11px;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}
.md-content pre {
  background: rgba(0,0,0,0.3);
  border-radius: 4px;
  padding: 6px 8px;
  margin: 4px 0;
  overflow-x: auto;
}
.md-content pre code {
  background: none;
  padding: 0;
}
.md-content blockquote {
  border-left: 3px solid #4a9eff;
  margin: 4px 0;
  padding: 2px 8px;
  color: #aaa;
}
.md-content a {
  color: #4a9eff;
  text-decoration: none;
}
.md-content strong {
  color: #e0e0e0;
}
.md-content hr {
  border: none;
  border-top: 1px solid #444;
  margin: 6px 0;
}
.md-content table {
  border-collapse: collapse;
  width: 100%;
  margin: 4px 0;
}
.md-content th, .md-content td {
  border: 1px solid #444;
  padding: 3px 6px;
  font-size: 11px;
}
.md-content th {
  background: rgba(255,255,255,0.05);
}
/* Task list checkbox 样式 */
.md-content .task-list-item {
  list-style: none;
  margin-left: -18px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.md-content .task-list-item input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
  accent-color: #4db8a4;
  pointer-events: auto;
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  vertical-align: middle;
}
.md-content .task-list-item label {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
`;
