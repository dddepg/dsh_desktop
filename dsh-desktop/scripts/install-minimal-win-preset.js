'use strict';

// Install every bundled agent preset from assets/agent-presets into an
// @deepseek-ai/dsh package directory.
//
// - `npm start` runs this against the dev node_modules copy so the presets are
//   also visible when running from source.
// - scripts/after-pack.js runs it against the packed app copy, so the shipped
//   build carries all presets out of the box.
//
// Preset directory ids must match [a-z0-9-]+ (the user-facing name lives in
// each preset.yml). Current set:
//   anchored-standard              -> 官pro
//   v4-flash-godmode-opencode-go   -> goflash
//   router-standard                -> router-standard
//
// 预设目录整树复制（可带子目录，如 skills/ 与 scripts/）；
// 若预设自带 skills/<name> 子目录，还会随装到 <dshHome>/skills/<name>
// （与上游 install.ps1 一致：已存在的同名 skill 不覆盖）。

const fs = require('node:fs');
const path = require('node:path');

function presetsSourceDir() {
  return path.resolve(__dirname, '..', 'assets', 'agent-presets');
}

/**
 * 启动提速：目标文件与源大小 + mtime 一致时跳过复制（cpSync 保留时间戳，
 * 复制的目标 mtime 与源一致，下次启动可继续命中跳过）。预设安装的语义是
 * 「目标必须与源一致」：不一致（缺失/大小或时间戳不同）就覆盖，因此跳过
 * 只发生在目标已一致时，行为与原「每次全量复制」等价，只是不再无意义写盘。
 */
function fileMatches(sf, df) {
  try {
    const sst = fs.statSync(sf);
    const dst = fs.statSync(df);
    return dst.size === sst.size && Math.round(dst.mtimeMs) === Math.round(sst.mtimeMs);
  } catch {
    return false;
  }
}

/** 递归同步一棵目录树：文件大小+mtime 一致则跳过写盘（cpSync 保留时间戳）。 */
function syncTree(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sf = path.join(src, entry.name);
    const df = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(df, { recursive: true });
      syncTree(sf, df);
    } else if (entry.isFile()) {
      if (fileMatches(sf, df)) continue; // 已一致：跳过写盘
      fs.cpSync(sf, df, { force: true, preserveTimestamps: true });
    }
  }
}

/** Copy one bundled preset directory into <dshPackageDir>/config/agent-presets/. */
function installBuiltinPreset(dshPackageDir, id) {
  const src = path.join(presetsSourceDir(), id);
  const agentFile = path.join(src, 'agent.cordis.yml');
  const metaFile = path.join(src, 'preset.yml');
  if (!fs.existsSync(agentFile) || !fs.existsSync(metaFile)) {
    throw new Error(`builtin preset source incomplete: ${src}`);
  }
  const dest = path.join(dshPackageDir, 'config', 'agent-presets', id);
  fs.mkdirSync(dest, { recursive: true });
  // 整树复制：预设可携带本地 .mjs bootstrap 模块（相对路径引用）以及
  // skills/、scripts/ 等子目录，全部随预设进包。
  syncTree(src, dest);
  return dest;
}

/** Shared-module directory inside the preset root (not a preset slot). */
const SHARED_PRESET_DIR = '_preset';

/** Presets shipped by older DSH Desktop builds but removed from this branch. */
const RETIRED_BUILTIN_PRESET_DIRS = [
  'minimal-win',
  'router-jspace',
  'zero-anchored-standard',
  'whoami-standard',
  'warmupbetter',
  'warmupbetter-replay',
  SHARED_PRESET_DIR,
];

/**
 * 从 dsh 包目录反推 DSH_HOME（<DSH_HOME>/agent/node_modules/@deepseek-ai/dsh
 * 布局）。布局不符（如打包后内置在应用目录里的包）返回 undefined，
 * 由调用方显式传入 DSH_HOME。
 */
function resolveDshHomeFromPackage(dshPackageDir) {
  const scopeDir = path.dirname(dshPackageDir);   // @deepseek-ai
  const modulesDir = path.dirname(scopeDir);      // node_modules
  const agentDir = path.dirname(modulesDir);      // agent
  if (path.basename(modulesDir) === 'node_modules' && path.basename(agentDir) === 'agent') {
    return path.dirname(agentDir);
  }
  return undefined;
}

