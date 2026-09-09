'use strict';

// 修复 issue #36：dsh-client-ui-primitives 的 Menu 弹层（portal 模式）在条目
// 很多（如 8 个壳内置 Agent 预设 + npm 自带预设 + 用户安装的预设叠加）时
// 没有高度上限：place() 用列表完整高度做视口夹紧
//   y = min(max(y, 12), vh - lh - 12)
// 列表比视口还高时 vh - lh - 12 为负，弹层被推到视口上方，顶部条目（标准
// 模式等）被裁掉且无法滚动/触达（用户反馈「预设多了上面的会不显示」）。
//
// 修复（幂等、anchor 不匹配时跳过且绝不损坏文件）：
//  1. 给 portal 列表加内联 max-height（min(视口高-24px, 560px)）+ overflow-y
//     auto——列表自身可滚动，任何视口高度下都完整可用；
//  2. place() 的 y 夹紧按「封顶后的高度」计算，保证弹层始终完整落在视口内。
//
// 修复 issue #182（macOS 弹层横向溢出）：place() 的 x 夹紧带 `lw > 0` 前提——
// 首帧列表未测量（lw=0，mac WebView 字体/布局时序更晚）时整段夹紧被跳过，
// 弹层按锚点原始 x 溢出视口右缘被裁剪。修法：
//  1. lw=0 时按视口宽兜底夹紧（不再放弃横向约束）；
//  2. ResizeObserver 在列表尺寸变化时重新 place（首帧 0 → 变宽后自动校正）。
//
// 用法：
//   node scripts/patch-menu-viewport.js [<node_modules 根目录>]
// 同时导出 patchMenuViewport(nmRoot, log) 供 main.js 启动补丁与 after-pack.js
// 打包补丁复用（覆盖内置副本 / profile fallback / agent overlay）。

const fs = require('node:fs');
const path = require('node:path');
// 原子写与 main.js / 其它补丁脚本共用同一实现（scripts/lib/patch-io.js）。
const { writeFileAtomic } = require('./lib/patch-io');

const MARKER = 'dsh-desktop patch (issue #36)';
const MARKER_182 = 'dsh-desktop patch (issue #182)';

const OLD_Y_CLAMP = 'if (lh > 0) y = Math.min(Math.max(y, MARGIN), vh - lh - MARGIN);';
const NEW_Y_CLAMP = [
  '// dsh-desktop patch (issue #36): 列表高度按视口封顶（见下方 maxHeight），',
  '// y 夹紧按封顶后的高度计算，弹层永远完整落在视口内。',
  'if (lh > 0) y = Math.min(Math.max(y, MARGIN), Math.max(MARGIN, vh - Math.min(lh, vh - 2 * MARGIN) - MARGIN));',
].join('\n');

const OLD_STYLE = 'style: portal ? fixedPos ?? MEASURE_STYLE : void 0,';
const NEW_STYLE = 'style: portal ? { ...(fixedPos ?? MEASURE_STYLE), maxHeight: "min(calc(100vh - 24px), 560px)", overflowY: "auto" } : void 0,';

// issue #182：x 夹紧首帧兜底 + ResizeObserver 重定位。
const X_CLAMP_36 = 'if (lw > 0) x = Math.min(Math.max(x, MARGIN), vw - lw - MARGIN);';
const X_CLAMP_182 = [
  '// dsh-desktop patch (issue #182): lw 未测量（首帧 0）时不得放弃横向夹紧——',
  '// 按视口宽兜底；列表尺寸变化经 ResizeObserver 重新 place（mac WebView 首帧',
  '// lw=0 时弹层按锚点原始 x 溢出视口右缘被裁剪的根因）。',
  'if (lw > 0) x = Math.min(Math.max(x, MARGIN), vw - lw - MARGIN);',
  'else x = Math.min(Math.max(x, MARGIN), Math.max(MARGIN, vw - 2 * MARGIN));',
].join('\n');
const CLEANUP_182_ANCHOR = [
  '\t\t\treturn () => {',
  '\t\t\t\twindow.removeEventListener("scroll", place, true);',
  '\t\t\t\twindow.removeEventListener("resize", place);',
  '\t\t\t};',
].join('\n');
const CLEANUP_182_NEW = [
  '\t\t\treturn () => {',
  '\t\t\t\tro?.disconnect();',
  '\t\t\t\twindow.removeEventListener("scroll", place, true);',
  '\t\t\t\twindow.removeEventListener("resize", place);',
  '\t\t\t};',
].join('\n');
const RO_CREATE_182_ANCHOR = [
  '\t\tplace();',
  '\t\twindow.addEventListener("scroll", place, true);',
  '\t\twindow.addEventListener("resize", place);',
].join(String.fromCharCode(10));
const RO_CREATE_182_NEW = [
  '\t\tplace();',
  '\t\twindow.addEventListener("scroll", place, true);',
  '\t\twindow.addEventListener("resize", place);',
  '\t\t// issue #182：列表首帧 lw=0、字体/内容撑宽后需要重新 place。',
  '\t\tconst ro = typeof ResizeObserver !== "undefined" && listEl ? new ResizeObserver(() => place()) : null;',
  '\t\tif (ro && listEl) ro.observe(listEl);',
].join(String.fromCharCode(10));

