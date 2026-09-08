'use strict';
// unit-tool-name-mojibake —— 工具名归一化兜底补丁（v1 ¬ 噪音 / v2 点号形态）：
// 干净源双注入、v1 源升级补 v2、双 marker 幂等、注入代码运行行为（真执行）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformToolNameMojibake, patchToolNameMojibake, MARKER, MARKER_V2 } = require('../lib/tool-name-mojibake-patch');

/** 构造带 resolveExecution 的最小 dsh-tools 形态源（锚行与产物一致）。 */
function fakeToolsSrc() {
  return [
    'class Tools {',
    '\tget(name, scope) { return this.map.get(scope + "/" + name); }',
    '\tresolveExecution(name, scope, nested) {',
    '\t\tconst tool = this.get(name, scope);',
    '\t\tif (tool === void 0) throw new Error("unknown tool");',
    '\t\treturn tool;',
    '\t}',
    '}',
  ].join('\n');
}

test('干净源：一次注入 v1+v2 双块', () => {
  const r = transformToolNameMojibake(fakeToolsSrc(), 'fake');
  assert.equal(r.status, 'changed');
  assert.ok(r.src.includes(MARKER), 'v1 marker');
  assert.ok(r.src.includes(MARKER_V2), 'v2 marker');
  assert.ok(r.src.includes('name.includes(".")'), 'v2 点号条件在位');
});

test('v1 已应用源（beta.2/3 已分发状态）：升级只补 v2（hadV1 标记）', () => {
  const v1only = transformToolNameMojibake(fakeToolsSrc(), 'fake', { onlyV1: true });
  assert.ok(v1only.src.includes(MARKER) && !v1only.src.includes(MARKER_V2), 'v1-only 构造成立');
  const r = transformToolNameMojibake(v1only.src, 'fake');
  assert.equal(r.status, 'changed');
  assert.equal(r.hadV1, true);
  assert.equal(r.src.split(MARKER).length - 1, 1, 'v1 不重复');
  assert.ok(r.src.includes(MARKER_V2));
});

test('双 marker 源：幂等跳过', () => {
  const once = transformToolNameMojibake(fakeToolsSrc(), 'fake');
  const twice = transformToolNameMojibake(once.src, 'fake');
  assert.equal(twice.status, 'already');
});

/** 把注入后的源在 vm 里真执行：验证 unknown 形态被归一化重试命中。 */
function runResolve(injectedSrc, registeredName, queryName) {
  const context = vm.createContext({ console });
  const Tools = vm.runInContext(injectedSrc + '\nTools;', context);
  const tools = new Tools();
  tools.map = new Map([['default/' + registeredName, { name: registeredName }]]);
  let result;
  try {
    result = tools.resolveExecution(queryName, 'default', false);
  } catch (err) {
    return { thrown: err.message };
  }
  return { tool: result };
}

test('运行行为：点号形态 cardian.memory_get 命中注册名 cardian_memory_get', () => {
  const injected = transformToolNameMojibake(fakeToolsSrc(), 'fake').src;
  const r = runResolve(injected, 'cardian_memory_get', 'cardian.memory_get');
  assert.ok(r.tool, '点号形态应被重试命中（得到 ' + JSON.stringify(r) + '）');
  assert.equal(r.tool.name, 'cardian_memory_get');
});

test('运行行为：¬ 噪音形态（v1）与下划线正常名不受影响', () => {
  const injected = transformToolNameMojibake(fakeToolsSrc(), 'fake').src;
  const weird = runResolve(injected, 'cardian_wiki_upsert', 'cardian¬_¬wiki¬_¬upsert');
  assert.ok(weird.tool, '¬ 形态应命中');
  const normal = runResolve(injected, 'cardian_memory_get', 'cardian_memory_get');
  assert.equal(normal.tool.name, 'cardian_memory_get', '正常名首查即中（零额外重试）');
  const missing = runResolve(injected, 'totally_other_tool', 'cardian.memory_get');
  assert.ok(missing.thrown, '真不存在的工具仍抛错（报错语义不变）');
});

test('patchToolNameMojibake 端到端：真实文件应用 + 幂等二次为零', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mojibake-'));
  try {
    const pkgDir = path.join(dir, '@deepseek-ai', 'dsh-tools', 'lib');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'index.js'), fakeToolsSrc(), 'utf8');
    const n1 = patchToolNameMojibake(dir, () => {});
    assert.equal(n1, 1);
    const n2 = patchToolNameMojibake(dir, () => {});
    assert.equal(n2, 0, '二次幂等');
    const s = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8');
    assert.ok(s.includes(MARKER) && s.includes(MARKER_V2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
