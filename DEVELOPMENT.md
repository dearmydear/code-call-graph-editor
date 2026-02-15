# Call Graph Editor — 开发文档

## 项目概述

**Call Graph Editor** 是一个 VS Code 自定义编辑器扩展，用于可视化代码中函数/方法的调用关系。用户可以通过 `*.callgraph.json` 文件来查看和编辑调用图。

### 核心功能
- 自定义编辑器可视化 `.callgraph.json` 文件
- LSP 集成：通过调用层次（Call Hierarchy）自动生成调用图
- 方法库：从代码中收集方法，稍后绑定到调用图节点
- 代码跳转：点击节点跳转到源代码定义位置
- 多语言支持：支持 TypeScript、Python、Go、Java、C#、Rust、Ruby、PHP 等语言

---

## 项目结构

```
code-call-graph-editor/
├── package.json               # 扩展清单、命令、配置、贡献点
├── tsconfig.json              # TypeScript 配置
├── esbuild.webview.mjs        # WebView 打包脚本 (esbuild)
│
├── src/                       # 扩展宿主端代码 (Node.js 环境)
│   ├── extension.ts           # 扩展入口：注册命令、激活/停用
│   ├── callGraphEditor.ts     # 自定义编辑器 Provider（旧版 MindElixir 实现）
│   ├── callGraphEditorReactFlow.ts  # 自定义编辑器 Provider（当前使用的 X6 实现）
│   ├── dispose.ts             # 资源清理工具
│   ├── util.ts                # 工具函数 (getNonce 等)
│   │
│   ├── models/
│   │   ├── callGraphDocument.ts    # 核心数据模型：Node, Edge, SymbolSignature
│   │   └── methodLibrary.ts        # (已迁移到 services/)
│   │
│   ├── services/
│   │   ├── lspIntegration.ts       # LSP 调用层次查询
│   │   ├── callGraphGenerator.ts   # 从 LSP 数据生成 CallGraphDocument
│   │   ├── methodLibrary.ts        # 方法库管理 + normalizeSymbolName
│   │   └── workspacePathResolver.ts # 工作区路径解析工具
│   │
│   └── webview/               # React Flow WebView（实验中，未启用）
│       ├── App.tsx
│       ├── index.tsx
│       ├── nodes/CodeNode.tsx
│       └── utils/dataConverter.ts
│
├── src/webview-x6/            # AntV X6 WebView（当前使用）
│   ├── index.ts               # X6 图形编辑器主文件
│   ├── i18n.ts                # WebView 端国际化
│   ├── layoutEngines.ts       # 布局引擎 (dagre, elk)
│   └── markdownRenderer.ts    # Markdown 渲染（说明节点用）
│
├── media/                     # WebView 静态资源
│   ├── callgraph-webview.js   # esbuild 打包输出，由 webview-x6 编译
│   ├── MindElixir.js          # 旧版 MindElixir 库
│   └── *.css                  # 样式文件
│
├── l10n/                      # 本地化翻译文件
│   └── bundle.l10n.zh-cn.json
│
├── exampleFiles/              # 示例文件
│   ├── test-lsp-example.ts
│   └── *.callgraph.json
│
└── .github/
    └── copilot-instructions.md  # AI 生成调用图的指令
```

---

## 架构说明

### 宿主端 vs WebView 端

VS Code 插件有两个运行环境：

| 环境 | 入口 | 作用 | 可用 API |
|------|------|------|----------|
| **宿主端 (Host)** | `src/extension.ts` | 注册命令、LSP 查询、文件 I/O | VS Code API、Node.js |
| **WebView 端** | `src/webview-x6/index.ts` | 图形渲染、用户交互 | DOM、自定义消息 |

两端通过 `postMessage` / `onDidReceiveMessage` 通信。

### 消息协议

