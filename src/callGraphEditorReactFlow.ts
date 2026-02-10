import * as vscode from 'vscode';
import { getNonce } from './util';
import type { CallGraphDocument, Node } from './models/callGraphDocument';
import type { MethodLibrary, MethodItem } from './services/methodLibrary';
import { normalizeSymbolName } from './services/methodLibrary';

/**
 * Provider for call graph editors using React Flow.
 * 
 * Call graph editors are used for `.callgraph.json` files.
 * This editor visualizes code call relationships using React Flow.
 */
export class CallGraphEditorProvider implements vscode.CustomTextEditorProvider {

	public static register(context: vscode.ExtensionContext, methodLibrary: MethodLibrary): vscode.Disposable {
		const provider = new CallGraphEditorProvider(context, methodLibrary);
		const providerRegistration = vscode.window.registerCustomEditorProvider(
			CallGraphEditorProvider.viewType,
			provider
		);
		return providerRegistration;
	}

	private static readonly viewType = 'codeCallGraph.callGraph';

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly methodLibrary: MethodLibrary
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

		// 标记：是否正在从 webview 更新文档（防止 update 回弹循环）
		let isUpdatingFromWebview = false;

		// 获取 tag 配置
		const getTagConfig = () => {
			const config = vscode.workspace.getConfiguration('callGraph');
			return {
				predefinedTags: config.get<Array<{name: string, color: string}>>('predefinedTags') || [],
				showFileNameTag: config.get<boolean>('showFileNameTag', false),
				fileNameTagColor: config.get<string>('fileNameTagColor', '#607D8B'),
				codeNodeColor: config.get<{fill: string, stroke: string}>('codeNodeColor') || { fill: '#1e3a5f', stroke: '#4a9eff' },
				noteNodeColor: config.get<{fill: string, stroke: string}>('noteNodeColor') || { fill: '#3d3520', stroke: '#d4a04a' },
				unboundCodeNodeColor: config.get<{fill: string, stroke: string}>('unboundCodeNodeColor') || { fill: '#3d2020', stroke: '#d48a8a' }
			};
		};

		// 发送数据到 WebView
		function updateWebview() {
			webviewPanel.webview.postMessage({
				type: 'update',
				text: document.getText(),
			});
			webviewPanel.webview.postMessage({
				type: 'tagConfig',
				config: getTagConfig()
			});
		}

