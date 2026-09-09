'use strict';

// ---------------------------------------------------------------------------
// patch reasoning-row-collapse-width 补丁单元测试（node --test）。
//
// 「思考」行折叠态空白（0.6.3 第一案）的修复验证：
//   · pristine 层：vendored tarball 真实字节里 contain:size layout 全文件唯一、
//     折叠态选择器形态与锚一致；
//   · transform 层：changed 产物去 size 留 layout、marker 在位、height calc
//     原样保留（折叠高度不丢）；二遍 already；锚变异/空输入 → anchor-missing
//     不抛；产物 CSS 注释配对、node --check 语法合法；
//   · dev 树层：appDir 靶字节已收口（marker 在位、旧串零残留）。
//
// 运行：node --test scripts/test/unit-patch-reasoning-row-collapse-width.test.js
// ---------------------------------------------------------------------------

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  REASONING_ROW_COLLAPSE_MARKER,
  REASONING_ROW_COLLAPSE_FROM,
  transformReasoningRowCollapseWidth,
} = require('../lib/patch-adapters');
const { kernel } = require('../compat/kernel-pin.json');

// pristine 源：vendored tarball 解包（dev 树已被 patch-deps 打过，幂等判定统一
// 在 pristine 上做——与 unit-patch-model-image-input 同口径）。
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CHAT_VENDOR_TARBALL = path.join(
  REPO_ROOT, 'dsh-desktop', 'vendor', 'dsh-kernel',
  `deepseek-ai-dsh-client-ui-chat-${kernel.packageVersion}.tgz`,
);
const CHAT_FILE = extractPristineChat();

/** 把 vendored tarball 解到一次性目录，返回 pristine client.js 路径。 */
function extractPristineChat() {
  assert.ok(fs.existsSync(CHAT_VENDOR_TARBALL), '缺 vendored tarball: ' + CHAT_VENDOR_TARBALL);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rrcw-pristine-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // win32 显式用系统自带 bsdtar（Git Bash 的 GNU tar 会把 "C:\" 当远程主机）。
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const res = spawnSync(tarBin, ['-xzf', CHAT_VENDOR_TARBALL, '-C', dir], { encoding: 'utf8' });
  assert.equal(res.status, 0, 'tar 解包失败: ' + (res.stderr || ''));
  return path.join(dir, 'package', 'lib', 'client.js');
}

function readPristine() {
  assert.ok(fs.existsSync(CHAT_FILE), '缺 dsh-client-ui-chat/lib/client.js（vendor tarball）');
  return fs.readFileSync(CHAT_FILE, 'utf8');
}

test('pristine 锚点唯一性：contain:size layout 全文件一次且在折叠态选择器里', () => {
  const src = readPristine();
  const hits = src.split('contain:size layout').length - 1;
  assert.equal(hits, 1, `contain:size layout 应全文件唯一（实际 ${hits} 次）`);
  assert.ok(src.includes(REASONING_ROW_COLLAPSE_FROM), '折叠态锚点串应在 pristine 在场');
  assert.ok(src.includes('.t2QtNG_root:not([data-expanded])'), '折叠态选择器（哈希类）应在场');
});

test('transform：changed 产物去 size 留 layout、marker 在位、折叠高度保留', () => {
  const src = readPristine();
  const r = transformReasoningRowCollapseWidth(src, 'chat/client.js');
  assert.equal(r.status, 'changed');
  assert.ok(r.src.includes(REASONING_ROW_COLLAPSE_MARKER), '产物应有 marker（幂等依据）');
  assert.equal(r.src.split('contain:size layout').length - 1, 0, 'size containment 应零残留');
  assert.ok(r.src.includes('contain:layout;'), '应保留 layout containment');
  assert.ok(
    r.src.includes('{contain:layout;/* dsh-desktop fix: reasoning row collapse width (contain:size removed) */height:calc(24px + var(--dsh-content-font-delta,0px))}'),
    '折叠高度 calc 应原样保留（去 size 不动 height；marker 注释插在声明之间）',
  );
});

test('幂等：changed 产物二遍 → already', () => {
  const src = readPristine();
  const once = transformReasoningRowCollapseWidth(src, 'chat/client.js');
  assert.equal(once.status, 'changed');
  const twice = transformReasoningRowCollapseWidth(once.src, 'chat/client.js');
  assert.equal(twice.status, 'already');
});

test('锚变异（上游换写法）→ anchor-missing 不落半成品', () => {
  const src = readPristine().replace('contain:size layout', 'contain:strict size');
  const r = transformReasoningRowCollapseWidth(src, 'chat/client.js');
  assert.equal(r.status, 'anchor-missing');
  assert.ok(!r.src, '失配不得返回 src');
});

test('脏输入（空串 / 无 CSS 的 JS）→ anchor-missing 不抛', () => {
  assert.equal(transformReasoningRowCollapseWidth('', 'a.js').status, 'anchor-missing');
  assert.equal(
    transformReasoningRowCollapseWidth('module.exports = 1;', 'a.js').status,
    'anchor-missing',
  );
});

test('产物 CSS 注释配对（marker 注释不破坏样式串）', () => {
  const src = readPristine();
  const r = transformReasoningRowCollapseWidth(src, 'chat/client.js');
  assert.equal(r.status, 'changed');
  const open = r.src.split('/*').length - 1;
  const close = r.src.split('*/').length - 1;
  assert.equal(open, close, `CSS 注释应配对（open=${open} close=${close}）`);
});

test('产物 node --check 语法合法', () => {
  const src = readPristine();
  const r = transformReasoningRowCollapseWidth(src, 'chat/client.js');
  assert.equal(r.status, 'changed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rrcw-out-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'client.js');
  fs.writeFileSync(out, r.src, 'utf8');
  const res = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
  assert.equal(res.status, 0, '产物语法应合法: ' + (res.stderr || ''));
});

test('dev 树收口：appDir 靶字节已应用本补丁（marker 在位、旧串零残留）', () => {
  const devTarget = path.join(REPO_ROOT, 'dsh-desktop', 'node_modules',
    '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js');
  assert.ok(fs.existsSync(devTarget), '缺 dev 靶: ' + devTarget);
  const src = fs.readFileSync(devTarget, 'utf8');
  assert.ok(src.includes(REASONING_ROW_COLLAPSE_MARKER), 'dev 靶应有 marker（patch-deps 收口）');
  assert.equal(src.split('contain:size layout').length - 1, 0, 'dev 靶 size containment 应零残留');
});