宿主端 → WebView：
| type | 说明 |
|------|------|
| `update` | 发送文档内容（`text` 字段为 JSON 字符串） |
| `tagConfig` | 发送标签配置 |
| `i18nStrings` | 发送本地化字符串表 |
| `bindMethod` | 绑定方法到节点 |
| `addCustomTag` | 添加自定义标签到节点 |
| `navigationSuccess` | 代码跳转成功通知 |
| `navigationFailed` | 代码跳转失败通知（附带 `reason`） |

WebView → 宿主端：
| type | 说明 |
|------|------|
| `ready` | WebView 初始化完成，请求数据 |
| `edit` | 文档内容变更（`data` 为 CallGraphDocument） |
| `nodeClick` | 节点点击事件（携带 `node` 数据） |
| `requestMethodLibrary` | 请求打开方法库选择面板 |
| `requestCustomTag` | 请求添加自定义标签 |

---

## 核心数据模型

### CallGraphDocument

```typescript
interface CallGraphDocument {
  title?: string;           // 文档标题
  description?: string;     // 文档描述
  nodes: Node[];            // 节点列表
  edges: Edge[];            // 边列表
}
```

### Node（节点）

```typescript
interface Node {
  id: string;               // 唯一标识
  label?: string;           // 显示名称
  type?: 'code' | 'note';   // 代码节点或说明节点
  symbol?: SymbolSignature;  // 代码符号绑定信息
  content?: string;          // Markdown 内容（note 节点）
  status?: 'normal' | 'broken';
  tags?: string[];           // 自定义标签
  style?: NodeStyle;         // 节点样式
}
```

### SymbolSignature（符号定位信息）

```typescript
interface SymbolSignature {
  name: string;             // 方法/函数名
  uri: string;              // 相对文件路径
  containerName?: string;   // 所属类名/模块名
  line?: number;            // 定义行号（从 0 开始）
  signature?: string;       // 参数签名
}
```

**`signature` 字段说明**：
- 有类型注解的语言（TypeScript/Java/C#/Go/Rust）：存储参数类型，如 `"(number, string)"`
- 无类型注解的语言（Python/Ruby/Lua/JS）：存储参数名，如 `"(name, level)"`
- Python 带类型注解：存储类型，如 `"(str, int)"`
- 特殊参数保留原样：`*args`, `**kwargs`, `...rest`
- 该字段主要用于 **UI 展示** 和 **区分重载方法**，当前不参与符号查找匹配

### Edge（边）

```typescript
interface Edge {
  from: string;             // 源节点 id（调用方）
  to: string;               // 目标节点 id（被调用方）
  label?: string;           // 边标签
  type?: 'call' | 'explain'; // 调用关系 or 说明关系
  style?: EdgeStyle;
}
```

---

## 关键流程

### 1. 符号签名提取流程（多语言支持）

签名提取在 `CallGraphGenerator` 中完成，主要涉及三个阶段：

```
LSP 符号名
    └─→ normalizeSymbolName()  ──→ bareName + 备用 signature
        └─→ 从 Hover API 获取签名
            └─→ extractSignatureFromHover()
                └─→ 匹配代码块（任意语言）
                    └─→ 提取括号内参数
                        └─→ extractTypesFromParams()
                            └─→ 自动检测参数风格 (detectParamStyle)
                                ├─ colon:      name: Type    → 提取 Type
                                ├─ type-before: Type name    → 提取 Type
                                ├─ type-after-go: name Type  → 提取 Type
                                ├─ php:         Type $name   → 提取 Type
                                └─ dynamic:     name         → 保留 name
```

**支持的参数格式**：

| 语言 | Hover 格式示例 | 提取结果 |
|------|----------------|----------|
| TypeScript | `(a: number, b: string)` | `(number, string)` |
| Python (有注解) | `(a: int, b: str)` | `(int, str)` |
| Python (无注解) | `(name, level)` | `(name, level)` |
| Python (*args) | `(*args, **kwargs)` | `(*args, **kwargs)` |
| Go | `(a int, b string)` | `(int, string)` |
| Java/C# | `(int a, String b)` | `(int, String)` |
| Rust | `(a: i32, b: &str)` | `(i32, &str)` |
| PHP | `(int $a, string $b)` | `(int, string)` |
| Ruby/Lua | `(a, b)` | `(a, b)` |

