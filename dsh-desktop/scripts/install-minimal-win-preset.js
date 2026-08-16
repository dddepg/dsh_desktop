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

const fs = require('node:fs');
const path = require('node:path');

function presetsSourceDir() {
  return path.resolve(__dirname, '..', 'assets', 'agent-presets');
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
  // Full-directory copy: presets may carry local .mjs bootstrap modules
  // referenced relatively from agent.cordis.yml.
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
  }
  return dest;
}

/** Shared-module directory inside the preset root (not a preset slot). */
const SHARED_PRESET_DIR = '_preset';

/** Presets shipped by older DSH Desktop builds but removed from this branch. */
const RETIRED_BUILTIN_PRESET_DIRS = [
  'minimal-win',
  'zero-anchored-standard',
  'whoami-standard',
  'warmupbetter',
  'warmupbetter-replay',
  SHARED_PRESET_DIR,
];

/** Install all bundled presets. Returns the destination directories. */
function installBuiltinPresets(dshPackageDir) {
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
    for (const entry of fs.readdirSync(sharedSrc, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      fs.copyFileSync(path.join(sharedSrc, entry.name), path.join(sharedDest, entry.name));
    }
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
  installedDshPackageDir,
  PRESET_ID: 'anchored-standard',
};

if (require.main === module) {
  try {
    const dests = installBuiltinPresets(installedDshPackageDir());
    console.log(`builtin presets installed (${dests.length}): ${dests.join(', ')}`);
  } catch (err) {
    console.error(`builtin preset install failed: ${(err && err.message) || err}`);
    process.exit(1);
  }
}