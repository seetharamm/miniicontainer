'use strict';
/**
 * minicontainer stats [container...]
 *
 * Display a live snapshot of CPU, memory, and PID usage for one or more
 * running containers, read directly from cgroup accounting files.
 *
 * Output format (one line per container, refreshed every --interval seconds):
 *
 *   CONTAINER ID    NAME            CPU %    MEM USAGE / LIMIT    PIDS
 *   a1b2c3d4e5f6    mc_a1b2c3       12.4%    128 MiB / 256 MiB    8
 *   ...
 *
 * Flags:
 *   --no-stream        Print once and exit (default: stream every second)
 *   --interval <s>     Refresh interval in seconds (default: 1)
 */

'use strict';

const chalk = require('chalk');
const { table } = require('table');

const store   = require('../state/store');
const { Cgroup, NullCgroup } = require('../core/cgroups');
const { IS_LINUX } = require('../utils/platform');

module.exports = async function stats(containerIds, opts) {
  const noStream = opts.noStream || false;
  const interval = parseFloat(opts.interval || '1') * 1000;

  // Resolve which containers to show
  function resolveContainers() {
    const all = Object.values(store.getContainers())
      .filter(c => c.status === 'running');

    if (containerIds.length > 0) {
      return containerIds.map(id => {
        const c = store.getContainer(id);
        if (!c) { console.error(chalk.red(`No such container: ${id}`)); process.exit(1); }
        if (c.status !== 'running') {
          console.error(chalk.yellow(`Container ${id} is not running`));
          process.exit(1);
        }
        return c;
      });
    }
    return all;
  }

  if (!IS_LINUX) {
    console.log(chalk.yellow(
      'stats: cgroup accounting is only available on Linux.\n' +
      'On Windows containers share the host process table — use Task Manager.'
    ));
    process.exit(0);
  }

  async function snapshot(containers) {
    const rows = [];
    for (const c of containers) {
      const cg = buildCgroup(c);
      const s  = await cg.stats().catch(() => null);

      if (!s) {
        rows.push([
          chalk.cyan(c.id.slice(0, 12)),
          chalk.white(c.name.slice(0, 16)),
          chalk.gray('n/a'),
          chalk.gray('n/a'),
          chalk.gray('n/a'),
          chalk.gray(c.ip || '-'),
        ]);
        continue;
      }

      const memUsedMiB  = (s.memoryUsage / 1024 / 1024).toFixed(1);
      const memLimitMiB = s.memoryLimit ? (s.memoryLimit / 1024 / 1024).toFixed(0) + ' MiB' : '∞';
      const memStr      = `${memUsedMiB} MiB / ${memLimitMiB}`;

      // CPU % requires two samples; on first call we just show the cumulative usage
      const cpuStr = s.cpuQuota
        ? `${((s.cpuUsageUs / 1_000_000) * 100 / (s.cpuQuota / CFS_PERIOD_US)).toFixed(1)}%`
        : `${(s.cpuUsageUs / 1_000_000).toFixed(3)}s`;

      rows.push([
        chalk.cyan(c.id.slice(0, 12)),
        chalk.white(c.name.slice(0, 16)),
        chalk.yellow(cpuStr),
        chalk.green(memStr),
        chalk.white(String(s.pids || '-')),
        chalk.gray(c.ip || '-'),
      ]);
    }
    return rows;
  }

  const header = [
    chalk.bold('CONTAINER ID'),
    chalk.bold('NAME'),
    chalk.bold('CPU'),
    chalk.bold('MEM USAGE / LIMIT'),
    chalk.bold('PIDS'),
    chalk.bold('IP'),
  ];

  const containers = resolveContainers();
  if (containers.length === 0) {
    console.log(chalk.gray('No running containers.'));
    return;
  }

  async function print() {
    const rows  = await snapshot(containers);
    // Clear terminal lines for streaming mode
    if (!noStream) process.stdout.write('\x1B[2J\x1B[0f');
    console.log(table([header, ...rows]));
    if (!noStream) {
      console.log(chalk.gray('(Ctrl-C to stop)'));
    }
  }

  await print();
  if (noStream) return;

  const timer = setInterval(print, interval);
  process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
};

// ── helpers ───────────────────────────────────────────────────────────────────

const { detectVersion, CFS_PERIOD_US } = require('../core/cgroups');
const path = require('path');
const fs   = require('fs-extra');

/**
 * Reconstruct a Cgroup instance from a saved container record.
 * We don't re-create the cgroup — just point to its existing directory.
 */
function buildCgroup(record) {
  const version = detectVersion();
  if (!version) return new NullCgroup(record.id, {});

  // Reuse the Cgroup class constructor directly (no setup)
  const { Cgroup } = require('../core/cgroups');
  const cg = Object.create(Cgroup.prototype);
  cg.id      = record.id;
  cg.version = version;
  cg.limits  = record.cgroupLimits || {};

  const MC_SLICE = 'minicontainer';
  if (version === 2) {
    cg.cgDir = `/sys/fs/cgroup/${MC_SLICE}/${record.id}`;
  } else {
    cg.cgDirs = {
      memory: `/sys/fs/cgroup/memory/${MC_SLICE}/${record.id}`,
      cpu:    `/sys/fs/cgroup/cpu/${MC_SLICE}/${record.id}`,
      pids:   `/sys/fs/cgroup/pids/${MC_SLICE}/${record.id}`,
      blkio:  `/sys/fs/cgroup/blkio/${MC_SLICE}/${record.id}`,
    };
  }
  return cg;
}
