'use strict';

// openclaw-bridge 设置注入回归（0.8.1）：
//   0.8.0 打包产物的 inject 数组遭截丢 "settings" —— ctx.settings 访问抛
//   "cannot get property 'settings' without inject"，设置页永久读不到/写不进
//   ClawBot 配置（两份用户日志实爆：rizhi + aoxuanheng 每轮启动都有
//   "[openclaw-bridge] settings section unavailable"）。
// 本测试锁两件事：
//   1. inject 数组含 "settings"（形态锚点，防再截丢）；
//   2. 两级 register 降级在场（旧格式存储解析不过时空 base 重试，热更链路
//      恢复而非永久降级为仅环境变量配置）。
// 源码仓（openclaw-dsh-bridge/lib/index.js）同步锁定——双轨修补两侧不得漂移。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BUNDLED = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-openclaw-bridge', 'lib', 'index.js');
const SOURCE = path.join(__dirname, '..', '..', '..', 'openclaw-dsh-bridge', 'lib', 'index.js');

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** 从模块源里抠 inject 数组字面量并解析为字符串数组。 */
function parseInject(src) {
  const m = /const inject\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('内置 0.8.x 产物：inject 必须声明 "settings"', () => {
  const src = readIfExists(BUNDLED);
  assert.ok(src, '内置产物应在位: ' + BUNDLED);
  const inject = parseInject(src);
  assert.ok(Array.isArray(inject), 'inject 数组字面量应可解析');
  assert.ok(
    inject.includes('settings'),
    `inject 缺 "settings"（0.8.0 截丢回归）: [${inject.join(', ')}]`,
  );
  // 核心服务面齐全（截丢通常从队尾开始，锁全长防半截）。
  for (const svc of ['webServer', 'agents', 'sessions', 'agentDefaultModel', 'llm', 'settings']) {
    assert.ok(inject.includes(svc), `inject 缺核心服务 "${svc}"`);
  }
});

test('内置产物：两级 register 降级在场（旧配置拒收时空 base 重试）', () => {
  const src = readIfExists(BUNDLED);
  assert.ok(src);
  assert.ok(
    src.includes('retrying with defaults'),
    '空 base 重试分支应在场（旧格式存储不再把热更链路打死）',
  );
  assert.ok(
    src.includes('ctx.settings.register(NS, Config, { base: {} })'),
    '空 base 注册调用形态应在场',
  );
});

test('源码仓与内置产物双轨一致（inject 同含 settings + 同款降级）', { skip: !readIfExists(SOURCE) }, () => {
  const src = readIfExists(SOURCE);
  const inject = parseInject(src);
  assert.ok(Array.isArray(inject) && inject.includes('settings'), '源码 inject 不得回退');
  assert.ok(src.includes('retrying with defaults'), '源码降级分支不得回退');
});