		// 监听文档变更（外部修改、撤销重做等）
		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === document.uri.toString()) {
				// 如果是 webview 发起的编辑，跳过回弹更新
				if (isUpdatingFromWebview) {
					isUpdatingFromWebview = false;
					return;
				}
				// 只有当 contentChanges 不为空时才更新（排除保存等无内容变更的事件）
				if (e.contentChanges.length > 0) {
					updateWebview();
				}
			}
		});

		// Clean up listener when editor is closed
		webviewPanel.onDidDispose(() => {
			changeDocumentSubscription.dispose();
		});

		// Receive messages from the webview
		webviewPanel.webview.onDidReceiveMessage(async e => {
			switch (e.type) {
				case 'ready':
					// WebView is ready, send initial data
					updateWebview();
					// Send localized strings for the webview
					webviewPanel.webview.postMessage({
						type: 'i18nStrings',
						strings: this.getWebviewStrings(),
					});
					return;

				case 'nodeClick':
					// Handle node click for code navigation
					if (e.node && e.node.symbol) {
						await this.navigateToCode(e.node, webviewPanel.webview);
					}
					return;

				case 'edit':
					// WebView 请求更新文档
					// 标记为 webview 发起的更新，防止 onDidChangeTextDocument 回弹
					isUpdatingFromWebview = true;
					this.updateTextDocument(document, e.data);
					return;

				case 'contextMenu':
					// 处理右键菜单
					await this.showContextMenu(e.nodeId, webviewPanel.webview);
					return;

				case 'requestCustomTag':
					// 用户请求添加自定义标签
					await this.handleCustomTagRequest(e.nodeId, webviewPanel.webview, updateWebview);
					return;

				case 'requestMethodLibrary':
					// 用户请求从方法库绑定代码
					await this.handleMethodLibraryRequest(e.nodeId, webviewPanel.webview);
					return;
			}
		});

		// 初始化时发送数据
		updateWebview();
	}

	/**
	 * 显示右键上下文菜单
	 */
	private async showContextMenu(nodeId: string, webview: vscode.Webview): Promise<void> {
		const actions = await vscode.window.showQuickPick([
			{ label: `$(add) ${vscode.l10n.t('Add child node')}`, action: 'addChild' },
			{ label: `$(symbol-keyword) ${vscode.l10n.t('Add tag')}`, action: 'addTag' },
			{ label: `$(go-to-file) ${vscode.l10n.t('Go to code')}`, action: 'gotoCode' },
			{ label: `$(trash) ${vscode.l10n.t('Delete node')}`, action: 'delete' },
		], {
			placeHolder: vscode.l10n.t('Select action')
		});

		if (actions) {
			webview.postMessage({
				type: 'contextMenuAction',
				nodeId,
				action: actions.action
			});
		}
	}

	/**
	 * 处理自定义标签请求
	 */
	private async handleCustomTagRequest(
		nodeId: string, 
		webview: vscode.Webview,
		updateWebview: () => void
	): Promise<void> {
		const tagName = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Enter custom tag name'),
			placeHolder: vscode.l10n.t('e.g.: Important, To optimize, Done'),
			validateInput: (value) => {
				if (!value || !value.trim()) {
					return vscode.l10n.t('Tag name cannot be empty');
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
				const yesOption = vscode.l10n.t('Yes, save as predefined tag');
				const noOption = vscode.l10n.t('No, add to current node only');
				const saveToConfig = await vscode.window.showQuickPick(
					[yesOption, noOption],
					{ placeHolder: vscode.l10n.t('Save as predefined tag?') }
				);

				if (saveToConfig === yesOption) {
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
			webview.postMessage({
				type: 'addCustomTag',
				tagName: trimmedName,
				nodeId
			});
		}
	}

	/**
	 * 处理方法库绑定请求
	 */
	private async handleMethodLibraryRequest(
		nodeId: string,
		webview: vscode.Webview
	): Promise<void> {
		const methods = this.methodLibrary.getAll();

		if (methods.length === 0) {
			const openEditorBtn = vscode.l10n.t('Open code editor');
			const action = await vscode.window.showWarningMessage(
				vscode.l10n.t('Method library is empty. Please right-click \'Add to Method Library\' in code editor'),
				openEditorBtn
			);
			if (action === openEditorBtn) {
				// 打开一个新的编辑器以便用户添加方法
				vscode.commands.executeCommand('workbench.action.files.openFile');
			}
			return;
		}

		// 构建 QuickPick 项
		const items = methods.map(m => ({
			label: m.name,
			description: m.containerName || '',
			detail: `📄 ${m.uri}:${m.line + 1}`,
			method: m,
		}));

		// 添加管理选项
		items.push({
			label: `$(trash) ${vscode.l10n.t('Clear method library')}`,
			description: '',
			detail: vscode.l10n.t('{0} methods in total', String(methods.length)),
			method: null as any,
		});

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: vscode.l10n.t('Select method to bind'),
			matchOnDescription: true,
			matchOnDetail: true,
		});

		if (!selected) {
			return;
		}

		// 处理清空操作
		if (!selected.method) {
			const confirmBtn = vscode.l10n.t('Confirm');
			const confirm = await vscode.window.showWarningMessage(
				vscode.l10n.t('Are you sure you want to clear the method library?'),
				{ modal: true },
				confirmBtn
			);
			if (confirm === confirmBtn) {
				await this.methodLibrary.clear();
			}
			return;
		}

		// 发送绑定信息到 WebView
		webview.postMessage({
			type: 'bindMethod',
			nodeId,
			method: {
				name: selected.method.name,
				uri: selected.method.uri,
				containerName: selected.method.containerName,
				line: selected.method.line,
				signature: selected.method.signature,
			},
		});

		// 根据配置决定是否移除该方法
		const config = vscode.workspace.getConfiguration('callGraph');
		const removeAfterBind = config.get<boolean>('removeMethodAfterBind', false);
		
		if (removeAfterBind) {
			await this.methodLibrary.remove(selected.method.id);
			console.log(`[方法库] 已移除方法: ${selected.method.name}`);
		}
	}

	/**
	 * Navigate to code location based on node symbol
	 */
	private async navigateToCode(node: Node, webview: vscode.Webview): Promise<void> {
		console.log('[导航] 开始跳转:', JSON.stringify({
			nodeId: node.id,
			label: node.label,
			symbol: node.symbol,
		}));

		if (!node.symbol) {
			vscode.window.showWarningMessage(vscode.l10n.t('This node has no bound code symbol'));
			webview.postMessage({
				type: 'navigationFailed',
				nodeId: node.id,
				reason: 'no-symbol'
			});
			return;
		}

		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				vscode.window.showErrorMessage(vscode.l10n.t('No open workspace'));
				webview.postMessage({
					type: 'navigationFailed',
					nodeId: node.id,
					reason: 'no-workspace'
				});
				return;
			}

			const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, node.symbol.uri);
			console.log('[导航] 目标文件:', fileUri.fsPath);

			// 尝试打开文件
			let doc: vscode.TextDocument;
			try {
				doc = await vscode.workspace.openTextDocument(fileUri);
			} catch {
				vscode.window.showErrorMessage(vscode.l10n.t('File does not exist: {0}', node.symbol.uri));
				webview.postMessage({
					type: 'navigationFailed',
					nodeId: node.id,
					reason: 'file-not-found'
				});
				return;
			}

			// 确定目标 ViewColumn
			// 如果只有一个编辑器组（当前的 callgraph），在旁边创建新组
			// 如果有多个编辑器组，选择一个非当前的组
			let targetColumn = vscode.ViewColumn.Beside;

			const visibleEditors = vscode.window.visibleTextEditors;
			if (visibleEditors.length > 0) {
				// 找到一个不是 callgraph 文件的编辑器
				const otherEditor = visibleEditors.find(e => !e.document.fileName.endsWith('.callgraph.json'));
				if (otherEditor && otherEditor.viewColumn) {
					targetColumn = otherEditor.viewColumn;
				}
			}

			const editor = await vscode.window.showTextDocument(doc, {
				viewColumn: targetColumn,
				preserveFocus: false,  // 聚焦到新打开的编辑器
			});

			// 使用 LSP 查找符号定义
			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				fileUri
			);

			if (symbols) {
				console.log('[导航] DocumentSymbol 数量:', symbols.length);
				console.log('[导航] 查找参数: name=%s, containerName=%s, line=%s',
					node.symbol.name, node.symbol.containerName ?? '(无)', node.symbol.line ?? '(无)');
				const targetSymbol = this.findSymbol(symbols, node.symbol.name, node.symbol.containerName, node.symbol.line);
				if (targetSymbol) {
					const position = targetSymbol.selectionRange.start;
					console.log('[导航] ✅ LSP 符号匹配成功: "%s" → 行 %d, 列 %d',
						targetSymbol.name, position.line + 1, position.character);
					editor.selection = new vscode.Selection(position, position);
					editor.revealRange(targetSymbol.selectionRange, vscode.TextEditorRevealType.InCenter);
					// 跳转成功
					webview.postMessage({
						type: 'navigationSuccess',
						nodeId: node.id
					});
					return;
				}
			} else {
				console.log('[导航] ⚠️ DocumentSymbol 提供者返回空');
			}

			// 回退：使用行号
			if (node.symbol.line !== undefined) {
				const line = node.symbol.line;
				console.log('[导航] 📍 回退到行号定位: 行 %d', line + 1);
				const position = new vscode.Position(line, 0);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
				// 跳转成功（使用行号）
				webview.postMessage({
					type: 'navigationSuccess',
					nodeId: node.id
				});
				return;
			}
			
			// 找不到符号，标记为 broken
			console.log('[导航] ❌ 未找到符号，标记为 broken');
			vscode.window.showWarningMessage(vscode.l10n.t('Symbol not found: {0}', node.symbol.name));
			webview.postMessage({
				type: 'navigationFailed',
				nodeId: node.id,
				reason: 'symbol-not-found'
			});
		} catch (err) {
			console.error('导航到代码失败:', err);
			vscode.window.showErrorMessage(vscode.l10n.t('Unable to navigate to code: {0}', String(err)));
			webview.postMessage({
				type: 'navigationFailed',
				nodeId: node.id,
				reason: 'error'
			});
		}
	}

	/**
	 * 在符号树中查找目标符号
	 * 支持跨语言匹配：C# 符号名可能包含参数（如 "Method(Type1, Type2)"），
	 * 而存储的名称可能只有纯方法名。两边都做规范化后再比较。
	 */
	private findSymbol(
		symbols: vscode.DocumentSymbol[],
		name: string,
		containerName?: string,
		line?: number,
		_depth: number = 0
	): vscode.DocumentSymbol | undefined {
		// 提取目标纯方法名
		const { bareName: targetBareName } = normalizeSymbolName(name);
		const indent = '  '.repeat(_depth);

		if (_depth === 0) {
			console.log('[查找] 开始查找符号: name="%s", bareName="%s", container="%s", line=%s',
				name, targetBareName, containerName ?? '(无)', line ?? '(无)');
		}

		// 构建限定名变体（用于 Lua 等语言：Container.method / Container:method）
		const qualifiedNames: string[] = [];
		if (containerName) {
			qualifiedNames.push(`${containerName}.${name}`);
			qualifiedNames.push(`${containerName}:${name}`);
			qualifiedNames.push(`${containerName}.${targetBareName}`);
			qualifiedNames.push(`${containerName}:${targetBareName}`);
		}

		for (const symbol of symbols) {
			const { bareName: symbolBareName } = normalizeSymbolName(symbol.name);

			// 如果有容器名，先找容器
			if (containerName) {
				if (symbol.name === containerName && symbol.children) {
					console.log('%s[查找] 找到容器 "%s"，子符号: [%s]',
						indent, containerName,
						symbol.children.map(c => `"${c.name}"(L${c.selectionRange.start.line})`).join(', '));

					// 在容器内查找：精确匹配 → 纯名匹配 → 行号匹配
					const exactChild = symbol.children.find(c => c.name === name);
					if (exactChild) {
						console.log('%s[查找] ✅ 容器内精确匹配: "%s"', indent, exactChild.name);
						return exactChild;
					}

					const bareChild = symbol.children.find(c => {
						const { bareName } = normalizeSymbolName(c.name);
						return bareName === targetBareName;
					});
					if (bareChild) {
						console.log('%s[查找] ✅ 容器内 bareName 匹配: "%s" → "%s"', indent, bareChild.name, targetBareName);
						return bareChild;
					}

					// 按行号匹配（最可靠的二次匹配）
					if (line !== undefined) {
						const lineChild = symbol.children.find(c => c.selectionRange.start.line === line);
						if (lineChild) {
							console.log('%s[查找] ✅ 容器内行号匹配: "%s" (L%d)', indent, lineChild.name, line);
							return lineChild;
						}
					}

					console.log('%s[查找] ⚠️ 容器 "%s" 内未找到匹配', indent, containerName);
				}

				// 限定名匹配（Lua/Python 等语言：符号名为 "Container.method" 或 "Container:method"）
				if (qualifiedNames.includes(symbol.name)) {
					console.log('%s[查找] ✅ 限定名匹配: "%s" (L%d)', indent, symbol.name, symbol.selectionRange.start.line);
					return symbol;
				}
				// 限定名的 bareName 匹配（如 C# "Container.Method(Type)" → bareName "Container.Method"）
				if (qualifiedNames.includes(symbolBareName) && symbolBareName !== symbol.name) {
					console.log('%s[查找] ✅ 限定名 bareName 匹配: "%s" → "%s" (L%d)',
						indent, symbol.name, symbolBareName, symbol.selectionRange.start.line);
					return symbol;
				}

				// 后缀匹配（Lua 等语言：代码用 pmodule:method 但 containerName 是模块名）
				// 符号名以 .name 或 :name 结尾即可匹配
				const suffixes = [`.${name}`, `:${name}`, `.${targetBareName}`, `:${targetBareName}`];
				if (suffixes.some(s => symbol.name.endsWith(s) || symbolBareName.endsWith(s))) {
					console.log('%s[查找] ✅ 后缀匹配: "%s" 匹配方法名 "%s" (L%d)',
						indent, symbol.name, name, symbol.selectionRange.start.line);
					return symbol;
				}
			}

			// 精确匹配名称
			if (symbol.name === name) {
				console.log('%s[查找] ✅ 精确名称匹配: "%s" (L%d)', indent, symbol.name, symbol.selectionRange.start.line);
				return symbol;
			}

			// 纯名匹配（去掉参数后的方法名）
			if (symbolBareName === targetBareName && symbolBareName !== symbol.name) {
				console.log('%s[查找] ✅ bareName 匹配: "%s" → "%s" (L%d)',
					indent, symbol.name, targetBareName, symbol.selectionRange.start.line);
				return symbol;
			}

			// 递归搜索子符号
			if (symbol.children) {
				const found = this.findSymbol(symbol.children, name, containerName, line, _depth + 1);
				if (found) { return found; }
			}
		}

		// 最终回退：在所有符号中按行号匹配（跨语言兜底）
		if (_depth === 0 && line !== undefined) {
			const lineMatch = this.findSymbolByLine(symbols, line);
			if (lineMatch) {
				console.log('[查找] ✅ 全局行号回退匹配: "%s" (L%d)', lineMatch.name, line);
				return lineMatch;
			}
		}

		if (_depth === 0) {
			console.log('[查找] ❌ 未找到匹配符号');
		}
		return undefined;
	}

	/**
	 * 在符号树中按行号递归查找符号
	 */
	private findSymbolByLine(symbols: vscode.DocumentSymbol[], line: number): vscode.DocumentSymbol | undefined {
		for (const symbol of symbols) {
			if (symbol.selectionRange.start.line === line) {
				return symbol;
			}
			if (symbol.children) {
				const found = this.findSymbolByLine(symbol.children, line);
				if (found) { return found; }
			}
		}
		return undefined;
	}

	/**
	 * Get the static html for the webview
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		// Get URI for the bundled app
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'callgraph-webview.js')
		);

		const nonce = getNonce();
		const lang = vscode.env.language;

		return /* html */`
			<!DOCTYPE html>
			<html lang="${lang}">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource};">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Call Graph Editor</title>
				<style>
					html, body {
						margin: 0;
						padding: 0;
						width: 100%;
						height: 100%;
						overflow: hidden;
						background-color: var(--vscode-editor-background, #1e1e1e);
					}
					#graph-container {
						width: 100%;
						height: 100%;
					}
					/* X6 节点样式 */
					.x6-node text {
						font-family: var(--vscode-font-family, 'Segoe WPC', 'Segoe UI', sans-serif);
					}
				</style>
			</head>
			<body>
				<div id="graph-container"></div>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>
		`;
	}

	/**
	 * Parse document content as JSON
	 */
	private getDocumentAsJson(document: vscode.TextDocument): CallGraphDocument {
		const text = document.getText();
		if (text.trim().length === 0) {
			return { nodes: [], edges: [] };
		}

		try {
			return JSON.parse(text);
		} catch {
			console.error('Invalid JSON in document');
			return { nodes: [], edges: [] };
		}
	}

	/**
	 * Write JSON back to document
	 */
	private updateTextDocument(document: vscode.TextDocument, data: CallGraphDocument) {
		const edit = new vscode.WorkspaceEdit();

		edit.replace(
			document.uri,
			new vscode.Range(0, 0, document.lineCount, 0),
			JSON.stringify(data, null, 2)
		);

		return vscode.workspace.applyEdit(edit);
	}

	/**
	 * Build localized string table for the webview
	 */
	private getWebviewStrings(): Record<string, string> {
		return {
			'contextMenu.createCodeNode': vscode.l10n.t('Create Code Node'),
			'contextMenu.createNoteNode': vscode.l10n.t('Create Note Node'),
			'contextMenu.editNode': vscode.l10n.t('Edit Node'),
			'contextMenu.tags': vscode.l10n.t('Tags'),
			'contextMenu.newTag': vscode.l10n.t('+ New Tag...'),
			'contextMenu.deleteNode': vscode.l10n.t('Delete Node'),
			'contextMenu.deleteEdge': vscode.l10n.t('Delete Edge'),
			'toolbar.connectToNode': vscode.l10n.t('Connect to another node'),
			'toolbar.bindMethod': vscode.l10n.t('Bind code method'),
			'toolbar.selectChildren': vscode.l10n.t('Select all children'),
			'connectMode.clickTarget': vscode.l10n.t('Click target node to complete connection, press Esc to cancel'),
			'prompt.enterTagName': vscode.l10n.t('Enter tag name:'),
			'counter.nodes': vscode.l10n.t('Nodes'),
			'counter.edges': vscode.l10n.t('Edges'),
			'align.left': vscode.l10n.t('Align left'),
			'align.centerH': vscode.l10n.t('Align center horizontally'),
			'align.right': vscode.l10n.t('Align right'),
			'align.top': vscode.l10n.t('Align top'),
			'align.centerV': vscode.l10n.t('Align center vertically'),
			'align.bottom': vscode.l10n.t('Align bottom'),
			'align.distributeH': vscode.l10n.t('Distribute horizontally'),
			'align.distributeV': vscode.l10n.t('Distribute vertically'),
			'layout.autoLayoutSelected': vscode.l10n.t('Auto layout (selected)'),
			'layout.autoLayout': vscode.l10n.t('Auto layout (no selection=global, selection=local)'),
			'layout.directionTB': vscode.l10n.t('Layout direction: Top to Bottom'),
			'layout.directionLR': vscode.l10n.t('Layout direction: Left to Right'),
			'layout.fitCanvas': vscode.l10n.t('Fit canvas'),
			'layout.selectAlgorithm': vscode.l10n.t('Layout algorithm'),
			'layout.group.hierarchical': vscode.l10n.t('Hierarchical'),
			'layout.group.tree': vscode.l10n.t('Tree'),
			'defaults.newNote': vscode.l10n.t('New Note'),
			'defaults.newCode': vscode.l10n.t('New Code'),
			'defaults.noteContent': vscode.l10n.t('# Note\n- [ ] TODO\n\nClick to edit...'),
		};
	}
}

