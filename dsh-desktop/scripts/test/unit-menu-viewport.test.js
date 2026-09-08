'use strict';

// issue #36 + #182 补丁脚本单元测试（node --test）。
// 覆盖：一次应用、二次幂等、anchor 缺失跳过且字节级不损坏、非目标包跳过、
//       #182 横向兜底夹紧 + ResizeObserver 重定位、无 X 行旧形态跳过。
// 用法：node --test scripts/test/unit-menu-viewport.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { patchMenuViewport, MARKER } = require('../patch-menu-viewport');

function buildFakeTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-menu-vp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'index.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const src = [
    'import { jsx } from "react/jsx-runtime";',
    'const MEASURE_STYLE = { position: "fixed", left: -9999, top: -9999 };',
    'if (lw > 0) x = Math.min(Math.max(x, MARGIN), vw - lw - MARGIN);',
    '\t\tplace();',
    '\t\twindow.addEventListener("scroll", place, true);',
    '\t\twindow.addEventListener("resize", place);',
    'if (lh > 0) y = Math.min(Math.max(y, MARGIN), vh - lh - MARGIN);',
    'style: portal ? fixedPos ?? MEASURE_STYLE : void 0,',
    'export { Menu };',
  ].join('\n');
  fs.writeFileSync(file, src);
  return { root, file, src };
}

test('补丁脚本：一次应用、二次幂等、anchor 缺失跳过且不损坏', (t) => {
  const tree = buildFakeTree(t);
  // 第一次：应修改
  let n = patchMenuViewport(tree.root);
  assert.strictEqual(n, 1, '应补丁 1 个文件');
  const patched = fs.readFileSync(tree.file, 'utf8');
  assert.ok(patched.includes(MARKER), '应写入幂等标记');
  assert.ok(patched.includes('maxHeight: "min(calc(100vh - 24px), 560px)"'), '应写入视口封顶 maxHeight');
  assert.ok(patched.includes('overflowY: "auto"'), '应写入纵向滚动');
  assert.ok(patched.includes('Math.max(MARGIN, vh - Math.min(lh, vh - 2 * MARGIN) - MARGIN)'), 'y 夹紧应按封顶高度计算');
  assert.ok(patched.includes('dsh-desktop patch (issue #182)'), '应写入 #182 标记');
  assert.ok(patched.includes('else x = Math.min(Math.max(x, MARGIN), Math.max(MARGIN, vw - 2 * MARGIN));'), 'lw=0 时应按视口宽兜底夹紧');
  assert.ok(patched.includes('new ResizeObserver(() => place())'), '尺寸变化应重新 place');
  // 第二次：零写入且内容不变
  n = patchMenuViewport(tree.root);
  assert.strictEqual(n, 0, '第二次应零写入');
  assert.strictEqual(fs.readFileSync(tree.file, 'utf8'), patched, '内容不应变化');
  // anchor 缺失：跳过且字节级不损坏
  fs.writeFileSync(tree.file, 'export const changed = true;\n完全不同的内容\n');
  const before = fs.readFileSync(tree.file);
  n = patchMenuViewport(tree.root);
  assert.strictEqual(n, 0, 'anchor 不匹配应跳过');
  assert.deepStrictEqual(fs.readFileSync(tree.file), before, '文件字节级不变');
});

test('补丁脚本：无 X 夹紧行的旧形态目标 → #36/#182 各自独立幂等（#182 跳过不损坏）', (t) => {
  const tree = buildFakeTree(t);
  // 移除 X 行：模拟「#36 已应用、#182 锚缺失」的旧形态目标
  let src = fs.readFileSync(tree.file, 'utf8').split('\n').filter((l) => !l.includes('lw > 0')).join('\n');
  fs.writeFileSync(tree.file, src);
  const n1 = patchMenuViewport(tree.root);
  assert.strictEqual(n1, 0, '无 X 锚 → #182 段跳过（不修改）');
  assert.ok(!fs.readFileSync(tree.file, 'utf8').includes('issue #182'), '不得写入 #182 残留');
  const n2 = patchMenuViewport(tree.root);
  assert.strictEqual(n2, 0, '再跑仍跳过（幂等）');
});

test('补丁脚本：目标包缺失时返回 0 且不抛异常', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-menu-vp-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(patchMenuViewport(root), 0);
});
