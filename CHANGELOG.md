# Changelog

本文件记录项目的重要更新。

格式参考 Keep a Changelog，版本号遵循 Semantic Versioning（SemVer）。

## [Unreleased]

### Added
- 暂无。

### Changed
- 暂无。

### Fixed
- 暂无。

## [0.0.3] - 2026-02-15

### Added
- 新增命令“Add to Active Call Graph”（`callGraph.addToActiveGraph`），支持从代码编辑器将当前方法追加到活动调用图。
- 新增右键菜单入口（代码编辑器上下文菜单），并增加对应中英文本地化文案。
- 新增活动调用图选择与回退机制：优先使用最后活动图页，未打开图页时支持在工作区选择目标 `.callgraph.json`。
- 新增文档与演示资源：README 中增加 “Add to Active Call Graph” 说明与 `images/add-to-active-callgraph.gif`。

### Changed
- 扩展激活逻辑增强：跟踪并持久化最后活动调用图页，改进跨标签页场景下的目标图定位体验。
- 完善 Windows 开发环境文档（README、README.zh-cn、DEVELOPMENT），补充 `npm.cmd`、PATH 刷新与 TypeScript 诊断恢复流程。

### Docs
- 新增并初始化项目更新日志文件（本文件）。

## [0.0.2] - 2026-02-10

### Added
- 增强多语言支持（i18n/l10n）。
- 优化代码图导航体验。
- 增加 Tooltip 交互能力。
- 增加 GitHub Sponsors 配置（`.github/FUNDING.yml`）。

### Changed
- 清理并优化扩展包元数据（`package.json`、`package.nls.json` 等）。

### Fixed
- 将资源目录从 `Images` 更名为 `images`，修复大小写敏感文件系统下的资源引用问题。

### Docs
- 补充并扩展 AI 提示词相关文档（`.github/copilot-instructions.md`、`DEVELOPMENT.md`）。

## [0.0.1] - 2026-02-10

### Added
- 首次发布 Code Call Graph Editor。
- 提供 `.callgraph.json` 自定义编辑器与图形化节点/连线编辑能力。
- 支持基于 LSP 调用层级生成调用图，并提供代码跳转与方法库能力。
- 提供多种布局算法、对齐分布工具、标签与注释节点等核心功能。
- 提供中英文文档与中文本地化资源。

[Unreleased]: https://github.com/dearmydear/call-graph-editor/compare/0.0.3...HEAD
[0.0.3]: https://github.com/dearmydear/call-graph-editor/compare/8853d2d...HEAD
[0.0.2]: https://github.com/dearmydear/call-graph-editor/compare/90f96c0...8853d2d
[0.0.1]: https://github.com/dearmydear/call-graph-editor/commit/90f96c0