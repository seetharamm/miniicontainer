'use strict';
/**
 * mydocker start — start a stopped container.
 * Reuses the runtime's run-from-existing-state path: re-spawns the container
 * process using the stored rootfs and command.
 */
const chalk = require('chalk');
const store = require('../state/store');
const { runContainer } = require('../core/runtime');

module.exports = async function start(containers) {
  for (const idOrName of containers) {
    try {
      const c = store.getContainer(idOrName);
      if (!c) throw new Error(`No such container: ${idOrName}`);
      if (c.status === 'running') {
        console.log(chalk.yellow(`Container ${c.id.slice(0, 12)} is already running`));
        continue;
      }
      // Re-run using the stored image + command
      await runContainer({
        image:     c.image,
        name:      c.name,
        cmd:       c.cmd       || [],
        env:       c.env       || [],
        volume:    c.volume    || [],
        port:      c.port      || [],
        detach:    true,
        memory:    c.cgroupLimits?.memory,
        cpus:      c.cgroupLimits?.cpus,
        pidsLimit: c.cgroupLimits?.pidsLimit,
        blkio:     c.cgroupLimits?.blkio,
      });
      console.log(idOrName);
    } catch (err) {
      console.error(chalk.red(`Error starting ${idOrName}:`), err.message);
    }
  }
};