/**
 * 把各预设自带的 skills/<name> 子目录随装到 <dshHome>/skills/<name>。
 * 目标已存在（用户已有本地版本）则跳过，与上游 install.ps1 语义一致。
 * @returns 本次新安装的 skill 数。
 */
function installBuiltinPresetSkills(dshPackageDir, dshHome) {
  if (!dshHome) return 0;
  const presetRoot = presetsSourceDir();
  const skillsDest = path.join(dshHome, 'skills');
  let installed = 0;
  for (const entry of fs.readdirSync(presetRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === SHARED_PRESET_DIR) continue;
    const skillsSrc = path.join(presetRoot, entry.name, 'skills');
    if (!fs.existsSync(skillsSrc)) continue;
    for (const skill of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const df = path.join(skillsDest, skill.name);
      if (fs.existsSync(df)) continue; // 已有用户版本：不覆盖
      fs.mkdirSync(skillsDest, { recursive: true });
      fs.cpSync(path.join(skillsSrc, skill.name), df, {
        recursive: true, force: true, preserveTimestamps: true,
      });
      installed += 1;
    }
  }
  return installed;
}

/** Install all bundled presets. Returns the destination directories. */
function installBuiltinPresets(dshPackageDir, dshHome) {
  const presetRoot = presetsSourceDir();
  const destRoot = path.join(dshPackageDir, 'config', 'agent-presets');
  for (const id of RETIRED_BUILTIN_PRESET_DIRS) {
    fs.rmSync(path.join(destRoot, id), { recursive: true, force: true });
  }
  const ids = fs.readdirSync(presetRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== SHARED_PRESET_DIR)
    .map((entry) => entry.name)
    .sort();
  const dests = ids.map((id) => installBuiltinPreset(dshPackageDir, id));

  // `_preset` was removed with the zero/whoami presets; this block is kept as
  // a no-op so future presets can reintroduce a shared module directory.
  const sharedSrc = path.join(presetRoot, SHARED_PRESET_DIR);
  if (fs.existsSync(sharedSrc)) {
    const sharedDest = path.join(dshPackageDir, 'config', 'agent-presets', SHARED_PRESET_DIR);
    fs.mkdirSync(sharedDest, { recursive: true });
    syncTree(sharedSrc, sharedDest);
  }

  // 随预设分发的 skills（当前预设均无 skills/，机制保留以支持未来带 skills 的预设）。
  const skills = installBuiltinPresetSkills(dshPackageDir, dshHome || resolveDshHomeFromPackage(dshPackageDir));
  if (skills > 0) {
    console.log(`builtin preset skills installed (${skills}) → ${path.join(dshHome || resolveDshHomeFromPackage(dshPackageDir), 'skills')}`);
  }
  return dests;
}

/** Backward-compatible wrapper (legacy name retained for older callers). */
function installMinimalWinPreset(dshPackageDir) {
  return installBuiltinPreset(dshPackageDir, 'anchored-standard');
}

/** Resolve the locally installed @deepseek-ai/dsh package directory. */
function installedDshPackageDir() {
  const pkgFile = require.resolve('@deepseek-ai/dsh/package.json');
  return path.dirname(pkgFile);
}

module.exports = {
  installMinimalWinPreset,
  installBuiltinPreset,
  installBuiltinPresets,
  installBuiltinPresetSkills,
  resolveDshHomeFromPackage,
  installedDshPackageDir,
  PRESET_ID: 'anchored-standard',
};

if (require.main === module) {
  try {
    const pkgDir = installedDshPackageDir();
    const dshHome = process.argv[2] || resolveDshHomeFromPackage(pkgDir);
    const dests = installBuiltinPresets(pkgDir, dshHome);
    console.log(`builtin presets installed (${dests.length}): ${dests.join(', ')}`);
  } catch (err) {
    console.error(`builtin preset install failed: ${(err && err.message) || err}`);
    process.exit(1);
  }
}