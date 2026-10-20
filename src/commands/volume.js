'use strict';
/**
 * minicontainer volume <subcommand>
 *
 *   volume ls                  List all named volumes
 *   volume inspect <name>      Show detailed info for a named volume
 *   volume rm <name...>        Remove one or more named volumes
 *   volume create <name>       Create a named volume without starting a container
 *   volume prune               Remove all unused named volumes
 */

'use strict';

const chalk = require('chalk');
const { table } = require('table');

const {
  listNamedVolumes,
  getNamedVolume,
  removeNamedVolume,
  ensureNamedVolume,
  VOLUMES_ROOT,
} = require('../core/volumes');

const store = require('../state/store');
const fs    = require('fs-extra');
const path  = require('path');
const os    = require('os');

// ── ls ────────────────────────────────────────────────────────────────────────

function ls() {
  const vols = listNamedVolumes();
  if (vols.length === 0) {
    console.log(chalk.gray('No named volumes found.'));
    return;
  }

  const header = [
    chalk.bold('VOLUME NAME'),
    chalk.bold('CREATED'),
    chalk.bold('PATH'),
  ];

  const rows = vols.map(v => [
    chalk.cyan(v.name),
    v.created ? new Date(v.created).toLocaleString() : '-',
    chalk.gray(v.path),
  ]);

  console.log(table([header, ...rows]));
}

// ── inspect ───────────────────────────────────────────────────────────────────

function inspect(names) {
  for (const name of names) {
    const v = getNamedVolume(name);
    if (!v) {
      console.error(chalk.red(`No such volume: ${name}`));
      continue;
    }

    // Measure disk usage
    let sizeMiB = '?';
    try {
      const bytes = dirSize(v.path);
      sizeMiB = (bytes / 1024 / 1024).toFixed(2);
    } catch {}

    // Find containers that reference this volume
    const containers = Object.values(store.getContainers()).filter(c =>
      (c.volume || []).some(vs => vs.includes(name))
    );

    console.log(chalk.bold.cyan(`\nVolume: ${v.name}`));
    console.log(`  Path    : ${v.path}`);
    console.log(`  Created : ${v.created}`);
    console.log(`  Size    : ${sizeMiB} MiB`);
    if (containers.length > 0) {
      console.log(`  Used by : ${containers.map(c => c.name || c.id.slice(0, 12)).join(', ')}`);
    } else {
      console.log(`  Used by : (none)`);
    }
    if (Object.keys(v.labels || {}).length > 0) {
      console.log(`  Labels  : ${JSON.stringify(v.labels)}`);
    }
  }
}

// ── rm ────────────────────────────────────────────────────────────────────────

function rm(names, opts) {
  for (const name of names) {
    // Refuse to remove a volume that is in use by a running container
    if (!opts.force) {
      const inUse = Object.values(store.getContainers()).some(c =>
        c.status === 'running' && (c.volume || []).some(vs => vs.includes(name))
      );
      if (inUse) {
        console.error(chalk.red(
          `Volume ${name} is in use by a running container. Use -f to force.`
        ));
        continue;
      }
    }

    try {
      removeNamedVolume(name);
      console.log(name);
    } catch (err) {
      console.error(chalk.red(`Error removing ${name}: ${err.message}`));
    }
  }
}

// ── create ────────────────────────────────────────────────────────────────────

function create(name) {
  if (!name) { console.error(chalk.red('Name is required')); process.exit(1); }
  ensureNamedVolume(name);
  console.log(chalk.green(`Volume ${name} created`));
}

// ── prune ─────────────────────────────────────────────────────────────────────

function prune() {
  const vols = listNamedVolumes();
  const usedNames = new Set(
    Object.values(store.getContainers())
      .flatMap(c => (c.volume || []))
      .filter(vs => vs)
      // extract volume name from spec (first segment if it's a named volume)
      .map(vs => vs.split(':')[0])
  );

  let removed = 0;
  for (const v of vols) {
    if (!usedNames.has(v.name)) {
      try {
        removeNamedVolume(v.name);
        console.log(chalk.gray(`Removed: ${v.name}`));
        removed++;
      } catch {}
    }
  }
  console.log(chalk.green(`\nPruned ${removed} volume(s).`));
}

// ── helpers ───────────────────────────────────────────────────────────────────

function dirSize(dirPath) {
  let total = 0;
  if (!fs.existsSync(dirPath)) return 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = function volume(subcommand, args, opts) {
  switch (subcommand) {
    case 'ls':
    case 'list':
      ls();
      break;
    case 'inspect':
      if (args.length === 0) { console.error(chalk.red('volume inspect: name required')); process.exit(1); }
      inspect(args);
      break;
    case 'rm':
    case 'remove':
      if (args.length === 0) { console.error(chalk.red('volume rm: name required')); process.exit(1); }
      rm(args, opts);
      break;
    case 'create':
      create(args[0]);
      break;
    case 'prune':
      prune();
      break;
    default:
      console.error(chalk.red(`Unknown volume subcommand: "${subcommand}"`));
      console.error('  Available: ls, inspect, rm, create, prune');
      process.exit(1);
  }
};
