# Code Call Graph Editor

**可视化代码调用关系的 VS Code 扩展** — 函数/方法调用图，支持图形化编辑、代码跳转、多种布局算法。

[English](README.md) | 简体中文

![整体效果](images/overview.gif)

---

## 安装

**VS Code Marketplace**

1. 打开 VS Code
2. 进入扩展面板（`Ctrl+Shift+X`）
3. 搜索 `Code Call Graph Editor`
4. 点击 **安装**


---

## 快速上手

1. 在代码编辑器中，将光标放在函数/方法定义上
2. 右键选择 **Create Call Graph**，或按 `Ctrl+Shift+G`
3. 自动生成 `.callgraph.json` 文件并打开图形编辑器
4. 双击节点可跳转到对应源码位置

---

## 核心功能

### 一键生成调用图

将光标放在任意函数/方法上，按 `Ctrl+Shift+G` 即可自动分析调用链并生成调用图。基于 LSP Call Hierarchy 协议，支持所有提供该能力的语言。
![一键生成调用图](images/generate-callgraph.gif)

---

### 图形化编辑器

基于 [AntV X6](https://x6.antv.antgroup.com/) 的画布编辑器，支持丰富的交互操作：

- **双击画布空白处** — 创建 Code 节点
- **右键画布** — 创建 Code 节点或 Note 节点
- **拖拽节点** — 自由移动
- **框选/多选** — 批量操作
- **工具栏连接按钮** — 进入连接模式，点击目标节点创建边
- **复制/粘贴** — `Ctrl+C` / `Ctrl+V`
- **撤销/重做** — `Ctrl+Z` / `Ctrl+Y`


![图形化编辑器](images/editor-operations.gif)

---

### 代码跳转与方法绑定

**代码跳转：** 双击 Code 节点，自动在编辑器中打开对应源文件并高亮定位到方法定义处。

**方法库：** 在代码中按 `Ctrl+Shift+M` 将光标处的方法加入方法库。在画布中点击节点工具栏的绑定按钮，从方法库中选择方法绑定到节点。




![代码跳转与方法绑定](images/code-navigation.gif)

---

### 多种布局算法

内置 4 种图布局算法，通过右上角下拉菜单切换：

| 算法 | 特点 |
|------|------|
| **Dagre** | 经典层次布局，适合大多数调用图（默认） |
| **ELK Layered** | 高级层次布局，交叉最小化效果更好 |
| **ELK Tree** | 树形布局，适合纯树状调用关系 |
| **Custom (BFS)** | 自定义广度优先布局 |

支持 **上→下（TB）** 和 **左→右（LR）** 两种方向，切换方向时所有边的路由自动刷新。

支持 **全局布局**（无选中节点时）和 **局部布局**（仅布局选中的节点）。
![布局算法](images/layout-algorithms.gif)

---

### 对齐与等距分布

选中 2 个及以上节点时，画布底部自动弹出对齐工具栏：

- **对齐：** 左对齐、水平居中、右对齐、顶对齐、垂直居中、底对齐
- **等距分布：** 水平等距、垂直等距（需 3 个及以上节点）
- **自动布局（选中）：** 仅对选中节点执行布局

拖拽节点时还有 **吸附辅助线** 帮助手动对齐。


![对齐与等距分布](images/alignment-tools.gif)

---

### 标签系统

为 Code 节点添加彩色标签进行分类标注：

- **预定义标签：** 循环、判断、异步、入口、关键、待办（颜色可配置）
- **自定义标签：** 右键节点 → 标签 → 新建标签
- **切换标签：** 右键节点 → 标签菜单中勾选/取消

标签显示在节点底部，以彩色药丸形式呈现。


![标签系统](images/tag-system.gif)

---

### Note 节点与 Markdown

Note 节点支持完整的 Markdown 渲染，适合在调用图中添加说明和备注：

- 标题、列表、粗体/斜体、代码块、表格
- **可交互 Checkbox：** 使用 `- [ ]` / `- [x]` 语法，点击即可切换状态
- **自由调整大小：** 选中后拖拽右下角手柄
- **双击编辑：** 进入原始 Markdown 编辑模式


![Note 节点](images/note-markdown.gif)

---

### 边高亮与选中效果

- **选中节点** 时，与该节点关联的所有边自动高亮为蓝色
- **直接选中边** 时，以更粗的样式和更高的渲染层级显示
- 多层 zIndex 管理，重叠的边也能清晰区分

---

### AI / Copilot 集成

本项目内置 [.github/copilot-instructions.md](.github/copilot-instructions.md) 文件，定义了调用图数据格式的 AI 指令。

**使用方式一：Copilot 自动识别**

如果你的项目中有 `.github/copilot-instructions.md`，VS Code Copilot 会自动读取。直接对话即可：

> *"分析 src/services/calculator.ts 中 Calculator 类的调用关系，生成 callgraph.json"*

**使用方式二：复制提示词**

如果使用其他 AI 工具，可以复制以下提示词模板，将 `{文件路径或代码}` 替换为你的实际内容：

```
请分析以下代码的函数调用关系，生成 XX.callgraph.json 文件。

要求：
- 输出格式为 JSON，包含 nodes 和 edges 两个数组
- 每个 node 包含: id, label, type("code"), symbol(name, uri, containerName, line, signature)
- 每个 edge 包含: from(调用方id), to(被调用方id)
- label 格式：如果是类方法，用 "方法名\n类名"（\n 换行）
- line 从 0 开始计数
- uri 使用相对于工作区的路径
- signature 只写参数类型，如 "(number, string)"

代码：
{文件路径或代码}
```

AI 会输出符合格式的 `.callgraph.json` 内容，直接保存为 `xxx.callgraph.json` 文件即可在编辑器中打开。

---

## 快捷键

### 全局快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+G` | 从光标处的方法生成调用图 |
| `Ctrl+Shift+M` | 将光标处的方法加入方法库 |

### 画布内快捷键

| 快捷键 | 功能 |
|--------|------|
| `Delete` / `Backspace` | 删除选中的节点或边 |
| `Ctrl+Z` | 撤销 |
| `Ctrl+Y` / `Ctrl+Shift+Z` | 重做 |
| `Ctrl+C` | 复制选中节点 |
| `Ctrl+V` | 粘贴节点 |
| `F2` | 编辑选中节点/边的文本 |
| `Space` | 全选文本并编辑 |
| `Esc` | 取消连接模式 / 取消编辑 |
| 直接输入字符 | 清空文本并输入（选中单个节点/边时） |

---

## 配置项

在 VS Code Settings 中搜索 `callGraph` 进行配置：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `callGraph.predefinedTags` | array | 6 个预定义标签 | 预定义标签列表（名称 + 颜色） |
| `callGraph.codeNodeColor` | object | `{fill: "#1e3a5f", stroke: "#4a9eff"}` | Code 节点颜色 |
| `callGraph.noteNodeColor` | object | `{fill: "#1A1A1A", stroke: "#555555"}` | Note 节点颜色 |
| `callGraph.unboundCodeNodeColor` | object | `{fill: "#3d2020", stroke: "#d48a8a"}` | 未绑定方法的 Code 节点颜色 |
| `callGraph.showFileNameTag` | boolean | `false` | 是否自动显示文件名标签 |
| `callGraph.fileNameTagColor` | string | `"#607D8B"` | 文件名标签颜色 |
| `callGraph.removeMethodAfterBind` | boolean | `false` | 绑定方法后是否从方法库中移除 |

---

## 文件格式

调用图以 `.callgraph.json` 格式存储，本质是一个标准 JSON 文件：

```json
{
  "title": "Calculator 调用图",
  "nodes": [
    {
      "id": "node-1",
      "label": "add\nCalculator",
      "type": "code",
      "symbol": {
        "name": "add",
        "uri": "src/calculator.ts",
        "containerName": "Calculator",
        "line": 22,
        "signature": "(number, number)"
      },
      "tags": ["入口"]
    },
    {
      "id": "note-1",
      "label": "说明",
      "type": "note",
      "content": "# 备注\n这是一段说明文字"
    }
  ],
  "edges": [
    {
      "from": "node-1",
      "to": "node-2",
      "type": "call"
    }
  ]
}
```

**节点类型：**
- `code` — 代码节点，绑定到源文件中的函数/方法
- `note` — 笔记节点，支持 Markdown 内容

**边类型：**
- `call` — 调用关系（灰色箭头）
- `explain` — 说明关系（金色箭头）

---

## 支持的语言

本扩展基于 VS Code LSP（语言服务器协议）的 **Call Hierarchy** 能力，理论上支持所有提供该能力的语言：

- TypeScript / JavaScript
- C# (.NET)
- Java
- Python
- Go
- C / C++
- Rust
- 以及其他支持 Call Hierarchy 的语言服务扩展

> 手动创建节点和通过 AI 生成调用图不依赖 LSP，支持任何语言。

---

## 多语言支持

- 中文（简体）
- English

扩展会根据 VS Code 的语言设置自动切换。

---

## 捐赠

如果这个项目对你有帮助，欢迎请我喝杯咖啡 :)

**支付宝扫码捐赠：**


<img src="images/ZhiFuBao.png" alt="支付宝捐赠" width="200">

感谢你的支持！

---

## License

[MIT](LICENSE)
