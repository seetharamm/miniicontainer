'use strict';
const chalk  = require('chalk');
const fs     = require('fs-extra');
const store  = require('../state/store');
const { stopContainer } = require('../core/runtime');

module.exports = async function rm(containers, opts) {
  for (const id of containers) {
    try {
      const record = store.getContainer(id);
      if (!record) { console.error(chalk.red(`No such container: ${id}`)); continue; }

      if (record.status === 'running') {
        if (!opts.force) {
          console.error(chalk.red(`Container ${id} is running. Use -f to force remove.`));
          continue;
        }
        await stopContainer(id);
      }

      const cDir = store.containerDir(record.id);
      store.deleteContainer(id);
      await fs.remove(cDir);
      console.log(record.id);
    } catch (err) {
      console.error(chalk.red(`Error removing ${id}:`), err.message);
    }
  }
};
