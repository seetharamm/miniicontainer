'use strict';
const chalk = require('chalk');
const { buildImage } = require('../image/builder');

module.exports = async function build(contextDir, opts) {
  try {
    await buildImage(contextDir, opts.tag);
  } catch (err) {
    console.error(chalk.red('Build failed:'), err.message);
    process.exit(1);
  }
};
