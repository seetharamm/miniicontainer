'use strict';
const chalk = require('chalk');
const { execInContainer } = require('../core/runtime');

module.exports = async function exec(containerId, cmdArgs, opts) {
  try {
    await execInContainer(containerId, cmdArgs);
  } catch (err) {
    console.error(chalk.red('exec failed:'), err.message);
    process.exit(1);
  }
};
