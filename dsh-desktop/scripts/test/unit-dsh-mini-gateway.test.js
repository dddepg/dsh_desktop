'use strict';

// ---------------------------------------------------------------------------
// dsh-mini LAN 网关端到端集成测试（node --test，独立进程）。
//
// 覆盖面（此前测试只测纯函数，网关的鉴权/反代/GUI/WS 链路零覆盖）：
//   1. 无 token 访问 GUI        → 403 需要令牌页
//   2. ?token=正确              → 302 + HttpOnly 会话 cookie
//   3. 带 cookie 访问 /         → 200 且含 __DSH_BOOT__ 注入
//   4. 回环直连免 token（豁免路径）
//   5. 外网 Host + publicMode=false → 403（外网访问关闭）
//   6. /api/ping 免鉴权 liveness
//   7. /dsh-mini/* 反代透传 + 网关盖章头（x-dsh-mini-gateway: 1）
//   8. 反代鉴权仍由上游执行（无 token → 上游 401 透传）
//   9. POST /api/gateway/config 经网关 → 403 loopback-only（手机不得改配置）
//  10. /api/events.mux WS：token 放行 + 连接即 session/subscribed 基线帧
//  11. POST /api/<method> RPC 信封（已鉴权）
//
// 运行：node --test scripts/test/unit-dsh-mini-gateway.test.js
// 说明：require(esm) 由 Node 24 支持；DSH_HOME 指向一次性目录，token 用
// DSH_MINI_TOKEN 固定（优先级最高），测试进程退出即释放网关端口。
// ---------------------------------------------------------------------------

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mini-gw-'));
process.env.DSH_HOME = HOME;
process.env.DSH_MINI_TOKEN = 'e2e-gateway-token-0123456789abcdef';

const mini = require('../../assets/plugins/dsh-mini/lib/index.js');

const GATEWAY_PORT = 46880 + Math.floor(Math.random() * 1500);
const BASE = 'http://127.0.0.1:' + GATEWAY_PORT;
const TOKEN = process.env.DSH_MINI_TOKEN;

// ---- loopback 上游桩：模拟内核 webServer（反代目标），回显盖章头 ----
let lastUpstreamHeaders = null;
const upstream = http.createServer((req, res) => {
  lastUpstreamHeaders = { ...req.headers };
  const body = JSON.stringify({ upstream: true, url: req.url, gw: req.headers['x-dsh-mini-gateway'] || null });
  res.writeHead(req.url.includes('unauthorized') ? 401 : 200, { 'Content-Type': 'application/json' });
  res.end(body);
});
let upstreamPort = 0;

// ---- ctx 桩（cordis effect/服务容器最小面）----
const disposers = [];
// 进程级收口：网关/路由的 dispose（含 stopGateway）+ 上游 server close。
// 不关的话活跃 listen 句柄会阻止 node --test 退出（实测挂满整个超时窗口）。
test.after(() => {
  console.log('[e2e] teardown begin');
  for (const d of disposers.splice(0).reverse()) { try { d(); } catch { /* ignore */ } }
  try { upstream.close(); } catch { /* ignore */ }
  // Node 19+ 全局 agent 默认 keep-alive：闲置连接会阻止 server.close 完成，
  // 必须显式抬掉全部连接，否则整个测试进程挂满超时窗口（实测）。
  try { upstream.closeAllConnections(); } catch { /* 旧版本无此 API */ }
  try {
    const hs = process._getActiveHandles().map((h) => (h.constructor && h.constructor.name) + (h.remoteAddress ? '[' + h.remoteAddress + ']' : ''));
    console.log('[e2e] 活跃句柄:', JSON.stringify(hs));
  } catch { /* 内部 API 变动则跳过 */ }
  console.log('[e2e] teardown done');
});
const ctx = {
  get(k) {
    if (k === 'webServer') return { port: upstreamPort, host: '127.0.0.1', register: () => () => {} };
    if (k === 'sessions') return { list: () => [{ id: 'session-e2e', seq: 7 }] };
    if (k === 'workspaceRegistry') return { list: () => [], archivedSessionIds: () => [] };
    return undefined;
  },
  effect(fn) {
    const d = fn();
    if (typeof d === 'function') disposers.push(d);
    return d;
  },
};

