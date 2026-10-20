'use strict';
const chalk = require('chalk');
const { runContainer } = require('../core/runtime');

module.exports = async function run(image, cmdArgs, opts) {
  try {
    await runContainer({
      image,
      name:      opts.name,
      cmd:       cmdArgs,
      env:       opts.env      || [],
      volume:    opts.volume   || [],
      port:      opts.port     || [],
      detach:    !!opts.detach,
      rm:        !!opts.rm,
      memory:    opts.memory,
      cpus:      opts.cpus,
      pidsLimit: opts.pidsLimit,
      blkio:     opts.blkio,
      user:      opts.user,
    });
  } catch (err) {
    console.error(chalk.red('Error:'), err.message);
    process.exit(1);
  }
};
