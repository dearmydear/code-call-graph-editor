// Internationalization support

let strings: Record<string, string> = {};

// Default strings (fallback when no i18n strings are provided by extension)
const defaults: Record<string, string> = {
  'toolbar.connectToNode': '连接到其他节点',
  'toolbar.bindMethod': '绑定代码方法',
  'toolbar.selectChildren': '选中所有子节点',
  'connectMode.clickTarget': '请点击目标节点完成连接，按 Esc 取消',
  'contextMenu.createCodeNode': '创建 Code 节点',
  'contextMenu.createNoteNode': '创建 Note 节点',
  'contextMenu.editNode': '编辑节点',
  'contextMenu.newTag': '新建标签...',
  'contextMenu.tags': '标签',
  'contextMenu.deleteNode': '删除节点',
  'contextMenu.deleteEdge': '删除边',
  'defaults.newNote': 'New Note',
  'defaults.newCode': 'New Code',
  'defaults.noteContent': '# Note\n- [ ] TODO\n\nClick to edit...',
  'prompt.enterTagName': '请输入标签名称:',
  'counter.nodes': '节点',
  'counter.edges': '边',
  'align.left': '左对齐',
  'align.centerH': '水平居中',
  'align.right': '右对齐',
  'align.top': '顶对齐',
  'align.centerV': '垂直居中',
  'align.bottom': '底对齐',
  'align.distributeH': '水平等距',
  'align.distributeV': '垂直等距',
  'layout.autoLayoutSelected': '自动布局(选中)',
  'layout.autoLayout': '自动布局（无选中=全局，有选中=局部）',
  'layout.directionTB': '布局方向：上→下',
  'layout.directionLR': '布局方向：左→右',
  'layout.fitCanvas': '适应画布',
  'layout.selectAlgorithm': '布局算法',
  'layout.group.hierarchical': '层级布局',
  'layout.group.tree': '树形布局',
};

export function initI18n(newStrings: Record<string, string>): void {
  strings = { ...newStrings };
}

export function t(key: string): string {
  return strings[key] || defaults[key] || key;
}