### 2. 代码跳转流程（navigateToCode）

```
点击节点
  └─→ 打开文件 (symbol.uri)
      └─→ 查找符号位置（3 级匹配策略）
          ├─ 1. LSP DocumentSymbol 提供者
          │     └─→ findSymbol() / findSymbolByName()
          │         ├─ 精确匹配 name
          │         ├─ normalizeSymbolName 提取 bareName 匹配（跨语言）
          │         └─ 行号匹配（containerName 内）
          ├─ 2. 回退：使用 symbol.line 行号定位
          └─ 3. 失败：标记节点为 broken 状态
```

**`findSymbol` 匹配策略**（`callGraphEditorReactFlow.ts`）：

1. 如果有 `containerName`，先找容器（类/模块），在容器子节点中匹配
2. 精确名称匹配 → `bareName` 匹配 → 行号匹配
3. 递归搜索子符号树

### 3. 方法库工作流

```
代码编辑器：右键 → "添加到方法库" (Ctrl+Shift+M)
  └─→ getSymbolAtCursor() → 获取光标位置的符号信息
      └─→ MethodLibrary.add() → 存储到 workspaceState

调用图编辑器：节点工具栏 → "绑定代码方法"
  └─→ 显示 QuickPick → 选择方法
      └─→ postMessage('bindMethod') → WebView 更新节点 symbol
```

### 4. LSP 调用层次分析流程

```
命令: callGraph.testLSP 或 callGraph.createGraphFromMethod
  └─→ LSPCallHierarchyProvider.getCallHierarchy()
      ├─→ vscode.prepareCallHierarchy (获取根符号)
      ├─→ vscode.provideIncomingCalls (递归获取调用者)
      └─→ vscode.provideOutgoingCalls (递归获取被调用者)

CallGraphGenerator.generateFromCodePosition()
  └─→ convertToGraphData()
      ├─→ createNodeFromCallHierarchyItem() → 创建 Node
      │     ├─→ normalizeSymbolName() → 提取纯方法名
      │     ├─→ getSignatureFromHover() → 提取参数签名
      │     └─→ WorkspacePathResolver → 转换相对路径
      └─→ processCallers/processCallees → 创建 Edge
```

---

## 开发指南

### 环境搭建

#### Windows（新机器初始化）

> 适用场景：首次在 Windows 上拉取本仓库，出现 `Cannot find module 'vscode' / 'path' / 'Buffer'` 等 TypeScript 报错。

```powershell
# 1) 安装 Node.js LTS（用户级，无需管理员）
winget install --id OpenJS.NodeJS.LTS --exact --source winget --scope user --accept-package-agreements --accept-source-agreements --disable-interactivity

# 2) 关闭并重新打开 VS Code（让 PATH 生效）

# 3) 在仓库根目录安装依赖
npm.cmd install

# 4) 编译验证
npm.cmd run compile
```

说明：
- 在 PowerShell 中如果执行 `npm` 遇到执行策略拦截（`npm.ps1` 被禁用），优先使用 `npm.cmd`。
- 依赖安装完成后，`node_modules/@types/vscode` 与 `node_modules/@types/node` 会提供 `vscode`、`path`、`Buffer` 等类型声明。

如果编辑器红线仍未消失：
1. 命令面板执行：`TypeScript: Select TypeScript Version` → `Use Workspace Version`
2. 命令面板执行：`TypeScript: Restart TS Server`
3. 仍异常时执行：`Developer: Reload Window`

```bash
# 安装依赖
npm install

# 编译扩展宿主端
npm run compile      # 或 npm run watch （监听模式）

# 打包 WebView
npm run build:webview   # 或 npm run watch:webview
```

### 调试

