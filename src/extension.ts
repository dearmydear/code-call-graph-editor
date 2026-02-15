import * as vscode from 'vscode';
import * as path from 'path';
// 使用 React Flow 版本
import { CallGraphEditorProvider } from './callGraphEditorReactFlow';
import type { CallGraphDocument } from './models/callGraphDocument';
import { LSPCallHierarchyProvider } from './services/lspIntegration';
import { CallGraphGenerator } from './services/callGraphGenerator';
import { MethodLibrary, getSymbolAtCursor, sanitizeFileName } from './services/methodLibrary';

const LAST_ACTIVE_GRAPH_KEY = 'callGraph.lastActiveGraphUri';
const CALL_GRAPH_VIEW_TYPE = 'codeCallGraph.callGraph';
const CALL_GRAPH_SUFFIX = '.callgraph.json';

type MutableCallGraphDocument = CallGraphDocument & {
	nodes: Array<Record<string, any>>;
	edges: Array<Record<string, any>>;
};

export function activate(context: vscode.ExtensionContext) {
	// 创建方法库实例
	const methodLibrary = new MethodLibrary(context);
	let lastActiveCallGraphUri = readStoredCallGraphUri(context);

	const persistLastActiveCallGraphUri = (uri: vscode.Uri) => {
		lastActiveCallGraphUri = uri;
		void context.workspaceState.update(LAST_ACTIVE_GRAPH_KEY, uri.toString());
	};

	const refreshLastActiveCallGraphFromTabs = () => {
		const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
		if (!activeTab) {
			return;
		}

		const uri = extractCallGraphUriFromTabInput(activeTab.input);
		if (uri) {
			persistLastActiveCallGraphUri(uri);
		}
	};

	// Register our custom editor provider - 传入方法库实例
	context.subscriptions.push(CallGraphEditorProvider.register(context, methodLibrary));

	context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(refreshLastActiveCallGraphFromTabs));
	context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(refreshLastActiveCallGraphFromTabs));
	refreshLastActiveCallGraphFromTabs();

	// Phase 2: Register LSP test command
	context.subscriptions.push(
		vscode.commands.registerCommand('callGraph.testLSP', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage(vscode.l10n.t('Please open a code file first'));
				return;
			}

			// 显示进度提示
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Querying call hierarchy...'),
				cancellable: false
			}, async (progress) => {
				try {
					const lspProvider = new LSPCallHierarchyProvider();
					const hierarchy = await lspProvider.getCallHierarchy(
						editor.document,
						editor.selection.active,
						2  // 深度为 2
					);

					if (hierarchy) {
						// 计算统计信息
						const callerCount = hierarchy.callers?.length || 0;
						const calleeCount = hierarchy.callees?.length || 0;
						const totalCallers = countTotalNodes(hierarchy.callers || []);
						const totalCallees = countTotalNodes(hierarchy.callees || []);

						// 输出清晰的控制台信息
						console.log('\n' + '='.repeat(60));
						console.log('📊 LSP 调用层次查询结果');
						console.log('='.repeat(60));
						console.log(`✅ 方法名称: ${hierarchy.name}`);
						console.log(`📍 文件位置: ${vscode.workspace.asRelativePath(hierarchy.uri)}:${hierarchy.range.start.line + 1}`);
						console.log(`📥 直接调用者: ${callerCount} 个 (总计: ${totalCallers} 个)`);
						console.log(`📤 直接被调用者: ${calleeCount} 个 (总计: ${totalCallees} 个)`);
						console.log('='.repeat(60));
						
						if (callerCount > 0) {
							console.log('\n📥 调用者列表:');
							hierarchy.callers.forEach((caller, idx) => {
								console.log(`  ${idx + 1}. ${caller.name} (${vscode.workspace.asRelativePath(caller.uri)}:${caller.range.start.line + 1})`);
							});
						}
						
						if (calleeCount > 0) {
							console.log('\n📤 被调用者列表:');
							hierarchy.callees.forEach((callee, idx) => {
								console.log(`  ${idx + 1}. ${callee.name} (${vscode.workspace.asRelativePath(callee.uri)}:${callee.range.start.line + 1})`);
							});
						}
						
						console.log('\n💾 完整 JSON 数据:');
						console.log(JSON.stringify(hierarchy, null, 2));
						console.log('='.repeat(60) + '\n');

						// 显示详细信息（这个会在扩展开发主机窗口的右下角弹出）
						const message = [
							vscode.l10n.t('Found method: {0}', hierarchy.name),
							vscode.l10n.t('Direct callers: {0} (total: {1})', String(callerCount), String(totalCallers)),
							vscode.l10n.t('Direct callees: {0} (total: {1})', String(calleeCount), String(totalCallees)),
							vscode.l10n.t('Location: {0}', `${vscode.workspace.asRelativePath(hierarchy.uri)}:${hierarchy.range.start.line + 1}`)
						].join('\n');

						const viewOutputBtn = vscode.l10n.t('View detailed output');
						vscode.window.showInformationMessage(message, viewOutputBtn).then(selection => {
							if (selection === viewOutputBtn) {
								// 显示输出面板
								vscode.commands.executeCommand('workbench.action.output.toggleOutput');
							}
						});
					} else {
						vscode.window.showWarningMessage(
							vscode.l10n.t('Unable to get call hierarchy. Please ensure: 1. Cursor is on a method/function definition 2. Current language supports call hierarchy 3. LSP server is running')
						);
					}
				} catch (error) {
					console.error('LSP query error:', error);
					vscode.window.showErrorMessage(vscode.l10n.t('Query failed: {0}', error instanceof Error ? error.message : String(error)));
				}
			});
		})
	);

	// 创建节点关系图 - 从当前方法创建单节点图
	context.subscriptions.push(
		vscode.commands.registerCommand('callGraph.createGraphFromMethod', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage(vscode.l10n.t('Please open a code file first'));
				return;
			}

			try {
				// 获取光标位置的符号信息
				const symbolInfo = await getSymbolAtCursor(editor);
				if (!symbolInfo) {
					// getSymbolAtCursor 内部已经显示了错误提示
					return;
				}

				// 创建只包含当前方法的调用图文档
				const callGraphDoc = {
					title: vscode.l10n.t('Call graph for {0}', symbolInfo.name),
					nodes: [
						{
							id: `node-${Date.now()}`,
							label: symbolInfo.name,
							type: 'code' as const,
							symbol: {
								name: symbolInfo.name,
								uri: symbolInfo.uri,
								containerName: symbolInfo.containerName,
								line: symbolInfo.line,
								signature: symbolInfo.signature,
							},
							status: 'normal' as const,
							x: 400,  // 居中位置
							y: 300,
						}
					],
					edges: []
				};

				// 生成文件名（使用清理后的方法名，避免特殊字符导致文件创建失败）
				const safeName = sanitizeFileName(symbolInfo.name);
				const fileName = `${safeName}.callgraph.json`;
				const fileUri = vscode.Uri.joinPath(
					vscode.Uri.file(path.dirname(editor.document.uri.fsPath)),
					fileName
				);

				// 检查文件是否已存在
				try {
					await vscode.workspace.fs.stat(fileUri);
					const overwriteBtn = vscode.l10n.t('Overwrite');
					const overwrite = await vscode.window.showWarningMessage(
						vscode.l10n.t('File "{0}" already exists. Overwrite?', fileName),
						{ modal: true },
						overwriteBtn
					);
					if (overwrite !== overwriteBtn) {
						return;
					}
				} catch {
					// 文件不存在，继续创建
				}

				// 保存文件
				await vscode.workspace.fs.writeFile(
					fileUri,
					Buffer.from(JSON.stringify(callGraphDoc, null, 2), 'utf8')
				);

				// 打开自定义编辑器
				await vscode.commands.executeCommand('vscode.openWith', fileUri, 'codeCallGraph.callGraph');

				vscode.window.showInformationMessage(
					vscode.l10n.t('Call graph created: {0}', fileName)
				);

			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to create call graph: {0}', errorMessage));
				console.error('创建节点关系图错误:', error);
			}
		})
	);

	// 添加方法到最后活动代码图
	context.subscriptions.push(
		vscode.commands.registerCommand('callGraph.addToActiveGraph', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage(vscode.l10n.t('Please open a code file first'));
				return;
			}

			try {
				const symbolInfo = await getSymbolAtCursor(editor);
				if (!symbolInfo) {
					return;
				}

				refreshLastActiveCallGraphFromTabs();

				const openCallGraphUris = getOpenCallGraphUris();
				let targetUri: vscode.Uri | undefined;

				if (lastActiveCallGraphUri && openCallGraphUris.some(uri => uri.toString() === lastActiveCallGraphUri?.toString())) {
					targetUri = lastActiveCallGraphUri;
				} else if (openCallGraphUris.length > 0) {
					targetUri = openCallGraphUris[0];
				}

				if (!targetUri) {
					targetUri = await pickCallGraphTarget();
					if (!targetUri) {
						return;
					}

					await vscode.commands.executeCommand('vscode.openWith', targetUri, CALL_GRAPH_VIEW_TYPE);
				}

				const targetDoc = await vscode.workspace.openTextDocument(targetUri);
				const callGraphDoc = parseCallGraphDocument(targetDoc.getText());

				const nodeId = createNodeId(callGraphDoc.nodes);
				const position = calculateNodePosition(callGraphDoc.nodes, 220, 140);

				callGraphDoc.nodes.push({
					id: nodeId,
					label: symbolInfo.name,
					type: 'code',
					symbol: {
						name: symbolInfo.name,
						uri: symbolInfo.uri,
						containerName: symbolInfo.containerName,
						line: symbolInfo.line,
						signature: symbolInfo.signature,
					},
					status: 'normal',
					x: position.x,
					y: position.y,
				});

				const edit = new vscode.WorkspaceEdit();
				edit.replace(
					targetDoc.uri,
					new vscode.Range(0, 0, targetDoc.lineCount, 0),
					JSON.stringify(callGraphDoc, null, 2)
				);

				const applied = await vscode.workspace.applyEdit(edit);
				if (!applied) {
					vscode.window.showErrorMessage(vscode.l10n.t('Failed to update call graph file'));
					return;
				}

				persistLastActiveCallGraphUri(targetDoc.uri);
				vscode.window.showInformationMessage(
					vscode.l10n.t('Added method "{0}" to call graph: {1}', symbolInfo.name, path.basename(targetDoc.uri.fsPath))
				);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to add method to call graph: {0}', errorMessage));
				console.error('添加到活动代码图错误:', error);
			}
		})
	);

	// 添加方法到方法库
	context.subscriptions.push(
		vscode.commands.registerCommand('callGraph.addToMethodLibrary', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage(vscode.l10n.t('Please open a code file first'));
				return;
			}

			const symbolInfo = await getSymbolAtCursor(editor);
			if (symbolInfo) {
				await methodLibrary.add(symbolInfo);
			}
		})
	);

	// 查看方法库
	context.subscriptions.push(
		vscode.commands.registerCommand('callGraph.viewMethodLibrary', async () => {
			const methods = methodLibrary.getAll();
			if (methods.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('Method library is empty. Please right-click in a code editor to add methods'));
				return;
			}

			const items = methods.map(m => ({
				label: m.name,
				description: m.containerName ? `${m.containerName}` : '',
				detail: `${m.uri}:${m.line + 1}`,
				method: m,
			}));

			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: vscode.l10n.t('Methods in the method library'),
				matchOnDescription: true,
				matchOnDetail: true,
			});

			if (selected) {
				// 跳转到方法位置
				const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
				if (workspaceFolder) {
					const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, selected.method.uri);
					const doc = await vscode.workspace.openTextDocument(fileUri);
					const editor = await vscode.window.showTextDocument(doc);
					const pos = new vscode.Position(selected.method.line, 0);
					editor.selection = new vscode.Selection(pos, pos);
					editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
				}
			}
		})
	);

	// 清空方法库
	context.subscriptions.push(
		vscode.commands.registerCommand('callGraph.clearMethodLibrary', async () => {
			const confirmBtn = vscode.l10n.t('Confirm');
			const confirm = await vscode.window.showWarningMessage(
				vscode.l10n.t('Are you sure you want to clear the method library?'),
				{ modal: true },
				confirmBtn
			);
			if (confirm === confirmBtn) {
				await methodLibrary.clear();
			}
		})
	);
}

