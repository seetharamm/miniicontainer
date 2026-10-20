'use strict';
/**
 * mydocker system — runtime management
 *
 * Subcommands:
 *   df       Show disk usage (images, containers, volumes)
 *   info     Display system-wide information
 *   prune    Remove all unused resources
 *   version  Show version information
 */
const chalk = require('chalk');
const path  = require('path');
const os    = require('os');
const fs    = require('fs-extra');
const store = require('../state/store');
const eventlog = require('../state/eventlog');

// ── df ────────────────────────────────────────────────────────────────────────

function systemDf() {
  const images     = Object.values(store.getImages());
  const containers = Object.values(store.getContainers());
  const { listNamedVolumes } = require('../core/volumes');
  const volumes = listNamedVolumes();

  // Calculate sizes
  function dirSize(p) {
    try {
      let total = 0;
      const entries = fs.readdirSync(p, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) total += dirSize(full);
        else { try { total += fs.statSync(full).size; } catch {} }
      }
      return total;
    } catch { return 0; }
  }

  function fmt(bytes) {
    if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  let imageSize = 0;
  for (const img of images) {
    if (img.rootfs) imageSize += dirSize(img.rootfs);
  }

  let containerSize = 0;
  for (const c of containers) {
    if (c.rootfs) containerSize += dirSize(c.rootfs);
  }

  let volumeSize = 0;
  for (const v of volumes) {
    if (v.path) volumeSize += dirSize(v.path);
  }

  const cacheDir = path.join(os.homedir(), '.minicontainer', 'cache', 'blobs', 'sha256');
  const cacheSize = fs.existsSync(cacheDir) ? dirSize(cacheDir) : 0;

  console.log(chalk.bold('TYPE            TOTAL   SIZE'));
  console.log(`Images          ${String(images.length).padEnd(8)}${fmt(imageSize)}`);
  console.log(`Containers      ${String(containers.length).padEnd(8)}${fmt(containerSize)}`);
  console.log(`Volumes         ${String(volumes.length).padEnd(8)}${fmt(volumeSize)}`);
  console.log(`Build Cache     -       ${fmt(cacheSize)}`);
  console.log();
  console.log(`Total reclaimable: ${fmt(imageSize + containerSize + volumeSize + cacheSize)}`);
}

// ── info ──────────────────────────────────────────────────────────────────────

function systemInfo() {
  const containers = Object.values(store.getContainers());
  const images     = Object.values(store.getImages());
  const { listNamedVolumes } = require('../core/volumes');
  const volumes = listNamedVolumes();
  const { IS_LINUX, IS_WINDOWS, platform } = require('../utils/platform');
  const pkg = require('../../package.json');

  const running = containers.filter(c => c.status === 'running').length;
  const stopped = containers.filter(c => c.status === 'exited').length;

  console.log(`Client:`);
  console.log(` Version:           ${pkg.version}`);
  console.log(` Context:           default`);
  console.log();
  console.log(`Server:`);
  console.log(` Containers:        ${containers.length}`);
  console.log(`  Running:          ${running}`);
  console.log(`  Paused:           0`);
  console.log(`  Stopped:          ${stopped}`);
  console.log(` Images:            ${images.length}`);
  console.log(` Volumes:           ${volumes.length}`);
  console.log(` Storage Driver:    native`);
  console.log(` Logging Driver:    json-file`);
  console.log(` Cgroup Driver:     ${IS_LINUX ? 'cgroupfs' : 'none'}`);
  console.log();
  console.log(`Host:`);
  console.log(` OS:                ${platform()}`);
  console.log(` Arch:              ${process.arch}`);
  console.log(` CPUs:              ${os.cpus().length}`);
  console.log(` Total Memory:      ${(os.totalmem() / 1e9).toFixed(2)} GB`);
  console.log(` Kernel Version:    ${os.release()}`);
  console.log(` Data Root:         ${path.join(os.homedir(), '.minicontainer')}`);
}

// ── prune ─────────────────────────────────────────────────────────────────────

async function systemPrune(opts = {}) {
  const { force = false, all = false, volumes: pruneVolumes = false } = opts;

  if (!force) {
    console.log(chalk.yellow(
      'WARNING! This will remove:\n' +
      '  - all stopped containers\n' +
      '  - all unused images\n' +
      (pruneVolumes ? '  - all unused volumes\n' : '') +
      '\nRun with --force to skip this prompt.'
    ));
    return;
  }

  let freed = 0;
  const containers = Object.values(store.getContainers());

  // Remove stopped containers
  for (const c of containers) {
    if (c.status !== 'running') {
      try {
        const { default: fs } = await import('fs');
        store.deleteContainer(c.id);
        if (c.rootfs) fs.rmSync(path.dirname(c.rootfs), { recursive: true, force: true });
        console.log(chalk.gray(`Removed container: ${c.id.slice(0, 12)}`));
      } catch {}
    }
  }

  // Prune volumes if requested
  if (pruneVolumes) {
    const { listNamedVolumes, removeNamedVolume } = require('../core/volumes');
    for (const v of listNamedVolumes()) {
      try { removeNamedVolume(v.name); console.log(chalk.gray(`Removed volume: ${v.name}`)); }
      catch {}
    }
  }

  // Prune layer cache
  const cacheDir = path.join(os.homedir(), '.minicontainer', 'cache', 'blobs', 'sha256');
  if (all && fs.existsSync(cacheDir)) {
    fs.emptyDirSync(cacheDir);
    console.log(chalk.gray('Cleared layer cache'));
  }

  eventlog.system.prune(all ? 'all' : 'containers');
  console.log(chalk.green('Prune complete'));
}

// ── main handler ──────────────────────────────────────────────────────────────

async function systemCommand(subcommand, _args, opts = {}) {
  switch (subcommand) {
    case 'df':
      systemDf();
      break;
    case 'info':
      systemInfo();
      break;
    case 'prune':
      await systemPrune(opts);
      break;
    case 'version':
      require('./version')(opts);
      break;
    default:
      console.error(`Unknown system subcommand: ${subcommand}`);
      console.error('Available: df, info, prune, version');
      process.exit(1);
  }
}

module.exports = systemCommand;
module.exports.systemDf   = systemDf;
module.exports.systemInfo = systemInfo;
module.exports.systemPrune = systemPrune;