function req(method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + urlPath, { method, headers: { Connection: 'close', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        setCookie: (res.headers['set-cookie'] || [])[0] || '',
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    r.end();
  });
}

// 本机局域网 IPv4（mini 的 lanAddresses 同款判定）：用于发起非回环来源请求，
// 进入 token/cookie 鉴权分支（回环在设计上豁免 token，测不到那条路径）。
const LAN_IP = (() => {
  const ifaces = require('node:os').networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni && ni.family === 'IPv4' && !ni.internal && ni.address) return ni.address;
    }
  }
  return '127.0.0.1';
})();
const BASE_LAN = 'http://' + LAN_IP + ':' + GATEWAY_PORT;

function reqLan(method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('reqLan timeout (10s): ' + method + ' ' + urlPath)), 10000);
    const r = http.request(BASE_LAN + urlPath, { method, headers: { Connection: 'close', Host: LAN_IP + ':' + GATEWAY_PORT, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        setCookie: (res.headers['set-cookie'] || [])[0] || '',
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    r.end();
  });
}

function wsHandshake(urlPath) {
  return new Promise((resolve, reject) => {
    const key = 'dGVzdC1rZXktMTIzNDU2Nzg5MGFiY2RlZg==';
    const sock = net.connect(GATEWAY_PORT, '127.0.0.1', () => {
      sock.write(
        'GET ' + urlPath + '?token=' + encodeURIComponent(TOKEN) + ' HTTP/1.1\r\n' +
        'Host: 127.0.0.1:' + GATEWAY_PORT + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let buf = Buffer.alloc(0);
    let stage = 'head';
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'head') {
        const eoh = buf.indexOf('\r\n\r\n');
        if (eoh < 0) return;
        const head = buf.slice(0, eoh).toString('utf8');
        if (!/101 /.test(head)) { reject(new Error('WS 握手失败: ' + head.split('\r\n')[0])); sock.destroy(); return; }
        stage = 'frame';
        buf = buf.slice(eoh + 4);
      }
      if (stage === 'frame') {
        const p = buf.indexOf(0x81); // 定位 FIN+text 帧起始（容忍前导字节）
        if (p < 0) return;
        let off = p + 2;
        let len = buf[p + 1] & 0x7f;
        if (len === 126) { if (buf.length < off + 2) return; len = buf.readUInt16BE(off); off += 2; }
        else if (len === 127) { if (buf.length < off + 8) return; len = Number(buf.readBigUInt64BE(off)); off += 8; }
        if (buf.length < off + len) return;
        resolve({ sock, frame: JSON.parse(buf.slice(off, off + len).toString('utf8')) });
        sock.destroy();
      }
    });
    sock.on('error', reject);
  });
}

test('setup：上游桩与网关启动', async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;
  const cfgDir = path.join(HOME, 'dsh-mini');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ lanEnabled: true, gatewayPort: GATEWAY_PORT }));
  mini.apply(ctx);
  // 网关监听就绪轮询（/api/ping 免鉴权，恰好兼作就绪探针）
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try { const r = await req('GET', '/api/ping'); up = r.status === 200; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(up, '网关应在超时前进入监听（/api/ping 200）');
});

test('无 token 访问 GUI（LAN 来源）→ 403 需要令牌页', async () => {
  const r = await reqLan('GET', '/');
  assert.equal(r.status, 403);
  assert.ok(r.body.includes('需要连接令牌'), '403 页应提示连接令牌');
});

