'use strict';
const chalk = require('chalk');
const { stopContainer } = require('../core/runtime');

module.exports = async function stop(containers, opts) {
  for (const id of containers) {
    try {
      await stopContainer(id, parseInt(opts.time, 10) || 10);
      console.log(id);
    } catch (err) {
      console.error(chalk.red(`Error stopping ${id}:`), err.message);
    }
  }
};
