'use strict';

// 侧栏工作区「置顶」运行时补丁（幂等、锚点不匹配时跳过且绝不损坏文件）。
//
// 背景：左侧栏的工作区分组行 ⋯ 菜单只有 重命名/删除/打开项目目录，常用
// 工作区多了以后要靠手动拖拽排前——本补丁给 ⋯ 菜单加「置顶到列表顶部」：
//   · 可多选：置顶的工作区恒排最前，按置顶时间降序（最近置顶在最上）；
//   · 未置顶区保持宿主原序（手动排序/拖拽/最近更新均不受影响）；
//   · 持久化：localStorage（键 dsh-desktop.workspace-pins.v1，值
//     { [workspaceId]: pinMillis }），按工作区 id 记账，重命名不丢；
//   · 未分组桶（无 workspaceId）不显示置顶项；
//   · 视觉：置顶行 folder 图标着主题色 + 标题前主题色小圆点
//     （inline style，零 CSS 注入，深浅主题自动跟随）。
//
// 响应式：模块级 store（map + version + listeners）+ useWorkspacePinVersion
// hook 订阅版本号；SessionTree 把版本号塞进 groups useMemo 的 deps ——
// 切换置顶即时重排，无需整页刷新。
//
// 补丁顺序依赖：锚点基于已应用 open-project-dir（order 200）后的文本
// （菜单数组含 open-folder 项）；本补丁 order 210 在其后执行。两者锚点
// 互不重叠：open-project-dir 动 guard 行与 delete 项后的追加，本补丁动
// rename 项前的插入与 onSelect 回调头部。
//
// 用法：
//   node scripts/patch-workspace-pin.js [<node_modules 根目录>]
// 同时导出 patchWorkspacePin(nmRoot, log) 供 boot 补丁链与打包复用。

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./lib/patch-io');

const MARKER = 'dsh-desktop patch (workspace pin)';

// ---------------------------------------------------------------------------
// 核心 store + 排序逻辑（注入 bundle 的原文；单测直接 eval 本常量验行为，
// 保证「测试验的」与「注入跑的」是同一份代码）。
// ---------------------------------------------------------------------------
const CORE = [
	'// dsh-desktop patch (workspace pin): 工作区置顶 store —— localStorage 持久化',
	'// （键 dsh-desktop.workspace-pins.v1，值 { [workspaceId]: pinMillis }），版本号',
	'// 通知重渲染；置顶行按 pinMillis 降序排最前（最近置顶最上），可多个并存，',
	'// 未置顶区保持宿主原序（手动排序/拖拽不受影响）。未分组桶无 workspaceId，',
	'// 永不参与。损坏/缺位的 localStorage 内容整体忽略（容错优先）。',
	'const DSH_WS_PINS_KEY = "dsh-desktop.workspace-pins.v1";',
	'const dshWorkspacePins = { map: {}, version: 0, listeners: /* @__PURE__ */ new Set() };',
	'try {',
	'	const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(DSH_WS_PINS_KEY);',
	'	if (raw) {',
	'		const parsed = JSON.parse(raw);',
	'		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {',
	'			for (const [k, v] of Object.entries(parsed)) if (typeof v === "number") dshWorkspacePins.map[k] = v;',
	'		}',
	'	}',
	'} catch {}',
	'function dshWorkspacePinState(id) {',
	'	return id !== void 0 && Object.prototype.hasOwnProperty.call(dshWorkspacePins.map, id);',
	'}',
	'function dshToggleWorkspacePin(id) {',
	'	if (id === void 0) return;',
	'	if (Object.prototype.hasOwnProperty.call(dshWorkspacePins.map, id)) delete dshWorkspacePins.map[id];',
	'	else {',
	'		// 同毫秒连点：新 pin 时间戳保证严格大于既有全部（最近置顶恒最上，',
	'		// 排序确定性；与真实时间至多差几个 ms，语义不变）。',
	'		let next = Date.now();',
	'		for (const v of Object.values(dshWorkspacePins.map)) if (v >= next) next = v + 1;',
	'		dshWorkspacePins.map[id] = next;',
	'	}',
	'	try { localStorage.setItem(DSH_WS_PINS_KEY, JSON.stringify(dshWorkspacePins.map)); } catch {}',
	'	dshWorkspacePins.version += 1;',
	'	for (const fn of dshWorkspacePins.listeners) {',
	'		try { fn(); } catch {}',
	'	}',
	'}',
	'function dshUseWorkspacePinVersion() {',
	'	const [v, setV] = (0, react.useState)(dshWorkspacePins.version);',
	'	(0, react.useEffect)(() => {',
	'		const fn = () => setV(dshWorkspacePins.version);',
	'		dshWorkspacePins.listeners.add(fn);',
	'		return () => { dshWorkspacePins.listeners.delete(fn); };',
	'	}, []);',
	'	return v;',
	'}',
	'function dshApplyWorkspacePins(groups) {',
	'	let hasPinned = false;',
	'	for (const g of groups) {',
	'		if (g.workspaceId !== void 0 && Object.prototype.hasOwnProperty.call(dshWorkspacePins.map, g.workspaceId)) { hasPinned = true; break; }',
	'	}',
	'	if (!hasPinned) return groups;',
	'	const pinned = [], rest = [];',
	'	for (const g of groups) {',
	'		if (g.workspaceId !== void 0 && Object.prototype.hasOwnProperty.call(dshWorkspacePins.map, g.workspaceId)) pinned.push(g);',
	'		else rest.push(g);',
	'	}',
	'	pinned.sort((a, b) => dshWorkspacePins.map[b.workspaceId] - dshWorkspacePins.map[a.workspaceId]);',
	'	return [...pinned, ...rest];',
	'}',
].join('\n');

