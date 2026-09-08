'use strict';
// schema-boolean-required-patch —— pi-ai google 路径的 schema 出口清洗（host 层根治）。
//
// 现象（2026-09-08 Vertex 实测）：插件工具 schema 在属性定义内部写布尔
// `required: true/false`（非法 JSON Schema；cardian 工厂、可选参数等形态），
// 经 parametersJsonSchema 透传给 Gemini 后其严格校验拒绝：
// 400 "value at properties.<k> must be a list"。
//
// 修复：getJsonSchemaToolParameters 返回前递归剥除**布尔值**的 required 键
// （对象级字符串数组 required 合法保留——内核规范化器的提升产物）。变异
// 原地生效：布尔 required 本为非法垃圾，删除无害；二次请求遍历零改动。
//
// 幂等（marker）、锚缺失跳过且不损坏文件（applyPatchToFiles 同契约）。

const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'dsh-desktop patch (schema boolean-required sanitize)';

const FN_ANCHOR = 'export function getJsonSchemaToolParameters(tool, strict) {\n    return (strict === true ? makeStrictJsonSchema(tool.parameters) : tool.parameters);\n}';

const FN_REPLACEMENT = [
  'function stripBooleanRequired(node) {',
  '    if (Array.isArray(node)) {',
  '        for (const entry of node) stripBooleanRequired(entry);',
  '        return node;',
  '    }',
  '    if (node && typeof node === "object") {',
  '        for (const key of Object.keys(node)) {',
  '            if (key === "required" && typeof node[key] === "boolean") {',
  '                delete node[key];',
  '                continue;',
  '            }',
  '            stripBooleanRequired(node[key]);',
  '        }',
  '    }',
  '    return node;',
  '}',
  'export function getJsonSchemaToolParameters(tool, strict) {',
  '    const raw = strict === true ? makeStrictJsonSchema(tool.parameters) : tool.parameters;',
  '    // ' + MARKER + ': 剥除属性级布尔 required（Gemini 严格校验 400 实测；',
  '    // 对象级字符串数组 required 合法保留）。',
  '    return stripBooleanRequired(raw);',
  '}',
].join('\n');

function transformSchemaBooleanRequired(src, file) {
  if (src.includes(MARKER)) return { status: 'already' };
  const idx = src.indexOf(FN_ANCHOR);
  if (idx < 0) {
    return { status: 'anchor-missing', detail: '未找到 getJsonSchemaToolParameters 函数形态（pi-ai 版本可能已变更），跳过 ' + file };
  }
  return { status: 'changed', src: src.slice(0, idx) + FN_REPLACEMENT + src.slice(idx + FN_ANCHOR.length) };
}

/**
 * 对某个 node_modules 根目录应用「schema 布尔 required 清洗」补丁（幂等）。
 * @param {string} nmRoot node_modules 根目录
 * @param {(msg: string) => void} [log]
 * @returns {number} 实际发生修改的文件数
 */
function patchSchemaBooleanRequired(nmRoot, log = () => {}) {
  const file = path.join(nmRoot, '@earendil-works', 'pi-ai', 'dist', 'api', 'constrained-sampling.js');
  if (!fs.existsSync(file)) return 0;
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('schema 清洗补丁: 读取失败 ' + file + ': ' + err.message);
    return 0;
  }
  if (src.includes(MARKER)) {
    log('schema 清洗补丁: 已应用，跳过 ' + file);
    return 0;
  }
  let result;
  try {
    result = transformSchemaBooleanRequired(src, file);
  } catch (err) {
    log('schema 清洗补丁: 失败(' + file + '): ' + err.message);
    return 0;
  }
  if (result.status === 'already') return 0;
  if (result.status === 'anchor-missing') {
    log('schema 清洗补丁: ' + result.detail);
    return 0;
  }
  try {
    fs.writeFileSync(file, result.src, 'utf8');
    log('schema 清洗补丁: 已应用（布尔 required 出口清洗） ' + file);
    return 1;
  } catch (err) {
    log('schema 清洗补丁: 写入失败 ' + file + ': ' + err.message);
    return 0;
  }
}

module.exports = { patchSchemaBooleanRequired, transformSchemaBooleanRequired, MARKER };
