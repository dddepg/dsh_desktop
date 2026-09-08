'use strict';
// better-sidebar editor「按变更查看 diff」测试：
// ① 引擎行为（从 dsh-client-file-changes 真源码抽取 splitLines/diffRows/diffStats
//    执行——保证与「文件」视图同一引擎语义）：三分类/成对 mod/ctx 上下文/空串边界/统计；
// ② 接线形态（better-sidebar client-editor 与 file-changes store 的关键锚点）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const FC_SRC = fs.readFileSync(path.join(REPO, 'assets', 'plugins', 'dsh-client-file-changes', 'lib', 'client.js'), 'utf8');
const CE_SRC = fs.readFileSync(path.join(REPO, 'assets', 'plugins', 'dsh-better-sidebar', 'lib', 'client-editor.js'), 'utf8');

/** 从源码中提取 `function NAME(...) {...}` 文本（花括号配平）。 */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '源码中应存在 function ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, k + 1); }
  }
  throw new Error('function ' + name + ' 花括号未配平');
}

const engineSrc = [
  extractFn(FC_SRC, 'splitLines'),
  extractFn(FC_SRC, 'diffRows'),
  extractFn(FC_SRC, 'diffStats'),
].join('\n');
const engine = new Function(engineSrc + '\nreturn { splitLines, diffRows, diffStats };')();

test('splitLines：空串与常规切分', () => {
  assert.deepStrictEqual(engine.splitLines(''), []);
  assert.deepStrictEqual(engine.splitLines(null), []);
  assert.deepStrictEqual(engine.splitLines('a\nb'), ['a', 'b']);
  assert.deepStrictEqual(engine.splitLines('a\nb\n'), ['a', 'b', '']);
});

test('diffRows：纯新增行（add 提示）', () => {
  const rows = engine.diffRows('a\nb', 'a\nb\nc\nd');
  const kinds = rows.filter((r) => r.kind !== 'ctx').map((r) => r.kind);
  assert.deepStrictEqual(kinds, ['add', 'add']);
  assert.ok(rows.some((r) => r.kind === 'add' && r.text === 'c'));
  assert.ok(rows.some((r) => r.kind === 'add' && r.text === 'd'));
});

test('diffRows：纯删除行（del 提示）', () => {
  const rows = engine.diffRows('a\nb\nc', 'a');
  const kinds = rows.filter((r) => r.kind !== 'ctx').map((r) => r.kind);
  assert.deepStrictEqual(kinds, ['del', 'del']);
});

test('diffRows：成对修改行（mod 成对、先旧后新）', () => {
  const rows = engine.diffRows('a\nold\nz', 'a\nnew\nz');
  const mods = rows.filter((r) => r.kind === 'mod');
  assert.strictEqual(mods.length, 2, '成对 mod 应各计一行');
  assert.strictEqual(mods[0].text, 'old', '先旧行');
  assert.strictEqual(mods[1].text, 'new', '后新行');
});

test('diffStats：统计与成对折算', () => {
  // 中段单行替换：old→new 成一对 mod（前后缀裁剪后 z/w 为上下文，不计入变更）
  const rows = engine.diffRows('k\nold\nz\nw', 'k\nnew\nz\nw');
  const st = engine.diffStats(rows);
  assert.strictEqual(st.mod, 1, '一对 mod');
  assert.strictEqual(st.add, 0, '无纯新增');
  assert.strictEqual(st.del, 0, '无纯删除');
  assert.strictEqual(st.added, 1, 'added = add + pairs');
  assert.strictEqual(st.removed, 1, 'removed = del + pairs');
  // 中段单行替换 + 尾部追加：mod 对 + 尾 add
  const rows2 = engine.diffRows('k\nold', 'k\nnew\nadded');
  const st2 = engine.diffStats(rows2);
  assert.strictEqual(st2.mod, 1, '一对 mod');
  assert.strictEqual(st2.add, 1, '一行 add');
  assert.strictEqual(st2.added, 2, 'added = add + pairs');
  assert.strictEqual(st2.removed, 1, 'removed = del + pairs');
});

test('接线形态：store API 与 editor 面板/工具条锚点全部在位', () => {
  // file-changes：store 挂载 queryFileChanges（供 better-sidebar 拉每条变更原文）
  assert.ok(FC_SRC.includes('queryFileChanges(sessionId, path) {'), 'store 应挂载 queryFileChanges');
  assert.ok(FC_SRC.includes('oldText: c.oldText, newText: c.newText, seq: c.seq, time: c.time'), '条目应含 op/oldText/newText/seq/time 全字段');
  // better-sidebar：引擎移植、面板组件、工具条钮、面板挂载
  assert.ok(CE_SRC.includes('function splitLines(text)'), '引擎 splitLines 已移植');
  assert.ok(CE_SRC.includes('function diffRows(oldText, newText)'), '引擎 diffRows 已移植');
  assert.ok(CE_SRC.includes('function diffStats(rows)'), '引擎 diffStats 已移植');
  assert.ok(CE_SRC.includes('function DiffTurnsPanel('), 'DiffTurnsPanel 组件在位');
  assert.ok(CE_SRC.includes('store.queryFileChanges(sessionId, path)'), '面板应经 queryFileChanges 取数');
  assert.ok(CE_SRC.includes('"按变更查看 diff"'), '面板标题/aria 在位');
  assert.ok(CE_SRC.includes('histOpen && hasDiff'), '面板挂载条件（开关 + 有改动）在位');
  assert.ok(CE_SRC.includes('"aria-pressed": histOpen'), '工具条「历史」钮按压态在位');
  assert.ok(CE_SRC.includes('dsh-eh-line dsh-eh-" + r.kind'), '行首提示符着色 class 在位');
});