function patchFile(file, log = () => {}, stats, options) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('menu-viewport 补丁: 读取失败 ' + file + ': ' + err.message);
    return false;
  }
  let changed36 = false;
  let changed182 = false;
  let applied = [];
  if (!src.includes(MARKER)) {
    if (!src.includes(OLD_Y_CLAMP) || !src.includes(OLD_STYLE)) {
      log('menu-viewport 补丁: 锚点未匹配（dsh 版本可能已变化），跳过 ' + file);
      if (stats) stats.anchorMissing += 1;
    } else {
      src = src.replace(OLD_Y_CLAMP, NEW_Y_CLAMP).replace(OLD_STYLE, NEW_STYLE);
      src = '// ' + MARKER + ': Menu portal 列表视口封顶（issue #36）\n' + src;
      changed36 = true;
      applied.push('#36');
    }
  } else {
    log('menu-viewport 补丁: #36 已应用，跳过 ' + file);
  }
  if (!src.includes(MARKER_182)) {
    if (!src.includes(X_CLAMP_36) || !src.includes(CLEANUP_182_ANCHOR) || !src.includes(RO_CREATE_182_ANCHOR)) {
      log('menu-viewport 补丁: #182 锚点未匹配（dsh 版本可能已变化），跳过 ' + file);
      if (stats) stats.anchorMissing182 = (stats.anchorMissing182 || 0) + 1;
    } else {
      src = src.replace(X_CLAMP_36, X_CLAMP_182)
        .replace(CLEANUP_182_ANCHOR, CLEANUP_182_NEW)
        .replace(RO_CREATE_182_ANCHOR, RO_CREATE_182_NEW);
      src = '// ' + MARKER_182 + ': Menu 弹层横向溢出修复（issue #182）\n' + src;
      changed182 = true;
      applied.push('#182');
    }
  } else {
    log('menu-viewport 补丁: #182 已应用，跳过 ' + file);
  }
  if (!changed36 && !changed182) return false;
  try {
    if (options && options.dryRun) {
      log('menu-viewport 补丁: dry-run: 将应用 ' + file + '（' + applied.join(' + ') + '）');
      return false; // dryRun 不落盘，不计为已写
    }
    writeFileAtomic(file, src);
    log('menu-viewport 补丁: 已应用 ' + file + '（' + applied.join(' + ') + '）');
    return true;
  } catch (err) {
    log('menu-viewport 补丁: 写入失败 ' + file + ': ' + err.message);
    return false;
  }
}

/**
 * 对某个 node_modules 根目录应用补丁（#36 + #182，各自幂等）。
 * @param {string} nmRoot node_modules 根目录
 * @param {(msg: string) => void} [log]
 * @returns {number} 实际发生修改的文件数
 */
function patchMenuViewport(nmRoot, log = () => {}, stats, options) {
  const file = path.join(nmRoot, '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'index.js');
  if (!fs.existsSync(file)) return 0;
  return patchFile(file, log, stats, options) ? 1 : 0;
}

module.exports = { patchMenuViewport, MARKER, MARKER_182 };

if (require.main === module) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'node_modules');
  const n = patchMenuViewport(root, (m) => console.log(m));
  console.log(n > 0 ? `patched ${n} file(s) — restart DSH Desktop to pick it up` : 'nothing to patch (already up to date)');
}