/**
 * 递归计算节点总数
 */
function countTotalNodes(nodes: any[]): number {
	let count = nodes.length;
	for (const node of nodes) {
		if (node.callers) {
			count += countTotalNodes(node.callers);
		}
		if (node.callees) {
			count += countTotalNodes(node.callees);
		}
	}
	return count;
}

function readStoredCallGraphUri(context: vscode.ExtensionContext): vscode.Uri | undefined {
	const raw = context.workspaceState.get<string>(LAST_ACTIVE_GRAPH_KEY);
	if (!raw) {
		return undefined;
	}

	try {
		const uri = vscode.Uri.parse(raw);
		return isCallGraphUri(uri) ? uri : undefined;
	} catch {
		return undefined;
	}
}

function isCallGraphUri(uri: vscode.Uri): boolean {
	return uri.scheme === 'file' && uri.fsPath.toLowerCase().endsWith(CALL_GRAPH_SUFFIX);
}

function extractCallGraphUriFromTabInput(input: unknown): vscode.Uri | undefined {
	if (input instanceof vscode.TabInputCustom) {
		if (input.viewType === CALL_GRAPH_VIEW_TYPE && isCallGraphUri(input.uri)) {
			return input.uri;
		}
		return undefined;
	}

	if (input instanceof vscode.TabInputText && isCallGraphUri(input.uri)) {
		return input.uri;
	}

	return undefined;
}

