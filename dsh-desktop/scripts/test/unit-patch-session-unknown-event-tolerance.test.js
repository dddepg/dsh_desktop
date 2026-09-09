'use strict';

// ---------------------------------------------------------------------------
// patch session-unknown-event-tolerance 补丁单元测试（node --test）。
//
// 「更新/降级后老对话整个打不开」的兜底验证（0.6.3 第二案）：
//   · pristine 层：vendored tarball 真实字节里 fail-closed 方法体唯一；
//   · transform 层：changed 产物未知事件改跳过 + [dsh-unknown-event-tolerance]
//     一次性告警、旧 throw 文案零残留；二遍 already；锚变异/空输入 →
//     anchor-missing 不抛；assertVersion 的格式版本 fail-closed 保留；产物
//     node --check 语法合法；
//   · 行为层：vm 实跑容忍版方法体——未知事件被收集、ignorable/已知类型被放行；
//   · dev 树层：appDir 靶字节已收口。
//
// 运行：node --test scripts/test/unit-patch-session-unknown-event-tolerance.test.js
// ---------------------------------------------------------------------------

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  SESSION_UNKNOWN_EVENT_TOLERANCE_MARKER,
  SESSION_UNKNOWN_EVENT_FROM,
  transformSessionUnknownEventTolerance,
} = require('../lib/patch-adapters');
const { kernel } = require('../compat/kernel-pin.json');

// pristine 源：vendored tarball 解包（dev 树已被 patch-deps 打过，幂等判定统一
// 在 pristine 上做——与 reasoning-row-collapse-width 同口径）。
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SP_VENDOR_TARBALL = path.join(
  REPO_ROOT, 'dsh-desktop', 'vendor', 'dsh-kernel',
  `deepseek-ai-dsh-session-persistence-${kernel.packageVersion}.tgz`,
);
const SP_FILE = extractPristinePersistence();

/** 把 vendored tarball 解到一次性目录，返回 pristine index.js 路径。 */
function extractPristinePersistence() {
  assert.ok(fs.existsSync(SP_VENDOR_TARBALL), '缺 vendored tarball: ' + SP_VENDOR_TARBALL);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-suet-pristine-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const res = spawnSync(tarBin, ['-xzf', SP_VENDOR_TARBALL, '-C', dir], { encoding: 'utf8' });
  assert.equal(res.status, 0, 'tar 解包失败: ' + (res.stderr || ''));
  return path.join(dir, 'package', 'lib', 'index.js');
}

function readPristine() {
  assert.ok(fs.existsSync(SP_FILE), '缺 dsh-session-persistence/lib/index.js（vendor tarball）');
  return fs.readFileSync(SP_FILE, 'utf8');
}

/** 从产物抽出容忍版方法体，套在最小宿主上实跑（行为验证）。 */
function runTolerated(events) {
  const src = readPristine();
  const r = transformSessionUnknownEventTolerance(src, 'persistence/index.js');
  assert.equal(r.status, 'changed');
  const sig = 'assertEventsSupported(meta, events) {';
  const start = r.src.indexOf(sig);
  assert.ok(start >= 0, '产物应含被替换的方法体签名');
  const end = r.src.indexOf(LF_MARK + '}', start);
  assert.ok(end > start, '产物应含方法闭合');
  // new Function 的函数体必须是纯语句序列：剥掉签名行与方法闭合行。
  const body = r.src.slice(start + sig.length + LF_MARK.length, end + 1);
  const warns = [];
  const host = {
    KNOWN_SESSION_EVENT_TYPES: new Set(['message added', 'session/created']),
    console: { warn: (m) => warns.push(m) },
    meta: { id: 'session-test' },
  };
  const fn = new Function('KNOWN_SESSION_EVENT_TYPES', 'console', 'meta', 'events', body);
  fn.call(host, host.KNOWN_SESSION_EVENT_TYPES, host.console, host.meta, events);
  return { warns, body };
}
const LF_MARK = String.fromCharCode(10) + String.fromCharCode(9); // 方法体切片用换行+tab 锚

test('pristine 锚点唯一性：fail-closed 方法体全文件一次', () => {
  const src = readPristine();
  const hits = src.split('assertEventsSupported(meta, events) {').length - 1;
  assert.equal(hits, 1, `方法签名应全文件唯一（实际 ${hits} 次）`);
  assert.ok(src.includes(SESSION_UNKNOWN_EVENT_FROM), 'fail-closed 循环锚应在 pristine 在场');
});

