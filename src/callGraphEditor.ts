import * as vscode from 'vscode';
import { getNonce } from './util';
import type { CallGraphDocument, Node, Edge } from './models/callGraphDocument';

/**
 * Provider for call graph editors.
 * 
 * Call graph editors are used for `.callgraph.json` files.
 * This editor visualizes code call relationships using MindElixir.
 */
export class CallGraphEditorProvider implements vscode.CustomTextEditorProvider {

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new CallGraphEditorProvider(context);
		const providerRegistration = vscode.window.registerCustomEditorProvider(
			CallGraphEditorProvider.viewType, 
			provider
		);
		return providerRegistration;
	}

	private static readonly viewType = 'codeCallGraph.callGraph';

	constructor(
		private readonly context: vscode.ExtensionContext
	) { }

	/**
	 * Called when our custom editor is opened.
	 */
	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		// Setup initial content for the webview
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, 'media')
			]
		};
		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		// 防止循环更新的标志
		let isUpdatingFromWebview = false;

		// 获取 tag 配置
		const getTagConfig = () => {
			const config = vscode.workspace.getConfiguration('callGraph');
			return {
				predefinedTags: config.get<Array<{name: string, color: string}>>('predefinedTags') || [],
				showFileNameTag: config.get<boolean>('showFileNameTag', true),
				fileNameTagColor: config.get<string>('fileNameTagColor', '#607D8B')
			};
		};

		const updateWebview = () => {
			// 如果是 WebView 触发的更新，不要再发回去
			if (isUpdatingFromWebview) {
				isUpdatingFromWebview = false;
				return;
			}
			const callGraphDoc = getDocumentAsJson(document);
			const tagConfig = getTagConfig();
			console.log('发送数据到WebView:', callGraphDoc, tagConfig);
			webviewPanel.webview.postMessage({
				type: 'update',
				data: callGraphDoc,
				tagConfig
			});
		};

		// Hook up event handlers to synchronize the webview with the text document
		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === document.uri.toString()) {
				updateWebview();
			}
		});

		// Clean up listener when editor is closed
		webviewPanel.onDidDispose(() => {
			changeDocumentSubscription.dispose();
		});

		// Receive messages from the webview
		webviewPanel.webview.onDidReceiveMessage(async e => {
			console.log('收到来自WebView的消息:', e);
			switch (e.type) {
				case 'ready':
					// WebView is ready, send initial data
					console.log('WebView已就绪，发送初始数据');
					updateWebview();
					return;

				case 'nodeClick':
					// Handle node click for code navigation
					if (e.node && e.node.symbol) {
						await this.navigateToCode(e.node);
					}
					return;

				case 'save':
					// Save changes back to document
					isUpdatingFromWebview = true;
					this.updateTextDocument(document, e.data);
					return;

				case 'requestCustomTag':
					// 用户请求添加自定义标签，显示 VS Code 输入框
					const tagName = await vscode.window.showInputBox({
						prompt: '请输入自定义标签名称',
						placeHolder: '例如：重要、待优化、已完成',
						validateInput: (value) => {
							if (!value || !value.trim()) {
								return '标签名称不能为空';
							}
							return null;
						}
					});
					if (tagName && tagName.trim()) {
						const trimmedName = tagName.trim();
						
						// 检查是否已存在于预定义标签中
						const config = vscode.workspace.getConfiguration('callGraph');
						const predefinedTags = config.get<Array<{name: string, color: string}>>('predefinedTags') || [];
						const exists = predefinedTags.some(t => t.name === trimmedName);
						
						if (!exists) {
							// 询问是否保存为预定义标签
							const saveToConfig = await vscode.window.showQuickPick(
								['是，保存为预定义标签', '否，仅添加到当前节点'],
								{ placeHolder: '是否将此标签保存为预定义标签？' }
							);
							
							if (saveToConfig === '是，保存为预定义标签') {
								// 生成随机颜色
								const colors = ['#E91E63', '#9C27B0', '#673AB7', '#3F51B5', '#009688', '#4CAF50', '#FF5722', '#795548'];
								const randomColor = colors[Math.floor(Math.random() * colors.length)];
								
								// 添加到配置
								predefinedTags.push({ name: trimmedName, color: randomColor });
								await config.update('predefinedTags', predefinedTags, vscode.ConfigurationTarget.Global);
								
								// 刷新 WebView 配置
								updateWebview();
							}
						}
						
						// 发送给 WebView 添加到节点
						webviewPanel.webview.postMessage({
							type: 'addCustomTag',
							tagName: trimmedName,
							nodeId: e.nodeId
						});
					}
					return;
			}
		});

		// Send initial data after a short delay to ensure WebView is ready
		setTimeout(() => {
			console.log('延迟发送初始数据');
			updateWebview();
		}, 300);
	}

	/**
	 * Navigate to code location based on node symbol
	 * Uses LSP to find symbol definition for better accuracy
	 */
	private async navigateToCode(node: Node): Promise<void> {
		if (!node.symbol) {
			vscode.window.showWarningMessage('该节点没有绑定代码符号');
			return;
		}

		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				vscode.window.showErrorMessage('没有打开的工作区');
				return;
			}

			const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, node.symbol.uri);
			
			// 尝试打开文件
			let doc: vscode.TextDocument;
			try {
				doc = await vscode.workspace.openTextDocument(fileUri);
			} catch {
				vscode.window.showErrorMessage(`文件不存在: ${node.symbol.uri}`);
				return;
			}

			const editor = await vscode.window.showTextDocument(doc);

			// 方法1: 优先使用 LSP 查找符号定义
			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				fileUri
			);

			if (symbols && symbols.length > 0) {
				const targetSymbol = this.findSymbolByName(symbols, node.symbol.name, node.symbol.containerName);
				if (targetSymbol) {
					const position = targetSymbol.selectionRange.start;
					editor.selection = new vscode.Selection(position, position);
					editor.revealRange(targetSymbol.selectionRange, vscode.TextEditorRevealType.InCenter);
					return;
				}
			}

			// 方法2: 回退到行号定位
			if (node.symbol.line) {
				const line = node.symbol.line - 1;
				if (line >= 0 && line < doc.lineCount) {
					const position = new vscode.Position(line, 0);
					editor.selection = new vscode.Selection(position, position);
					editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
					return;
				}
			}

			// 无法精确定位，显示文件开头
			vscode.window.showWarningMessage(`未找到符号 "${node.symbol.name}"，已打开文件`);

		} catch (error) {
			vscode.window.showErrorMessage(`跳转失败: ${error}`);
		}
	}

	/**
	 * Find symbol by name in document symbols (recursive)
	 */
	private findSymbolByName(
		symbols: vscode.DocumentSymbol[], 
		name: string, 
		containerName?: string
	): vscode.DocumentSymbol | undefined {
		for (const symbol of symbols) {
			// 匹配名称
			if (symbol.name === name) {
				// 如果指定了容器名，检查是否在正确的容器中
				if (!containerName || this.isInContainer(symbols, symbol, containerName)) {
					return symbol;
				}
			}
			// 递归搜索子符号
			if (symbol.children && symbol.children.length > 0) {
				const found = this.findSymbolByName(symbol.children, name, containerName);
				if (found) return found;
			}
		}
		return undefined;
	}

	/**
	 * Check if symbol is inside a container with given name
	 */
	private isInContainer(
		allSymbols: vscode.DocumentSymbol[], 
		targetSymbol: vscode.DocumentSymbol, 
		containerName: string
	): boolean {
		// 简单实现：检查是否有同名容器包含此符号
		for (const symbol of allSymbols) {
			if (symbol.name === containerName && symbol.children) {
				if (symbol.children.includes(targetSymbol)) {
					return true;
				}
			}
			if (symbol.children) {
				if (this.isInContainer(symbol.children, targetSymbol, containerName)) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Update text document with new data
	 */
	private updateTextDocument(document: vscode.TextDocument, data: CallGraphDocument): Thenable<boolean> {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(
			document.uri,
			new vscode.Range(0, 0, document.lineCount, 0),
			JSON.stringify(data, null, 2)
		);
		return vscode.workspace.applyEdit(edit);
	}

	/**
	 * Get the static HTML for the editor webview.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		// Get URI for MindElixir library
		const mindElixirUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'MindElixir.js')
		);
		const nonce = getNonce();

		return /* html */`
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Call Graph Editor</title>
				<style>
					html, body { 
						height: 100%; 
						margin: 0; 
						padding: 0; 
						overflow: hidden;
					}
					#container { 
						height: 100vh; 
						display: flex; 
						flex-direction: column; 
						background: var(--vscode-editor-background, #1e1e1e);
						color: var(--vscode-editor-foreground, #fff);
					}
					#toolbar {
						display: flex;
						gap: 4px;
						padding: 8px;
						background: var(--vscode-titleBar-activeBackground, #222);
						border-bottom: 1px solid var(--vscode-panel-border, #444);
					}
					.toolbar-btn {
						background: var(--vscode-button-secondaryBackground, #333);
						border: none;
						border-radius: 4px;
						padding: 6px 10px;
						display: flex;
						align-items: center;
						gap: 6px;
						cursor: pointer;
						color: var(--vscode-button-secondaryForeground, #fff);
						font-size: 13px;
						transition: background 0.2s;
					}
					.toolbar-btn:hover {
						background: var(--vscode-button-secondaryHoverBackground, #444);
					}
					.toolbar-btn:disabled {
						opacity: 0.5;
						cursor: not-allowed;
					}
					#map {
						flex: 1;
						width: 100%;
						min-height: 0;
					}
					#status {
						padding: 4px 8px;
						font-size: 12px;
						background: var(--vscode-statusBar-background, #007acc);
						color: var(--vscode-statusBar-foreground, #fff);
					}
					/* MindElixir 深色主题覆盖 */
					.mind-elixir {
						background: var(--vscode-editor-background, #1e1e1e) !important;
					}
				</style>
			</head>
			<body>
				<div id="container">
					<div id="toolbar">
						<button class="toolbar-btn" id="fitBtn" title="适应画布">
							<span>🎯</span><span>适应视图</span>
						</button>
						<button class="toolbar-btn" id="expandBtn" title="展开所有节点">
							<span>📂</span><span>展开全部</span>
						</button>
						<button class="toolbar-btn" id="collapseBtn" title="折叠所有节点">
							<span>📁</span><span>折叠全部</span>
						</button>
						<span style="flex: 1;"></span>
						<span id="nodeInfo" style="padding: 6px 10px; opacity: 0.7;">节点: 0 | 边: 0</span>
					</div>
					<div id="map"></div>
					<div id="status">就绪</div>
				</div>

				<script type="module">
					import MindElixir from '${mindElixirUri}';
					
					const vscode = acquireVsCodeApi();
					let mind = null;
					let callGraphData = null;
					let tagConfig = {
						predefinedTags: [],
						showFileNameTag: true,
						fileNameTagColor: '#607D8B'
					};

					// 深色主题配置
					const DARK_THEME = {
						name: 'Dark',
						palette: ['#848FA0', '#748BE9', '#D2F9FE', '#4145A5', '#789AFA', '#706CF4', '#EF987F', '#775DD5', '#FCEECF', '#DA7FBC'],
						cssVar: {
							'--main-color': '#ffffff',
							'--main-bgcolor': '#4c4f69',
							'--color': '#E0E0E0',
							'--bgcolor': '#252526',
							'--selected': '#4dc4ff',
							'--panel-color': '#ffffff',
							'--panel-bgcolor': '#2d3748',
							'--panel-border-color': '#696969',
						},
					};

					/**
					 * 根据 tag 名称获取颜色
					 */
					function getTagColor(tagName, isFileName = false) {
						if (isFileName) {
							return tagConfig.fileNameTagColor || '#607D8B';
						}
						const predefined = tagConfig.predefinedTags?.find(t => t.name === tagName);
						return predefined?.color || '#6B7280'; // 默认灰色
					}

					/**
					 * 应用 tag 颜色样式（基础CSS）
					 */
					function applyTagStyles() {
						// 动态创建样式
						var styleEl = document.getElementById('tag-styles');
						if (!styleEl) {
							styleEl = document.createElement('style');
							styleEl.id = 'tag-styles';
							document.head.appendChild(styleEl);
						}
						
						// 基础样式 - tag 默认样式
						styleEl.textContent = '.map-container .tags span { background: #607D8B; color: #fff; }';
					}

					/**
					 * 动态应用 tag 颜色（遍历 DOM）
					 * MindElixir 渲染的 tags 没有属性，需要根据文本内容匹配颜色
					 */
					function applyTagColors() {
						var tagSpans = document.querySelectorAll('.map-container .tags span');
						tagSpans.forEach(function(span) {
							var tagText = span.textContent || '';
							var color = null;
							
							// 检查是否是预定义 tag
							if (tagConfig.predefinedTags) {
								for (var i = 0; i < tagConfig.predefinedTags.length; i++) {
									if (tagConfig.predefinedTags[i].name === tagText) {
										color = tagConfig.predefinedTags[i].color;
										break;
									}
								}
							}
							
							// 如果不是预定义 tag，可能是文件名
							if (!color) {
								// 检查是否像文件名（包含.扩展名）
								if (tagText.indexOf('.') > 0) {
									color = tagConfig.fileNameTagColor || '#607D8B';
								} else {
									color = '#6B7280'; // 默认灰色
								}
							}
							
							span.style.background = color;
							span.style.color = '#fff';
						});
					}

					/**
					 * 设置自定义右键菜单
					 */
					function setupContextMenu() {
						// 创建自定义菜单 DOM
						const menu = document.createElement('div');
						menu.id = 'tag-context-menu';
						menu.className = 'tag-menu';
						menu.style.cssText = 'display:none; position:fixed; z-index:10000; min-width:160px; background:var(--vscode-menu-background,#252526); border:1px solid var(--vscode-menu-border,#454545); border-radius:4px; box-shadow:0 4px 12px rgba(0,0,0,0.3); padding:4px 0;';
						document.body.appendChild(menu);

						// 隐藏菜单
						function hideMenu() {
							menu.style.display = 'none';
						}

						// 显示菜单
						function showMenu(x, y) {
							const node = mind.currentNode;
							if (!node) return;
							
							const nodeObj = node.nodeObj;
							const currentTags = (nodeObj.data && nodeObj.data.tags) ? nodeObj.data.tags : [];
							const isRoot = nodeObj.id === 'root';
							
							let html = '';
							
							// === 节点操作 ===
							html += '<div class="menu-section" style="padding:4px 12px; font-size:11px; color:#888;">节点操作</div>';
							
							html += '<div class="menu-item" data-action="add-child" style="padding:6px 12px; cursor:pointer; display:flex; align-items:center; gap:8px;">' +
								'<span style="width:16px; text-align:center;">📝</span>' +
								'<span>添加子节点</span>' +
								'<span style="margin-left:auto; opacity:0.5; font-size:11px;">Tab</span>' +
							'</div>';
							
							html += '<div class="menu-item" data-action="add-sibling" style="padding:6px 12px; cursor:pointer; display:flex; align-items:center; gap:8px;">' +
								'<span style="width:16px; text-align:center;">📄</span>' +
								'<span>添加同级节点</span>' +
								'<span style="margin-left:auto; opacity:0.5; font-size:11px;">Enter</span>' +
							'</div>';
							
							if (!isRoot) {
								html += '<div class="menu-item" data-action="delete-node" style="padding:6px 12px; cursor:pointer; display:flex; align-items:center; gap:8px; color:#f44336;">' +
									'<span style="width:16px; text-align:center;">🗑️</span>' +
									'<span>删除节点</span>' +
									'<span style="margin-left:auto; opacity:0.5; font-size:11px;">Del</span>' +
								'</div>';
							}
							
							// === 标签操作 ===
							html += '<div style="border-top:1px solid #454545; margin-top:4px;"></div>';
							html += '<div class="menu-section" style="padding:4px 12px; font-size:11px; color:#888;">标签</div>';
							
							// 预定义 tags
							if (tagConfig.predefinedTags && tagConfig.predefinedTags.length > 0) {
								tagConfig.predefinedTags.forEach(function(tag) {
									var hasTag = currentTags.indexOf(tag.name) >= 0;
									var icon = hasTag ? '✓' : '';
									html += '<div class="menu-item" data-action="toggle-tag" data-tag="' + tag.name + '" style="padding:6px 12px; cursor:pointer; display:flex; align-items:center; gap:8px;">' +
										'<span style="width:16px; text-align:center;">' + icon + '</span>' +
										'<span style="display:inline-block; width:12px; height:12px; border-radius:2px; background:' + tag.color + ';"></span>' +
										'<span>' + tag.name + '</span>' +
									'</div>';
								});
							}
							
							// 自定义标签选项
							html += '<div class="menu-item" data-action="custom-tag" style="padding:6px 12px; cursor:pointer; display:flex; align-items:center; gap:8px;">' +
								'<span style="width:16px; text-align:center;">+</span>' +
								'<span>自定义标签...</span>' +
							'</div>';
							
							// 清除所有标签
							if (currentTags.length > 0) {
								html += '<div class="menu-item" data-action="clear-tags" style="padding:6px 12px; cursor:pointer; display:flex; align-items:center; gap:8px; color:#f44336;">' +
									'<span style="width:16px; text-align:center;">×</span>' +
									'<span>清除所有标签</span>' +
								'</div>';
							}
							
							// === 代码跳转 ===
							if (nodeObj.data && nodeObj.data.symbol) {
								html += '<div style="border-top:1px solid #454545; margin-top:4px;"></div>';
								html += '<div class="menu-item" data-action="goto-code" style="padding:6px 12px; cursor:pointer; display:flex; align-items:center; gap:8px;">' +
									'<span style="width:16px; text-align:center;">🔗</span>' +
									'<span>跳转到代码</span>' +
									'<span style="margin-left:auto; opacity:0.5; font-size:11px;">Ctrl+Click</span>' +
								'</div>';
							}
							
							menu.innerHTML = html;
							
							// 设置菜单项的 hover 效果
							menu.querySelectorAll('.menu-item').forEach(item => {
								item.addEventListener('mouseenter', () => {
									item.style.background = 'var(--vscode-menu-selectionBackground, #094771)';
								});
								item.addEventListener('mouseleave', () => {
									item.style.background = 'transparent';
								});
							});
							
							// 定位菜单
							menu.style.display = 'block';
							const menuRect = menu.getBoundingClientRect();
							const viewWidth = window.innerWidth;
							const viewHeight = window.innerHeight;
							
							if (x + menuRect.width > viewWidth) x = viewWidth - menuRect.width - 10;
							if (y + menuRect.height > viewHeight) y = viewHeight - menuRect.height - 10;
							
							menu.style.left = x + 'px';
							menu.style.top = y + 'px';
						}

						// 处理菜单点击
						menu.addEventListener('click', function(e) {
							var item = e.target.closest('.menu-item');
							if (!item) return;
							
							var action = item.dataset.action;
							var node = mind.currentNode;
							if (!node) return;
							
							var nodeObj = node.nodeObj;
							if (!nodeObj.data) nodeObj.data = {};
							if (!nodeObj.data.tags) nodeObj.data.tags = [];
							
							var needSave = true;
							
							if (action === 'add-child') {
								// 添加子节点 - MindElixir 不需要参数
								mind.addChild();
							} else if (action === 'add-sibling') {
								// 添加同级节点
								mind.insertSibling('after');
							} else if (action === 'delete-node') {
								// 删除节点
								mind.removeNode();
							} else if (action === 'goto-code') {
								// 跳转到代码
								if (nodeObj.data && nodeObj.data.symbol) {
									vscode.postMessage({
										type: 'nodeClick',
										node: nodeObj.data
									});
								}
								needSave = false;
							} else if (action === 'toggle-tag') {
								var tagName = item.dataset.tag;
								var idx = nodeObj.data.tags.indexOf(tagName);
								if (idx >= 0) {
									nodeObj.data.tags.splice(idx, 1);
								} else {
									nodeObj.data.tags.push(tagName);
								}
								// 更新 MindElixir 节点的 tags
								nodeObj.tags = buildDisplayTags(nodeObj.data);
								mind.refresh();
								// 刷新后重新应用颜色
								setTimeout(function() { applyTagColors(); }, 50);
							} else if (action === 'custom-tag') {
								// 请求 VS Code 显示输入框
								vscode.postMessage({
									type: 'requestCustomTag',
									nodeId: nodeObj.id
								});
								needSave = false; // 保存将在收到响应后进行
							} else if (action === 'clear-tags') {
								nodeObj.data.tags = [];
								nodeObj.tags = buildDisplayTags(nodeObj.data);
								mind.refresh();
							}
							
							hideMenu();
							if (needSave) {
								saveToDocument();
							}
						});

						// 点击其他地方关闭菜单
						document.addEventListener('click', function(e) {
							if (!menu.contains(e.target)) {
								hideMenu();
							}
						});

						// 监听右键菜单（在 me-tpc 节点上显示自定义菜单）
						document.getElementById('map').addEventListener('contextmenu', function(e) {
							// 阻止所有默认右键菜单
							e.preventDefault();
							e.stopPropagation();
							
							var tpc = e.target.closest('me-tpc');
							if (tpc && mind.currentNode) {
								showMenu(e.clientX, e.clientY);
							} else {
								// 非节点区域也阻止默认菜单，但不显示自定义菜单
								hideMenu();
							}
						});
					}

					/**
					 * 构建显示用的 tags（包含文件名 + 自定义标签）
					 */
					function buildDisplayTags(nodeData) {
						const tags = [];
						// 1. 文件名 tag
						if (tagConfig.showFileNameTag && nodeData.symbol && nodeData.symbol.uri) {
							const filePath = nodeData.symbol.uri;
							const parts = filePath.split(/[\\\\/]/);
							const fileName = parts[parts.length - 1];
							if (fileName) tags.push(fileName);
						}
						// 2. 自定义 tags
						if (nodeData.tags && Array.isArray(nodeData.tags)) {
							tags.push.apply(tags, nodeData.tags);
						}
						return tags.length > 0 ? tags : undefined;
					}

					/**
					 * 将 CallGraph JSON 转换为 MindElixir 格式
					 * CallGraph: { nodes: [{id, label, type, symbol}], edges: [{from, to}] }
					 * MindElixir: { nodeData: { id, topic, children: [...] } }
					 */
					function convertToMindElixir(callGraph) {
						if (!callGraph || !callGraph.nodes || callGraph.nodes.length === 0) {
							return {
								nodeData: {
									id: 'root',
									topic: callGraph?.title || '空调用图',
									children: []
								}
							};
						}

						const nodes = callGraph.nodes;
						const edges = callGraph.edges || [];
						
						// 构建邻接表: 谁调用了谁 (from -> to)
						const childrenMap = new Map(); // from节点的子节点列表
						const parentSet = new Set(); // 有父节点的节点
						
						edges.forEach(edge => {
							if (!childrenMap.has(edge.from)) {
								childrenMap.set(edge.from, []);
							}
							childrenMap.get(edge.from).push(edge.to);
							parentSet.add(edge.to);
						});
						
						// 找出根节点（没有被调用的节点）
						const rootNodes = nodes.filter(n => !parentSet.has(n.id));
						
						/**
						 * 从文件路径提取文件名
						 */
						function extractFileName(filePath) {
							if (!filePath) return null;
							// 处理 Windows 和 Unix 路径
							var parts = filePath.split(/[\\\\/]/);
							return parts[parts.length - 1] || null;
						}

						/**
						 * 为节点生成 tags（文件名 + 自定义标签）
						 * 使用全局 tagConfig 配置
						 */
						function buildTags(node) {
							var tags = [];
							// 1. 自动添加文件名 tag（如果配置开启且有 symbol.uri）
							if (tagConfig.showFileNameTag && node.symbol && node.symbol.uri) {
								var fileName = extractFileName(node.symbol.uri);
								if (fileName) tags.push(fileName);
							}
							// 2. 合并用户自定义 tags
							if (node.tags && Array.isArray(node.tags)) {
								tags.push.apply(tags, node.tags);
							}
							return tags.length > 0 ? tags : undefined;
						}

						// 递归构建子节点
						function buildChildren(nodeId, visited = new Set()) {
							if (visited.has(nodeId)) return []; // 防止循环
							visited.add(nodeId);
							
							const childIds = childrenMap.get(nodeId) || [];
							return childIds.map(childId => {
								const childNode = nodes.find(n => n.id === childId);
								if (!childNode) return null;
								
								return {
									id: childNode.id,
									topic: childNode.label || childNode.symbol?.name || childNode.id,
									tags: buildTags(childNode), // 添加 tags
									data: childNode, // 保存原始节点数据
									children: buildChildren(childId, new Set(visited))
								};
							}).filter(Boolean);
						}
						
						// 如果只有一个根节点，直接作为根
						if (rootNodes.length === 1) {
							const root = rootNodes[0];
							return {
								nodeData: {
									id: root.id,
									topic: root.label || root.symbol?.name || root.id,
									tags: buildTags(root), // 添加 tags
									data: root,
									children: buildChildren(root.id)
								},
								theme: DARK_THEME
							};
						}
						
						// 多个根节点时，创建虚拟根节点
						const virtualChildren = rootNodes.map((node, index) => ({
							id: node.id,
							topic: node.label || node.symbol?.name || node.id,
							tags: buildTags(node), // 添加 tags
							direction: index % 2, // 交替左右分布
							data: node,
							children: buildChildren(node.id)
						}));
						
						return {
							nodeData: {
								id: 'root',
								topic: callGraph.title || '调用图',
								children: virtualChildren
							},
							theme: DARK_THEME
						};
					}

					/**
					 * 将 MindElixir 格式转换回 CallGraph JSON
					 * MindElixir: { nodeData: { id, topic, children: [...] } }
					 * CallGraph: { nodes: [{id, label, type, symbol}], edges: [{from, to}] }
					 */
					function convertToCallGraph(mindData) {
						const nodes = [];
						const edges = [];
						const title = callGraphData?.title || '';
						
						function traverse(node, parentId = null) {
							// 跳过虚拟根节点
							const isVirtualRoot = node.id === 'root' && !node.data;
							
							if (!isVirtualRoot) {
								// 恢复原始节点数据，或创建新节点
								const originalData = node.data || {};
								const nodeEntry = {
									id: node.id,
									label: node.topic,
									type: originalData.type || 'code',
									...originalData,
									// 更新 label 为当前 topic
									label: node.topic
								};
								nodes.push(nodeEntry);
								
								// 添加边（父节点 -> 当前节点）
								if (parentId && parentId !== 'root') {
									edges.push({
										from: parentId,
										to: node.id,
										type: 'call'
									});
								}
							}
							
							// 递归处理子节点
							const children = node.children || [];
							children.forEach(child => {
								traverse(child, isVirtualRoot ? null : node.id);
							});
						}
						
						traverse(mindData.nodeData);
						
						return { title, nodes, edges };
					}

					/**
					 * 初始化 MindElixir
					 */
					function initMindMap(data) {
						const mindData = convertToMindElixir(data);
						
						const options = {
							el: '#map',
							direction: 2, // 双向展开
							draggable: true,
							contextMenu: false, // 禁用默认右键菜单，使用自定义
							toolBar: false, // 使用自定义工具栏
							nodeMenu: false, // 禁用默认节点菜单
							keypress: true,
							allowUndo: true,
						};

						mind = new MindElixir(options);
						mind.init(mindData);
						
						// 应用 tag 基础样式
						applyTagStyles();
						
						// 延迟应用 tag 颜色（等待 DOM 渲染完成）
						setTimeout(function() { applyTagColors(); }, 100);
						
						// 自定义右键菜单
						setupContextMenu();

						// 监听节点选择
						mind.bus.addListener('selectNode', function(node) {
							updateStatus('选中: ' + node.topic);
						});

						// 监听所有操作，同步到文件
						mind.bus.addListener('operation', function(operation) {
							console.log('MindElixir操作:', operation.name);
							// 延迟保存，避免频繁触发
							clearTimeout(window.saveTimeout);
							window.saveTimeout = setTimeout(function() {
								saveToDocument();
								// 操作后重新应用颜色
								applyTagColors();
							}, 500);
						});

						// 监听 Ctrl+Click 跳转代码
						document.addEventListener('click', function(e) {
							if (e.ctrlKey && e.target.closest('me-tpc')) {
								var currentNode = mind.currentNode;
								if (currentNode && currentNode.nodeObj && currentNode.nodeObj.data) {
									vscode.postMessage({
										type: 'nodeClick',
										node: currentNode.nodeObj.data
									});
								}
							}
						});

						updateStatus('已加载 ' + (data && data.nodes ? data.nodes.length : 0) + ' 个节点');
					}

					/**
					 * 更新状态栏
					 */
					function updateStatus(text) {
						document.getElementById('status').textContent = text;
					}

					/**
					 * 更新节点信息
					 */
					function updateNodeInfo(data) {
						const nodeCount = data?.nodes?.length || 0;
						const edgeCount = data?.edges?.length || 0;
						document.getElementById('nodeInfo').textContent = 
							'节点: ' + nodeCount + ' | 边: ' + edgeCount;
					}

					/**
					 * 保存数据到文档
					 */
					function saveToDocument() {
						if (!mind) return;
						
						const mindData = mind.getData();
						const newCallGraph = convertToCallGraph(mindData);
						
						// 更新节点信息显示
						updateNodeInfo(newCallGraph);
						updateStatus('已保存');
						
						// 发送到 Extension 保存
						vscode.postMessage({
							type: 'save',
							data: newCallGraph
						});
					}

					// 工具栏按钮事件
					document.getElementById('fitBtn').addEventListener('click', () => {
						if (mind) {
							mind.toCenter();
							mind.scale(1);
						}
					});

					document.getElementById('expandBtn').addEventListener('click', () => {
						if (mind) {
							// 展开所有节点
							const allNodes = document.querySelectorAll('me-wrapper');
							allNodes.forEach(wrapper => {
								if (wrapper.classList.contains('collapsed')) {
									wrapper.classList.remove('collapsed');
								}
							});
						}
					});

					document.getElementById('collapseBtn').addEventListener('click', () => {
						if (mind) {
							// 折叠所有一级以下节点
							const allNodes = document.querySelectorAll('me-wrapper:not([data-nodeid="root"])');
							allNodes.forEach(wrapper => {
								wrapper.classList.add('collapsed');
							});
						}
					});

					// 接收来自 Extension 的消息
					window.addEventListener('message', function(event) {
						var message = event.data;
						console.log('WebView收到消息:', message.type);
						
						if (message.type === 'update') {
							callGraphData = message.data;
							// 更新 tag 配置
							if (message.tagConfig) {
								tagConfig = message.tagConfig;
								applyTagStyles();
							}
							updateNodeInfo(callGraphData);
							
							if (!mind) {
								// 首次初始化
								initMindMap(callGraphData);
							} else {
								// 刷新数据
								var mindData = convertToMindElixir(callGraphData);
								mind.refresh(mindData);
								// 刷新后重新应用颜色
								setTimeout(function() { applyTagColors(); }, 100);
							}
						} else if (message.type === 'addCustomTag') {
							// 从 Extension 收到自定义标签响应
							var targetNode = findNodeById(mind.getData().nodeData, message.nodeId);
							if (targetNode) {
								if (!targetNode.data) targetNode.data = {};
								if (!targetNode.data.tags) targetNode.data.tags = [];
								targetNode.data.tags.push(message.tagName);
								targetNode.tags = buildDisplayTags(targetNode.data);
								mind.refresh();
								setTimeout(function() { applyTagColors(); }, 50);
								saveToDocument();
							}
						}
					});

					/**
					 * 根据 ID 查找节点
					 */
					function findNodeById(node, id) {
						if (node.id === id) return node;
						if (node.children) {
							for (var i = 0; i < node.children.length; i++) {
								var found = findNodeById(node.children[i], id);
								if (found) return found;
							}
						}
						return null;
					}

					// 通知 Extension WebView 已就绪
					updateStatus('正在加载...');
					vscode.postMessage({ type: 'ready' });
				</script>
			</body>
			</html>`;
	}
}

/**
 * Try to get a current document as json.
 */
function getDocumentAsJson(document: vscode.TextDocument): CallGraphDocument {
	const text = document.getText();
	if (text.trim().length === 0) {
		return { nodes: [], edges: [] };
	}

	try {
		return JSON.parse(text) as CallGraphDocument;
	} catch {
		// Return empty document if JSON is invalid
		return { nodes: [], edges: [] };
	}
}