// ---------------------------------------------------------------------------
// dsh-client-ui-workspace/lib/client.js 的外科手术点
// ---------------------------------------------------------------------------

// 1a. store + 排序逻辑注入（ProjectRowItem 签名前，模块工厂作用域内）。
const UI_CORE_ANCHOR = '		function ProjectRowItem({ group, onToggle, onCreate, actions, drag, home, t }) {';
const UI_CORE_INSERT = CORE + '\n' + UI_CORE_ANCHOR;

// 1b. 项目行 hooks 区：订阅版本号 + 读取置顶态（无条件 hook，Rules of Hooks 安全）。
const UI_HOOKS_ANCHOR = [
	'			const [menuOpen, setMenuOpen] = (0, react.useState)(false);',
	'			const [menuRect, setMenuRect] = (0, react.useState)(null);',
	'			const workspaceMenuItems = [{',
].join('\n');
const UI_HOOKS_INSERT = [
	'			const [menuOpen, setMenuOpen] = (0, react.useState)(false);',
	'			const [menuRect, setMenuRect] = (0, react.useState)(null);',
	'			// dsh-desktop patch (workspace pin): 订阅版本号驱动重渲染 + 读取置顶态。',
	'			dshUseWorkspacePinVersion();',
	'			const dshPinned = dshWorkspacePinState(row.workspaceId);',
	'			const workspaceMenuItems = [{',
].join('\n');

// 1c. 菜单项：rename 之前插入 pin 项（未分组桶无 workspaceId 不显示；icon 缺席
//     有先例——会话行 delete 项同样无 icon，Menu 的 entry.icon 可选）。
const UI_ITEMS_ANCHOR = [
	'			const workspaceMenuItems = [{',
	'				id: "rename",',
].join('\n');
const UI_ITEMS_INSERT = [
	'			const workspaceMenuItems = [{',
	'				// dsh-desktop patch (workspace pin): 置顶/取消置顶（仅工作区分组行显示）。',
	'				...(row.workspaceId !== void 0 ? [{',
	'					id: "pin",',
	'					label: dshPinned ? t("workspace.unpin") : t("workspace.pin")',
	'				}] : []),',
	'				id: "rename",',
].join('\n');

// 1d. onSelect：pin 分支放在 open-project-dir 的 id guard 之前（互不触碰）。
const UI_SELECT_ANCHOR = [
	'							onSelect: (id) => {',
	'								setMenuOpen(false);',
].join('\n');
const UI_SELECT_INSERT = [
	'							onSelect: (id) => {',
	'								setMenuOpen(false);',
	'								// dsh-desktop patch (workspace pin): 置顶切换（先于 id guard 返回）。',
	'								if (id === "pin") { dshToggleWorkspacePin(row.workspaceId); return; }',
].join('\n');

