'use strict';

// 工作区置顶补丁（workspace-pin）单测。
//
// 覆盖三层：
//   1. 锚点/幂等契约：夹具（buildUiFixture）应用 → changed=1 + marker 落盘 +
//      产物 node --check 语法过；二遍 changed=0；锚点缺失时跳过不落盘；
//   2. 核心行为（CORE 直接 eval —— 测试验的与注入 bundle 跑的是同一份代码）：
//      置顶切换 / 多选降序压顶 / 未分组不参与 / 未置顶保原序 / localStorage
//      持久化与损坏容错 / 版本号通知；
//   3. 真实 vendored 产物锚点命中（只读）：现场（已打 open-project-dir）的
//      dsh-client-ui-workspace/lib/client.js 必须包含全部锚点——内核升级导致
//      形态漂移时，此处先于 boot 链报出来。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const { patchWorkspacePin, MARKER, buildUiFixture, CORE, UI_REPLACEMENTS } = require('../patch-workspace-pin');

// 真实 vendored 产物（只读哨兵与语法验证基底；提前定义供下方注册期求值）。
const VENDORED = path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js');

// ---------------------------------------------------------------------------
// 1. 锚点/幂等契约
// ---------------------------------------------------------------------------

function makeSandbox(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-pin-'));
  const file = path.join(dir, '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildUiFixture(), 'utf8');
  return { dir, file };
}

test('夹具应用：changed=1、marker 落盘、菜单/排序/翻译注入齐', () => {
  const sb = makeSandbox();
  try {
    const logs = [];
    const n = patchWorkspacePin(sb.dir, (m) => logs.push(m));
    assert.equal(n, 1, '应修改 1 个文件');
    assert.equal(logs.filter((l) => l.includes('已应用')).length, 1);
    const out = fs.readFileSync(sb.file, 'utf8');
    assert.ok(out.includes(MARKER), 'marker 应落盘（幂等锚）');
    assert.ok(out.includes('dshToggleWorkspacePin'), 'store 应注入');
    assert.ok(out.includes('dshApplyWorkspacePins(groups)'), '分组排序应接线');
    assert.ok(out.includes('"workspace.pin"') && out.includes('"workspace.unpin"'), 'zh/en 翻译应注入');
    assert.ok(out.includes('dshWsPinVersion'), 'SessionTree 版本号应进作用域与 deps');
    // 注：夹具是锚点拼接（未闭合的字面量，open-project-dir 同款设计），不作
    // 语法检查——语法验证由下一测在真实 vendored 副本上做。
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('真实产物副本应用：注入后语法合法（vendored 现场基底）', { skip: !fs.existsSync(VENDORED) ? 'vendored dsh-client-ui-workspace 不在位' : false }, () => {
  const sb = makeSandbox();
  try {
    fs.copyFileSync(VENDORED, sb.file);
    const n = patchWorkspacePin(sb.dir, () => {});
    assert.ok(n === 0 || n === 1, '幂等或应用均合法（现场可能已打过）');
    const out = fs.readFileSync(sb.file, 'utf8');
    if (n === 1) {
      assert.ok(out.includes(MARKER) && out.includes('dshApplyWorkspacePins(groups)'), '应用后应含注入');
      const r = spawnSync(process.execPath, ['--check', sb.file], { encoding: 'utf8' });
      assert.equal(r.status, 0, `真实产物注入后语法必须合法: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('幂等：二遍 changed=0（marker 命中即跳过）', () => {
  const sb = makeSandbox();
  try {
    assert.equal(patchWorkspacePin(sb.dir, () => {}), 1);
    const logs = [];
    assert.equal(patchWorkspacePin(sb.dir, (m) => logs.push(m)), 0, '二遍不得再改');
    assert.ok(logs.some((l) => l.includes('已应用，跳过')), '应记录跳过日志');
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('锚点缺失：整文件跳过、绝不落盘半截', () => {
  const sb = makeSandbox();
  try {
    // 抽掉一个锚（排序锚的 "Derive the flat" 后文），applyReplacements 应在
    // 该锚前回滚（前面锚点的替换只发生在内存 src，未落盘）。
    let fixture = buildUiFixture();
    fixture = fixture.replace('* Derive the flat session list', '* GONE');
    fs.writeFileSync(sb.file, fixture, 'utf8');
    const stats = { anchorMissing: 0 };
    const n = patchWorkspacePin(sb.dir, () => {}, stats);
    assert.equal(n, 0, '不得计入 changed');
    assert.equal(stats.anchorMissing, 1, '锚点缺失应计数');
    assert.ok(!fs.readFileSync(sb.file, 'utf8').includes(MARKER), '失败路径不得落盘');
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. 核心行为（CORE 与注入同源）
// ---------------------------------------------------------------------------

/** 在隔离 vm 里跑 CORE 并返回 store API + mock 环境（K1 注入体同款验证法：
 *  CORE 是本仓常量而非不可信输入，vm 隔离只为干净作用域）。 */
function evalCore({ stored = null } = {}) {
  const writes = [];
  const sandbox = {
    react: {
      useState: (v) => [v, () => {}],
      useEffect: () => {},
    },
    localStorage: {
      getItem: () => stored,
      setItem: (k, v) => writes.push([k, v]),
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(CORE + '\n;this.__api = { dshWorkspacePins, dshWorkspacePinState, dshToggleWorkspacePin, dshApplyWorkspacePins };', ctx);
  return { ...sandbox.__api, writes };
}

test('置顶切换：pin → pinned，再 pin → 恢复，均通知版本号 + 持久化', () => {
  const c = evalCore();
  assert.equal(c.dshWorkspacePinState('ws-1'), false, '初始未置顶');
  c.dshToggleWorkspacePin('ws-1');
  assert.equal(c.dshWorkspacePinState('ws-1'), true);
  assert.equal(c.dshWorkspacePins.version, 1, '版本号 +1（重渲染信号）');
  assert.equal(c.writes.length, 1, '应写一次 localStorage');
  assert.deepEqual(JSON.parse(c.writes[0][1]), { 'ws-1': c.dshWorkspacePins.map['ws-1'] });
  c.dshToggleWorkspacePin('ws-1');
  assert.equal(c.dshWorkspacePinState('ws-1'), false, '再切取消置顶');
  assert.equal(c.dshWorkspacePins.version, 2);
  assert.deepEqual(JSON.parse(c.writes[1][1]), {}, '取消后持久化为空对象');
  c.dshToggleWorkspacePin(void 0);
  assert.equal(c.dshWorkspacePins.version, 2, '未分组（无 id）不动作');
});

test('排序：多选置顶按时间降序压顶，未置顶保原序，未分组不参与', () => {
  const c = evalCore();
  const g = (workspaceId, tag) => ({ workspaceId, key: workspaceId ?? '', tag });
  const groups = [g(void 0, 'ungrouped'), g('a', 'A'), g('b', 'B'), g('c', 'C'), g('d', 'D')];
  assert.deepEqual(c.dshApplyWorkspacePins(groups), groups, '无置顶时原样返回（同引用）');
  // Array.from 归一：CORE 在 vm 隔离 realm 里跑，跨 realm 数组的原型与
  // deepStrictEqual 的本 realm 原型不等（打印相同仍 fail）——转本 realm 再断。
  const tags = (out) => Array.from(out.map((x) => x.tag));
  // 先 pin b 再 pin a：b 时间早 → a 在 b 上方。
  c.dshToggleWorkspacePin('b');
  c.dshToggleWorkspacePin('a');
  assert.deepEqual(tags(c.dshApplyWorkspacePins(groups)), ['A', 'B', 'ungrouped', 'C', 'D'], '置顶压顶（最近置顶最上），未分组恒不置顶');
  c.dshToggleWorkspacePin('c');
  assert.deepEqual(tags(c.dshApplyWorkspacePins(groups)), ['C', 'A', 'B', 'ungrouped', 'D'], '第三个置顶排最上');
  c.dshToggleWorkspacePin('a');
  assert.deepEqual(tags(c.dshApplyWorkspacePins(groups)), ['C', 'B', 'ungrouped', 'A', 'D'], '取消 a 后剩余置顶仍压顶，A 回原位');
});

test('localStorage 损坏/畸形内容整体忽略（容错优先）', () => {
  for (const stored of ['{not json', '{"a": "not-number"}', 'null', '[1,2]']) {
    const c = evalCore({ stored });
    assert.equal(c.dshWorkspacePinState('a'), false, `畸形存储 ${stored} 不得注入状态`);
    assert.equal(Object.keys(c.dshWorkspacePins.map).length, 0);
  }
  const ok = evalCore({ stored: '{"a": 111, "b": 222}' });
  assert.equal(ok.dshWorkspacePinState('a'), true, '合法存储应恢复置顶态');
  assert.deepEqual(Array.from(ok.dshApplyWorkspacePins([{ workspaceId: 'b' }, { workspaceId: 'a' }]).map((x) => x.workspaceId)), ['b', 'a'], '恢复的 pinMillis 参与降序');
});

// ---------------------------------------------------------------------------
// 3. 真实 vendored 产物锚点命中（只读哨兵）
// ---------------------------------------------------------------------------

test('现场 vendored 产物：全部锚点在位（内核形态漂移先于此报出）', { skip: !fs.existsSync(VENDORED) ? 'vendored dsh-client-ui-workspace 不在位' : false }, () => {
  const src = fs.readFileSync(VENDORED, 'utf8');
  if (src.includes(MARKER)) {
    assert.ok(src.includes('dshApplyWorkspacePins(groups)'), '已打补丁的现场应含排序接线');
    return;
  }
  for (const { anchor } of UI_REPLACEMENTS) {
    assert.ok(src.includes(anchor), `锚点缺失（open-project-dir 是否已应用？）: ${anchor.split('\n')[0].slice(0, 70)}`);
  }
});