async function pickCallGraphTarget(): Promise<vscode.Uri | undefined> {
	const files = await vscode.workspace.findFiles(`**/*${CALL_GRAPH_SUFFIX}`, '**/node_modules/**');
	if (files.length === 0) {
		vscode.window.showWarningMessage(vscode.l10n.t('No call graph file found. Please open or create a .callgraph.json file first'));
		return undefined;
	}

	const items = files.map(uri => ({
		label: vscode.workspace.asRelativePath(uri),
		detail: uri.fsPath,
		uri,
	}));

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: vscode.l10n.t('Select target call graph file'),
		matchOnDetail: true,
	});

	return picked?.uri;
}

function getOpenCallGraphUris(): vscode.Uri[] {
	const result = new Map<string, vscode.Uri>();
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const uri = extractCallGraphUriFromTabInput(tab.input);
			if (uri) {
				result.set(uri.toString(), uri);
			}
		}
	}
	return [...result.values()];
}

function parseCallGraphDocument(text: string): MutableCallGraphDocument {
	if (!text.trim()) {
		return { title: '', nodes: [], edges: [] };
	}

	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(vscode.l10n.t('Target call graph file contains invalid JSON'));
	}

	if (!parsed || typeof parsed !== 'object') {
		throw new Error(vscode.l10n.t('Target call graph file content is invalid'));
	}

	if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
		throw new Error(vscode.l10n.t('Target call graph file must contain nodes and edges arrays'));
	}

	return parsed as MutableCallGraphDocument;
}