test('transform：changed 产物未知事件改跳过、旧 throw 文案零残留、告警前缀在位', () => {
  const src = readPristine();
  const r = transformSessionUnknownEventTolerance(src, 'persistence/index.js');
  assert.equal(r.status, 'changed');
  assert.ok(r.src.includes(SESSION_UNKNOWN_EVENT_TOLERANCE_MARKER), '产物应有 marker（幂等依据）');
  assert.ok(r.src.includes('[dsh-unknown-event-tolerance]'), '应带固定前缀告警');
  assert.ok(!r.src.includes('refusing to interpret the log'), '旧 fail-closed 文案应零残留');
  assert.ok(r.src.includes('dshUnknown.push'), '未知事件应被收集（跳过语义）');
});

test('幂等：changed 产物二遍 → already', () => {
  const src = readPristine();
  const once = transformSessionUnknownEventTolerance(src, 'persistence/index.js');
  assert.equal(once.status, 'changed');
  const twice = transformSessionUnknownEventTolerance(once.src, 'persistence/index.js');
  assert.equal(twice.status, 'already');
});

test('锚变异（上游改判定）→ anchor-missing 不落半成品', () => {
  const src = readPristine().replace('refusing to interpret the log', 'refusing to interpret the logs');
  const r = transformSessionUnknownEventTolerance(src, 'persistence/index.js');
  assert.equal(r.status, 'anchor-missing');
  assert.ok(!r.src, '失配不得返回 src');
});

test('脏输入（空串 / 无关 JS）→ anchor-missing 不抛', () => {
  assert.equal(transformSessionUnknownEventTolerance('', 'a.js').status, 'anchor-missing');
  assert.equal(
    transformSessionUnknownEventTolerance('module.exports = 1;', 'a.js').status,
    'anchor-missing',
  );
});

test('行为：未知事件跳过 + ignorable/已知类型放行 + 告警含类型与 seq', () => {
  const { warns } = runTolerated([
    { type: 'session/created', seq: 1 },
    { type: 'slice/digest', seq: 387 },
    { type: 'message added', seq: 388, ignorable: true },
    { type: 'future/thing', seq: 400 },
  ]);
  assert.equal(warns.length, 1, '告警应一次性（全循环只 warn 一条）');
  assert.ok(warns[0].includes('[dsh-unknown-event-tolerance]'), '告警应带固定前缀');
  assert.ok(warns[0].includes('slice/digest@387'), '告警应列未知类型@seq');
  assert.ok(warns[0].includes('future/thing@400'), '第二个未知类型也应列出');
  assert.ok(!warns[0].includes('message added'), 'ignorable 事件不算未知');
});

test('行为：全部已知 → 零告警', () => {
  const { warns } = runTolerated([{ type: 'message added', seq: 1 }]);
  assert.equal(warns.length, 0, '无未知事件不得告警');
});

test('产物 assertVersion 的 fail-closed 保留（格式版本不兼容仍拒载）', () => {
  const src = readPristine();
  const r = transformSessionUnknownEventTolerance(src, 'persistence/index.js');
  assert.equal(r.status, 'changed');
  assert.ok(
    r.src.includes('if (meta.version === SESSION_FORMAT_VERSION) return;') &&
    r.src.includes('sessionFormatVersionRefusal(meta.id, meta.version)'),
    'assertVersion 版本拒绝链不得被波及',
  );
});

test('产物 node --check 语法合法', () => {
  const src = readPristine();
  const r = transformSessionUnknownEventTolerance(src, 'persistence/index.js');
  assert.equal(r.status, 'changed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-suet-out-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'index.js');
  fs.writeFileSync(out, r.src, 'utf8');
  const res = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
  assert.equal(res.status, 0, '产物语法应合法: ' + (res.stderr || ''));
});

test('dev 树收口：appDir 靶字节已应用本补丁（marker 在位、旧文案零残留）', () => {
  const devTarget = path.join(REPO_ROOT, 'dsh-desktop', 'node_modules',
    '@deepseek-ai', 'dsh-session-persistence', 'lib', 'index.js');
  assert.ok(fs.existsSync(devTarget), '缺 dev 靶: ' + devTarget);
  const src = fs.readFileSync(devTarget, 'utf8');
  assert.ok(src.includes(SESSION_UNKNOWN_EVENT_TOLERANCE_MARKER), 'dev 靶应有 marker（patch-deps 收口）');
  assert.ok(!src.includes('refusing to interpret the log'), 'dev 靶旧 fail-closed 文案应零残留');
});