1. 在 VS Code 中按 `F5` 启动扩展开发主机
2. 在扩展开发主机中打开 `.callgraph.json` 文件
3. 宿主端日志在 **Debug Console** 中查看
4. WebView 调试：在扩展开发主机中按 `Ctrl+Shift+P` → "Developer: Toggle Developer Tools"

### 编译流程

```
src/*.ts                  ─→ tsc ─→ out/*.js        （宿主端，Node.js 环境）
src/webview-x6/*.ts       ─→ esbuild ─→ media/callgraph-webview.js  （WebView 端，浏览器环境）
```

- 宿主端用 `tsc`（TypeScript 编译器）编译，输出到 `out/`
- WebView 端用 `esbuild` 打包，输出到 `media/callgraph-webview.js`
- 两者 **独立编译**，WebView 代码不能使用 Node.js 或 VS Code API

### 关键文件说明

| 文件 | 职责 | 修改频率 |
|------|------|----------|
| `callGraphEditorReactFlow.ts` | 主编辑器 Provider（命名虽含 ReactFlow 但实际用 X6） | 高 |
| `webview-x6/index.ts` | WebView 图形渲染核心（约 2000 行） | 高 |
| `callGraphGenerator.ts` | LSP → CallGraphDocument 转换 | 中 |
| `models/callGraphDocument.ts` | 数据模型定义 | 低 |
| `services/methodLibrary.ts` | 方法库 + `normalizeSymbolName` | 中 |
| `services/lspIntegration.ts` | LSP 调用层次封装 | 低 |
| `webview-x6/layoutEngines.ts` | dagre/elk 布局引擎 | 低 |

### 新增语言支持

如需支持新的编程语言的签名提取：

1. **检查 Hover 格式**：在目标语言文件中悬停函数，查看 Hover 内容格式
2. **修改 `extractSignatureFromHover`**：确保代码块正则能匹配新语言
3. **修改 `detectParamStyle`**：添加新的参数风格检测规则
4. **修改 `extractTypeFromSingleParam`**：处理新风格的参数类型提取
5. **测试 `normalizeSymbolName`**：确保新语言的符号名规范化正确

各语言 LSP Document Symbol Provider 返回的 `name` 格式：

| 语言 | `symbol.name` 格式 | 需要 `normalizeSymbolName` |
|------|---------------------|---------------------------|
| TypeScript | `"methodName"` | 否 |
| C# | `"MethodName(Type1, Type2) : ReturnType"` | **是** |
| Python | `"method_name"` | 否 |
| Go | `"FuncName"` | 否 |
| Java | `"methodName"` | 否 |

---

## 配置项

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `callGraph.predefinedTags` | Array | 6 个预设标签 | 预定义标签列表（名称和颜色） |
| `callGraph.showFileNameTag` | boolean | `false` | 是否自动显示文件名标签 |
| `callGraph.fileNameTagColor` | string | `"#607D8B"` | 文件名标签颜色 |
| `callGraph.codeNodeColor` | object | `{fill, stroke}` | 代码节点颜色 |
| `callGraph.noteNodeColor` | object | `{fill, stroke}` | 说明节点颜色 |
| `callGraph.unboundCodeNodeColor` | object | `{fill, stroke}` | 未绑定代码的节点颜色 |
| `callGraph.removeMethodAfterBind` | boolean | `false` | 绑定后是否自动从方法库移除 |

---

## 国际化

- 宿主端：使用 `vscode.l10n.t()` 函数，翻译文件在 `l10n/bundle.l10n.zh-cn.json`
- WebView 端：通过 `i18nStrings` 消息传递翻译字符串，WebView 中使用 `t()` 函数
- 扩展清单：使用 `%key%` 格式，翻译在 `package.nls.json` / `package.nls.zh-cn.json`

---

## 发布

```bash
# 打包 VSIX
npx vsce package

# 发布到 Marketplace
npx vsce publish
```

注意事项：
- 发布前确保 `npm run vscode:prepublish` 成功执行
- 图标文件 `images/icon.png` 需要存在
- `package.json` 中的 `publisher` 字段需匹配你的发布者 ID
