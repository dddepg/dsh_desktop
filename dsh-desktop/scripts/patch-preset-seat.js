'use strict';

// 模式选择 chip 锁死修复（dsh-client-ui-agent-preset）运行时补丁（幂等）。
//
// 根因：AgentPresetSeatController.apply() 内 `this.remotePresets(ctx)` 双重错误
// ——remotePresets 是模块级函数（this.remotePresets = undefined）+ ctx 应为
// this.ctx——首次选择即抛 TypeError；busy 先行置 true 且无复位，chip 的
// `disabled: state.busy` 永久锁死（用户实报：新建对话后选一次模式，按钮再按不动）。
//
// 修：① 调用改为 remotePresets(this.ctx)；② busy 异常安全（remote 调用
// try/catch，异常复位 busy 并落到错误显示）。

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./lib/patch-io');

const MARKER = 'dsh-desktop patch (preset seat busy guard)';

const CALL_BAD = 'const result = await this.remotePresets(ctx).select(session.id, staged);';
const CALL_GOOD = 'const result = await remotePresets(this.ctx).select(session.id, staged);';

function applyReplacements(file, log) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('preset-seat 补丁: 读取失败 ' + file + ': ' + err.message);
    return false;
  }
  if (src.includes(MARKER)) {
    log('preset-seat 补丁: 已应用，跳过 ' + file);
    return false;
  }
  if (!src.includes(CALL_BAD)) {
    log('preset-seat 补丁: 锚点未匹配（dsh 版本可能已变化），跳过 ' + file);
    return false;
  }
  src = src.replace(CALL_BAD, CALL_GOOD);
  // busy 异常安全：remote 调用段包 try/catch（异常复位 busy 并落到错误显示）。
  const busySet = 'this.set({ busy: true, error: null });';
  const call = 'await remotePresets(this.ctx).select(session.id, staged);';
  if (src.includes(busySet) && src.includes(call)) {
    src = src.replace(
      busySet + '\r\n\t\t\t\tconst result = ' + call,
      busySet + '\r\n\t\t\t\tlet result;\r\n\t\t\t\ttry {\r\n\t\t\t\t\tresult = ' + call + '\r\n\t\t\t\t} catch (err) {\r\n\t\t\t\t\tthis.staged = void 0;\r\n\t\t\t\t\tthis.set({ busy: false, error: String(err && err.message || err).slice(0, 160) });\r\n\t\t\t\t\treturn;\r\n\t\t\t\t}'
    );
    src = src.replace(
      busySet + '\n\t\t\t\tconst result = ' + call,
      busySet + '\n\t\t\t\tlet result;\n\t\t\t\ttry {\n\t\t\t\t\tresult = ' + call + '\n\t\t\t\t} catch (err) {\n\t\t\t\t\tthis.staged = void 0;\n\t\t\t\t\tthis.set({ busy: false, error: String(err && err.message || err).slice(0, 160) });\n\t\t\t\t\treturn;\n\t\t\t\t}'
    );
  }
  src = '// ' + MARKER + ': 模式 chip 选择后 busy 卡死修复\n' + src;
  try {
    writeFileAtomic(file, src);
    log('preset-seat 补丁: 已应用 ' + file);
    return true;
  } catch (err) {
    log('preset-seat 补丁: 写入失败 ' + file + ': ' + err.message);
    return false;
  }
}

/**
 * 对某个 node_modules 根目录应用「模式 chip 锁死」补丁（幂等）。
 * @param {string} nmRoot node_modules 根目录
 * @param {(msg: string) => void} [log]
 * @returns {number} 实际发生修改的文件数
 */
function patchPresetSeat(nmRoot, log = () => {}) {
  const targets = [
    path.join(nmRoot, '@deepseek-ai', 'dsh-client-ui-agent-preset', 'lib', 'client.js'),
  ];
  let changed = 0;
  for (const t of targets) {
    if (!fs.existsSync(t)) continue;
    if (applyReplacements(t, log)) changed += 1;
  }
  return changed;
}

module.exports = { patchPresetSeat, MARKER };
