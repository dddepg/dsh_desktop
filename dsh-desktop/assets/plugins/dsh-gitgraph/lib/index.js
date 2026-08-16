import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

// DSH Desktop GitGraph（宿主侧）
//   GET /dsh-gitgraph/repos?cwd=<会话项目目录>  发现外层仓库与内层嵌套仓库
//   GET /dsh-gitgraph/graph?cwd=<仓库根>&max=120 返回 --all 提交图与引用装饰
//
// 内外双仓库：外层仓库跟踪全部文件，某个子目录同时是独立的 git 仓库。
// repos 接口返回外层根与所有内层根；客户端可在两者间一键切换查看。
// 仅回环访问；只调用系统 git CLI，绝不写入任何配置。

const execFileAsync = promisify(execFile);
const GIT = "git";

const MAX_COMMITS = 300;
const DEFAULT_COMMITS = 120;
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_DIRS = 5000;

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage",
  ".venv", "venv", ".idea", ".vscode", ".cache", ".next", ".dsh",
]);

function isLoopback(req) {
  const ra = req.socket && req.socket.remoteAddress;
  return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(data.length),
  });
  res.end(data);
}

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync(GIT, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function gitTopLevel(cwd) {
  try {
    return (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return "";
  }
}

function hasGitDir(dir) {
  try { return existsSync(path.join(dir, ".git")); } catch { return false; }
}

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function findInnerRepos(outer) {
  const roots = [];
  const seen = new Set([outer]);
  const queue = [{ dir: outer, depth: 0 }];
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_SCAN_DIRS) {
    const { dir, depth } = queue.shift();
    scanned += 1;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (seen.has(full)) continue;
      seen.add(full);
      if (hasGitDir(full)) {
        const top = await gitTopLevel(full);
        if (top && top !== outer && isWithin(outer, top) && !roots.includes(top)) {
          roots.push(top);
        }
        continue; // 内层仓库内部不再继续扫描
      }
      if (depth + 1 < MAX_SCAN_DEPTH) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return roots.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

async function discoverRepos(cwd) {
  const inner = await gitTopLevel(cwd);
  if (!inner) return null;
  let outer = inner;
  let probe = path.dirname(inner);
  while (probe && probe !== path.dirname(probe)) {
    if (hasGitDir(probe)) {
      const top = await gitTopLevel(probe);
      if (top) {
        outer = top;
        break;
      }
    }
    probe = path.dirname(probe);
  }
  const inners = [];
  if (inner !== outer) inners.push(inner);
  for (const repo of await findInnerRepos(outer)) {
    if (!inners.includes(repo)) inners.push(repo);
  }
  return { outer, inners };
}

function parseRefs(text) {
  if (!text) return [];
  const refs = [];
  for (const raw of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    let kind = "branch";
    let name = raw;
    if (raw.startsWith("HEAD -> ")) {
      kind = "head";
      name = raw.slice("HEAD -> ".length);
    } else if (raw.startsWith("tag: ")) {
      kind = "tag";
      name = raw.slice("tag: ".length);
    } else if (raw.startsWith("refs/remotes/")) {
      kind = "remote";
      name = raw.slice("refs/remotes/".length);
    } else if (raw.startsWith("refs/heads/")) {
      name = raw.slice("refs/heads/".length);
    }
    if (name) refs.push({ kind, name });
  }
  return refs;
}

async function graphData(cwd, max) {
  const root = await gitTopLevel(cwd);
  if (!root) throw new Error("not a git repository");
  const limit = Math.max(20, Math.min(MAX_COMMITS, Number.isFinite(max) ? max : DEFAULT_COMMITS));
  const out = await runGit(root, [
    "log", "--all", "--graph", "--no-color", "--date-order", "--date=iso-strict",
    "-n", String(limit),
    "--pretty=format:%x00%H%x00%P%x00%an%x00%ad%x00%D%x00%s",
  ]);
  const commits = out.split(/\r?\n/).filter(Boolean).map((line) => {
    // --graph 前缀是 git 原生的泳道图；第一个 \0 之前是 ASCII 图。
    const parts = line.split("\0");
    const graphPrefix = parts[0] || "";
    const lane = graphPrefix.indexOf("*");
    return {
      lane: lane < 0 ? 0 : lane,
      hash: parts[1] || "",
      parents: (parts[2] || "").split(" ").filter(Boolean),
      author: parts[3] || "",
      date: parts[4] || "",
      refs: parseRefs(parts[5] || ""),
      subject: parts[6] || "",
    };
  }).filter((c) => c.hash);
  return { root, commits };
}

function readCwd(req, res) {
  let url;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    sendJson(res, 400, { error: "bad request url" });
    return "";
  }
  const cwd = (url.searchParams.get("cwd") || "").trim();
  if (!path.isAbsolute(cwd) || cwd.includes("\0")) {
    sendJson(res, 400, { error: "cwd must be an absolute path" });
    return "";
  }
  return cwd;
}

async function handleRepos(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  const cwd = readCwd(req, res);
  if (!cwd) return;
  try {
    const repos = await discoverRepos(cwd);
    if (!repos) {
      sendJson(res, 404, { error: "当前目录不在 git 仓库中" });
      return;
    }
    const all = [
      { id: "outer", root: repos.outer, name: "外层" },
      ...repos.inners.map((root, i) => ({
        id: `inner:${root}`,
        root,
        name: path.relative(repos.outer, root) || path.basename(root) || `内层 ${i + 1}`,
      })),
    ];
    sendJson(res, 200, { outer: repos.outer, repos: all });
  } catch (err) {
    sendJson(res, 500, { error: (err && err.message) || String(err) });
  }
}

async function handleGraph(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  const cwd = readCwd(req, res);
  if (!cwd) return;
  let max = Number.parseInt(new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("max") || "", 10);
  if (!Number.isFinite(max)) max = DEFAULT_COMMITS;
  try {
    const graph = await graphData(cwd, max);
    sendJson(res, 200, graph);
  } catch (err) {
    sendJson(res, 500, { error: (err && err.message) || String(err) });
  }
}

const name = "dsh-gitgraph";
const inject = ["webServer"];

function apply(ctx) {
  const disposers = [
    ctx.webServer.register({ kind: "exact", path: "/dsh-gitgraph/repos", handler: handleRepos }),
    ctx.webServer.register({ kind: "exact", path: "/dsh-gitgraph/graph", handler: handleGraph }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { apply, inject, name };