// 1e. folder 图标：置顶时着主题色（与 folderActive 同色系；active 另有行背景）。
const UI_FOLDER_ANCHOR = [
	'					(0, react_jsx_runtime.jsx)("span", {',
	'						className: clsx(Rows_module_css_default.slot, Rows_module_css_default.folder, active && Rows_module_css_default.folderActive),',
	'						children: row.expanded ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderClose16, {})',
].join('\n');
const UI_FOLDER_INSERT = [
	'					(0, react_jsx_runtime.jsx)("span", {',
	'						className: clsx(Rows_module_css_default.slot, Rows_module_css_default.folder, active && Rows_module_css_default.folderActive),',
	'						style: dshPinned ? { color: "var(--dsw-alias-state-business-primary)" } : void 0,',
	'						children: row.expanded ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderClose16, {})',
].join('\n');

// 1f. 标题前置顶小圆点（inline style，零 CSS 注入；title 是 ellipsis 行内容器）。
const UI_TITLE_ANCHOR = [
	'					(0, react_jsx_runtime.jsx)("span", {',
	'						className: Rows_module_css_default.projectText,',
	'						children: (0, react_jsx_runtime.jsx)("span", {',
	'							className: Rows_module_css_default.title,',
	'							children: label',
	'						})',
	'					}),',
].join('\n');
const UI_TITLE_INSERT = [
	'					(0, react_jsx_runtime.jsxs)("span", {',
	'						className: Rows_module_css_default.projectText,',
	'						children: [(0, react_jsx_runtime.jsxs)("span", {',
	'							className: Rows_module_css_default.title,',
	'							children: [dshPinned && (0, react_jsx_runtime.jsx)("span", {',
	'								// dsh-desktop patch (workspace pin): 置顶标记（主题色小圆点）。',
	'								style: { flex: "none", display: "inline-block", width: "5px", height: "5px", borderRadius: "50%", background: "var(--dsw-alias-state-business-primary)", margin: "0 4px 0 0", verticalAlign: "middle" },',
	'								"aria-hidden": true',
	'							}), label]',
	'						})]',
	'					}),',
].join('\n');

// 2a. deriveGroups 尾：分组产出经置顶重排（带后文锚，区分 groupByWorkspace 的同名 return）。
const UI_SORT_ANCHOR = [
	'			return groups;',
	'		}',
	'		/**',
	'		* Derive the flat session list',
].join('\n');
const UI_SORT_INSERT = [
	'			// dsh-desktop patch (workspace pin): 置顶分组压顶（pinMillis 降序），其余保原序。',
	'			return dshApplyWorkspacePins(groups);',
	'		}',
	'		/**',
	'		* Derive the flat session list',
].join('\n');

// 2b. SessionTree：版本号进作用域（两组行联合锚——useSessions 单行出现 3 次）。
const UI_TREE_ANCHOR = [
	'			const list = useSessions((s) => s);',
	'			const pendingInteractions = useSessionPendingInteraction((s) => s);',
].join('\n');
const UI_TREE_INSERT = [
	'			const list = useSessions((s) => s);',
	'			const pendingInteractions = useSessionPendingInteraction((s) => s);',
	'			// dsh-desktop patch (workspace pin): 版本号进 groups useMemo deps，切置顶即时重排。',
	'			const dshWsPinVersion = dshUseWorkspacePinVersion();',
].join('\n');

// 2c. groups useMemo deps：追加版本号（唯一锚；否则置顶切换被 memo 缓存吞掉）。
const UI_DEPS_ANCHOR = [
	'			}), [',
	'				list,',
	'				orderedWorkspaces,',
	'				archivedSessionIds,',
	'				pendingInteractions,',
	'				expandedGroups,',
	'				sessionOrderByAccount',
	'			]);',
].join('\n');
const UI_DEPS_INSERT = [
	'			}), [',
	'				list,',
	'				orderedWorkspaces,',
	'				archivedSessionIds,',
	'				pendingInteractions,',
	'				expandedGroups,',
	'				sessionOrderByAccount,',
	'				dshWsPinVersion',
	'			]);',
].join('\n');