test('?token=正确 → 302 + HttpOnly 会话 cookie（剥离 token 参数，LAN 来源）', async () => {
  const r = await reqLan('GET', '/?token=' + encodeURIComponent(TOKEN));
  assert.equal(r.status, 302);
  assert.ok(/dsh_mini_sid=[0-9a-f]+\.[0-9a-f]+/.test(r.setCookie), '应下发签名会话 cookie');
  assert.ok(/HttpOnly/.test(r.setCookie), '会话 cookie 必须 HttpOnly');
  assert.ok(!r.headers.location.includes('token='), '302 目标不得回带 token');
});

test('带会话 cookie 访问 / → 200 + __DSH_BOOT__ 注入（LAN 来源）', async () => {
  const first = await reqLan('GET', '/?token=' + encodeURIComponent(TOKEN));
  const cookie = (first.setCookie.match(/dsh_mini_sid=[^;]+/) || [''])[0];
  assert.ok(cookie, '应取得会话 cookie');
  const r = await reqLan('GET', '/', { Cookie: cookie });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('__DSH_BOOT__'), 'GUI index 应含启动清单注入');
  assert.ok(r.body.includes('dsh-mobile-patch'), 'GUI index 应含手机端补丁样式');
});

test('回环直连免 token（上游设计：本机浏览器豁免鉴权）', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200, '回环来源应豁免 token（publicMode 关闭时）');
});

test('外网 Host + publicMode=false → 403 外网访问关闭', async () => {
  const r = await req('GET', '/api/ping', { Host: 'evil.example.com:46880' });
  assert.equal(r.status, 403);
  assert.ok(r.body.includes('external access disabled'), '应拒绝公网来源');
});

test('/dsh-mini/* 反代：透传 + 网关盖章头 x-dsh-mini-gateway:1', async () => {
  const r = await req('GET', '/dsh-mini/api/health?token=' + encodeURIComponent(TOKEN));
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.gw, '1', '网关必须盖章（上游鉴权依赖此头区分来源）');
  assert.equal(body.url, '/dsh-mini/api/health?token=' + encodeURIComponent(TOKEN), '路径与查询应原样透传');
});

test('/dsh-mini/* 反代：上游 401 原样透传（鉴权仍由上游执行）', async () => {
  const r = await req('GET', '/dsh-mini/api/health-unauthorized');
  assert.equal(r.status, 401, '无 token 的旧协议请求应被上游 401 并透传');
});

test('POST /api/gateway/config 带网关盖章头（非本机直连形态）→ 403 loopback-only', async () => {
  const first = await reqLan('GET', '/?token=' + encodeURIComponent(TOKEN));
  const cookie = (first.setCookie.match(/dsh_mini_sid=[^;]+/) || [''])[0];
  assert.ok(cookie, 'LAN 来源 token 换取会话应成功');
  const r = await req('POST', '/api/gateway/config', { Cookie: cookie, 'Content-Type': 'application/json', 'x-dsh-mini-gateway': '1' });
  assert.equal(r.status, 403);
  assert.ok(r.body.includes('loopback-only'), '网关来源的配置变更必须被拒（防手机端改配置）');
});

test('POST /api/<method> RPC 信封（已鉴权会话）', async () => {
  const first = await req('GET', '/?token=' + encodeURIComponent(TOKEN));
  const cookie = (first.setCookie.match(/dsh_mini_sid=[^;]+/) || [''])[0];
  const r = await req('POST', '/api/gateway', { Cookie: cookie, 'Content-Type': 'application/json' });
  assert.equal(r.status, 200);
  const envelope = JSON.parse(r.body);
  assert.equal(envelope.type, 'server-response');
  const result = envelope.result;
  assert.ok(result.ok === true || (result.error && result.error.code), 'RPC 应返回官方信封（ok 或结构化错误）');
  if (result.ok) assert.ok(result.value.gateway, 'gateway RPC 应返回网关状态');
});

test('WS /api/events.mux：token 放行 + 连接即 session/subscribed 基线帧', async () => {
  const { frame } = await wsHandshake('/api/events.mux');
  assert.equal(frame.type, 'server-request');
  assert.equal(frame.method, 'session/subscribed');
  assert.equal(frame.payload.sessionId, 'session-e2e');
});
