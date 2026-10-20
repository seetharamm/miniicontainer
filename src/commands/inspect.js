'use strict';
const chalk = require('chalk');
const store = require('../state/store');

module.exports = function inspect(containerId) {
  const record = store.getContainer(containerId);
  if (!record) {
    console.error(chalk.red(`No such container: ${containerId}`));
    process.exit(1);
  }
  console.log(JSON.stringify(record, null, 2));
};