// 3. 翻译：zh / en（与 menu.openProjectDir 同一字典段追加）。
const UI_ZH_ANCHOR = '			"menu.openProjectDir": "打开项目目录",';
const UI_ZH_INSERT = [
	'			"menu.openProjectDir": "打开项目目录",',
	'			"workspace.pin": "置顶到列表顶部",',
	'			"workspace.unpin": "取消置顶",',
].join('\n');
const UI_EN_ANCHOR = '			"menu.openProjectDir": "Open project directory",';
const UI_EN_INSERT = [
	'			"menu.openProjectDir": "Open project directory",',
	'			"workspace.pin": "Pin to top",',
	'			"workspace.unpin": "Unpin",',
].join('\n');

const UI_REPLACEMENTS = [
	{ anchor: UI_CORE_ANCHOR, insert: UI_CORE_INSERT },
	{ anchor: UI_HOOKS_ANCHOR, insert: UI_HOOKS_INSERT },
	{ anchor: UI_ITEMS_ANCHOR, insert: UI_ITEMS_INSERT },
	{ anchor: UI_SELECT_ANCHOR, insert: UI_SELECT_INSERT },
	{ anchor: UI_FOLDER_ANCHOR, insert: UI_FOLDER_INSERT },
	{ anchor: UI_TITLE_ANCHOR, insert: UI_TITLE_INSERT },
	{ anchor: UI_SORT_ANCHOR, insert: UI_SORT_INSERT },
	{ anchor: UI_TREE_ANCHOR, insert: UI_TREE_INSERT },
	{ anchor: UI_DEPS_ANCHOR, insert: UI_DEPS_INSERT },
	{ anchor: UI_ZH_ANCHOR, insert: UI_ZH_INSERT },
	{ anchor: UI_EN_ANCHOR, insert: UI_EN_INSERT },
];

// ---------------------------------------------------------------------------
// 工具：锚点必须存在 + 标记幂等的替换（与 patch-open-project-dir 同款契约）
// ---------------------------------------------------------------------------
function applyReplacements(file, replacements, log, stats, options) {
	let src;
	try {
		src = fs.readFileSync(file, 'utf8');
	} catch (err) {
		log('workspace-pin 补丁: 读取失败 ' + file + ': ' + err.message);
		return false;
	}
	if (src.includes(MARKER)) {
		log('workspace-pin 补丁: 已应用，跳过 ' + file);
		return false;
	}
	for (const { anchor, insert } of replacements) {
		if (!src.includes(anchor)) {
			log('workspace-pin 补丁: 锚点未匹配（dsh 版本可能已变化），跳过 ' + file + ' :: ' + anchor.slice(0, 60));
			if (stats) stats.anchorMissing += 1;
			return false;
		}
		src = src.replace(anchor, insert);
	}
	src = '// ' + MARKER + ': 侧栏工作区置顶（多选、localStorage 持久化）\n' + src;
	try {
		if (options && options.dryRun) {
			log('workspace-pin 补丁: dry-run: 将应用 ' + file);
			return false;
		}
		writeFileAtomic(file, src);
		log('workspace-pin 补丁: 已应用 ' + file);
		return true;
	} catch (err) {
		log('workspace-pin 补丁: 写入失败 ' + file + ': ' + err.message);
		return false;
	}
}

/**
 * 对某个 node_modules 根目录应用「工作区置顶」补丁（幂等）。
 * @param {string} nmRoot node_modules 根目录
 * @param {(msg: string) => void} [log]
 * @returns {number} 实际发生修改的文件数
 */
function patchWorkspacePin(nmRoot, log = () => {}, stats, options) {
	const targets = [
		{
			file: path.join(nmRoot, '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js'),
			replacements: UI_REPLACEMENTS,
		},
	];
	let changed = 0;
	for (const t of targets) {
		if (!fs.existsSync(t.file)) continue;
		if (applyReplacements(t.file, t.replacements, log, stats, options)) changed += 1;
	}
	return changed;
}

/** 测试用：构造一份包含全部 UI 锚点的最小夹具（unit-workspace-pin.test.js 使用）。 */
function buildUiFixture() {
	return UI_REPLACEMENTS.map((r) => r.anchor).join('\n// ---- 夹具分隔 ----\n') + '\n';
}

module.exports = { patchWorkspacePin, MARKER, buildUiFixture, CORE, UI_REPLACEMENTS };

if (require.main === module) {
	const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'node_modules');
	const n = patchWorkspacePin(root, (m) => console.log(m));
	console.log(n > 0 ? `patched ${n} file(s) — restart DSH Desktop to pick it up` : 'nothing to patch (already up to date)');
}
