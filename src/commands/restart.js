'use strict';
/**
 * mydocker restart — stop then start a container.
 */
const chalk = require('chalk');
const { stopContainer } = require('../core/runtime');

module.exports = async function restart(containers, opts) {
  const stopCmd = require('./stop');
  const startCmd = require('./start');
  for (const id of containers) {
    try {
      await stopContainer(id, parseInt(opts.time, 10) || 10);
    } catch {}
    try {
      await startCmd([id]);
      console.log(id);
    } catch (err) {
      console.error(chalk.red(`Error restarting ${id}:`), err.message);
    }
  }
};
