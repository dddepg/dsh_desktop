window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-gitgraph",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		const LANE_COLORS = ["#5b8def", "#e06c75", "#98c379", "#e5c07b", "#c678dd", "#56b6c2", "#d19a66", "#61afef"];
		const laneColor = (lane) => LANE_COLORS[((lane % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];
		const REF_COLORS = { head: "#4ec97c", branch: "#61afef", remote: "#c678dd", tag: "#e5c07b" };

		const CSS = [
			".dsh-gitgraph-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#16161a);color:var(--dsw-alias-label-primary,#d4d4d4);font-size:12px;box-sizing:border-box}",
			".dsh-gitgraph-toolbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#2b2b31);flex:none;overflow-x:auto}",
			".dsh-gitgraph-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,#33333b);background:var(--dsw-alias-bg-layer-1,#1c1c22);color:var(--dsw-alias-label-secondary,#b8b8c0);border-radius:999px;padding:3px 10px;font-size:11px;cursor:pointer;white-space:nowrap;flex:none}",
			".dsh-gitgraph-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#26262c);color:var(--dsw-alias-label-primary,#e4e4e8)}",
			".dsh-gitgraph-btn-active{background:var(--dsw-alias-interactive-bg-active,#30303a);color:var(--dsw-alias-label-primary,#ffffff);border-color:var(--dsw-alias-brand-primary,#5b8def)}",
			".dsh-gitgraph-body{flex:1;min-height:0;overflow:auto;padding:6px 8px}",
			".dsh-gitgraph-hint{display:flex;align-items:center;justify-content:center;height:100%;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12px}",
			".dsh-gitgraph-error{display:flex;align-items:center;justify-content:center;height:100%;color:#ff8a8a;font-size:12px;white-space:pre-wrap}",
			".dsh-gitgraph-svg{display:block}"
		].join("");

		function ensureCss() {
			if (typeof document === "undefined") return;
			const tagId = "@deepseek-ai/dsh-gitgraph/client.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-gitgraph";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		function GitGraphView(props) {
			const sessionId = props.sessionId || "";
			const [cwd, setCwd] = react.useState("");
			const [repos, setRepos] = react.useState(null);
			const [selected, setSelected] = react.useState("outer");
			const [graph, setGraph] = react.useState(null);
			const [error, setError] = react.useState("");
			const [loading, setLoading] = react.useState(false);
			const [reload, setReload] = react.useState(0);

			react.useEffect(() => {
				let alive = true;
				setCwd("");
				setRepos(null);
				setGraph(null);
				setSelected("outer");
				setError("");
				if (!sessionId) {
					setError("没有活动会话");
					return;
				}
				fetch("/api/dsh-files/session-cwd?sessionId=" + encodeURIComponent(sessionId))
					.then((r) => r.json())
					.then((j) => {
						if (!alive) return;
						if (j && typeof j.cwd === "string" && j.cwd) setCwd(j.cwd);
						else setError("无法解析会话项目目录");
					})
					.catch(() => { if (alive) setError("会话目录查询失败"); });
				return () => { alive = false; };
			}, [sessionId]);

			react.useEffect(() => {
				if (!cwd) return;
				let alive = true;
				setLoading(true);
				setError("");
				fetch("/dsh-gitgraph/repos?cwd=" + encodeURIComponent(cwd))
					.then((r) => r.json())
					.then((j) => {
						if (!alive) return;
						if (j && Array.isArray(j.repos) && j.repos.length > 0) {
							const defaultId = j.repos.some((repo) => repo.id === j.defaultRepoId) ? j.defaultRepoId : j.repos[0].id;
							setRepos(j.repos);
							setSelected((prev) => j.repos.some((repo) => repo.id === prev) ? prev : defaultId);
						} else {
							setRepos(null);
							setGraph(null);
							setError((j && j.error) || "当前目录不在 git 仓库中");
						}
					})
					.catch((err) => { if (alive) setError((err && err.message) || String(err)); })
					.finally(() => { if (alive) setLoading(false); });
				return () => { alive = false; };
			}, [cwd, reload]);

			react.useEffect(() => {
				if (!cwd || !repos) return;
				const repo = repos.find((item) => item.id === selected);
				if (!repo) return;
				let alive = true;
				setLoading(true);
				setGraph(null);
				setError("");
				fetch("/dsh-gitgraph/graph?cwd=" + encodeURIComponent(repo.root) + "&max=120")
					.then((r) => r.json())
					.then((j) => {
						if (!alive) return;
						if (j && Array.isArray(j.commits)) setGraph(j);
						else setError((j && j.error) || "GitGraph 加载失败");
					})
					.catch((err) => { if (alive) setError((err && err.message) || String(err)); })
					.finally(() => { if (alive) setLoading(false); });
				return () => { alive = false; };
			}, [cwd, repos, selected, reload]);

			if (error && !graph && !repos) {
				return react.createElement("div", { className: "dsh-gitgraph-root" },
					react.createElement("div", { className: "dsh-gitgraph-error" }, error));
			}
			if (!repos || repos.length === 0) {
				return react.createElement("div", { className: "dsh-gitgraph-root" },
					react.createElement("div", { className: "dsh-gitgraph-hint" }, loading ? "正在发现仓库…" : "未找到 Git 仓库"));
			}

			const commits = graph && Array.isArray(graph.commits) ? graph.commits : [];
			const byHash = new Map(commits.map((c) => [c.hash, c]));
			const lanes = new Map(commits.map((c) => [c.hash, Number.isFinite(c.lane) ? c.lane : 0]));
			const maxLane = Math.max(0, ...Array.from(lanes.values()));
			const laneWidth = 16;
			const rowHeight = 26;
			const leftPad = 10;
			const topPad = 14;
			const dotRadius = 4;
			const labelX = leftPad + (maxLane + 1) * laneWidth + 6;
			const svgWidth = Math.max(420, labelX + 460);
			const svgHeight = topPad + commits.length * rowHeight + 8;
			const yOf = (i) => topPad + i * rowHeight + rowHeight / 2;

			return react.createElement("div", { className: "dsh-gitgraph-root" },
				react.createElement("div", { className: "dsh-gitgraph-toolbar" },
					repos.map((repo) => react.createElement("button", {
						key: repo.id,
						type: "button",
						className: "dsh-gitgraph-btn" + (repo.id === selected ? " dsh-gitgraph-btn-active" : ""),
						onClick: () => setSelected(repo.id)
					}, repo.name)),
					react.createElement("button", {
						type: "button",
						className: "dsh-gitgraph-btn",
						onClick: () => setReload((n) => n + 1)
					}, "刷新")),
				react.createElement("div", { className: "dsh-gitgraph-body" },
					loading && !graph ? react.createElement("div", { className: "dsh-gitgraph-hint" }, "加载中…") :
					error && !graph ? react.createElement("div", { className: "dsh-gitgraph-error" }, error) :
					commits.length === 0 ? react.createElement("div", { className: "dsh-gitgraph-hint" }, "没有提交") :
					react.createElement("svg", {
						className: "dsh-gitgraph-svg",
						width: svgWidth,
						height: svgHeight,
						viewBox: "0 0 " + svgWidth + " " + svgHeight
					},
						commits.map((commit, i) => {
							const lane = lanes.get(commit.hash) || 0;
							const x = leftPad + lane * laneWidth;
							const y = yOf(i);
							return commit.parents.map((parent) => {
								const target = byHash.get(parent);
								if (!target) return null;
								const ti = commits.indexOf(target);
								if (ti < 0) return null;
								const tl = lanes.get(parent) || 0;
								const tx = leftPad + tl * laneWidth;
								const ty = yOf(ti);
								const midY = (y + ty) / 2;
								const d = lane === tl
									? "M " + x + " " + y + " L " + tx + " " + ty
									: "M " + x + " " + y + " C " + x + " " + midY + ", " + tx + " " + midY + ", " + tx + " " + ty;
								return react.createElement("path", {
									key: commit.hash + ":" + parent,
									d,
									fill: "none",
									stroke: laneColor(lane),
									strokeWidth: 1.4,
									opacity: 0.75
								});
							});
						}),
						commits.map((commit, i) => {
							const lane = lanes.get(commit.hash) || 0;
							const x = leftPad + lane * laneWidth;
							const y = yOf(i);
							const color = laneColor(lane);
							return react.createElement("circle", {
								key: commit.hash,
								cx: x,
								cy: y,
								r: commit.parents.length > 1 ? dotRadius : dotRadius - 0.5,
								fill: commit.parents.length > 1 ? "#1a1a20" : color,
								stroke: color,
								strokeWidth: 1.5
							});
						}),
						commits.map((commit, i) => {
							const lane = lanes.get(commit.hash) || 0;
							const x = leftPad + lane * laneWidth;
							const y = yOf(i);
							const refs = commit.refs || [];
							const refText = refs.map((ref) => ref.kind === "head" ? "HEAD → " + ref.name : ref.name).join("  ");
							return react.createElement("text", {
								key: "label:" + commit.hash,
								x: labelX,
								y: y + 3,
								fontSize: 11,
								fill: refs.length > 0 ? (REF_COLORS[refs[0].kind] || "#c8c8d0") : "#9a9aa6"
							},
								refs.length > 0 ? react.createElement("tspan", { fill: REF_COLORS[refs[0].kind] || "#c8c8d0" }, refText + "  ") : null,
								react.createElement("tspan", { fill: "#9a9aa6" }, commit.subject.length > 80 ? commit.subject.slice(0, 80) + "…" : commit.subject));
						}))));
		}

		const inject = ["betterSidebar"];

		function apply(ctx) {
			ensureCss();
			ctx.effect(() => ctx.betterSidebar.registerTab({
				id: "dsh-gitgraph",
				title: () => "GitGraph",
				order: 25,
				single: true,
				component: ({ scope }) => react_jsx_runtime.jsx(GitGraphView, { sessionId: scope.sessionId })
			}), "dsh-gitgraph: register better-sidebar tab");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