function createNodeId(nodes: Array<Record<string, any>>): string {
	const idSet = new Set(nodes.map(node => String(node.id)));
	let id = '';
	do {
		id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	} while (idSet.has(id));
	return id;
}

function calculateNodePosition(
	nodes: Array<Record<string, any>>,
	horizontalOffset: number,
	verticalOffset: number
): { x: number; y: number } {
	const positionedNodes = nodes.filter(node => typeof node.x === 'number' && typeof node.y === 'number');
	if (positionedNodes.length === 0) {
		return { x: 200, y: 120 };
	}

	const selectedNodes = positionedNodes.filter(node => node.selected === true);
	if (selectedNodes.length > 0) {
		const anchor = selectedNodes.reduce((best, current) => {
			if (current.x > best.x) {
				return current;
			}
			if (current.x === best.x && current.y > best.y) {
				return current;
			}
			return best;
		}, selectedNodes[0]);

		return {
			x: anchor.x + horizontalOffset,
			y: anchor.y + verticalOffset,
		};
	}

	const rightMost = positionedNodes.reduce((best, current) => {
		if (current.x > best.x) {
			return current;
		}
		if (current.x === best.x && current.y > best.y) {
			return current;
		}
		return best;
	}, positionedNodes[0]);

	return {
		x: rightMost.x + horizontalOffset,
		y: rightMost.y,
	};
}
