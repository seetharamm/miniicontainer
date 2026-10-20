'use strict';
/**
 * mydocker rename — rename a container.
 */
const chalk = require('chalk');
const store = require('../state/store');

module.exports = function rename(container, newName) {
  try {
    const c = store.getContainer(container);
    if (!c) throw new Error(`No such container: ${container}`);

    // Check new name is not already taken
    const existing = store.getContainer(newName);
    if (existing && existing.id !== c.id) {
      throw new Error(`Container name "${newName}" is already in use`);
    }

    store.saveContainer({ ...c, name: newName });
    console.log(c.id);
  } catch (err) {
    console.error(chalk.red('Error:'), err.message);
    process.exit(1);
  }
};
