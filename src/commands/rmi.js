'use strict';
/**
 * mydocker rmi — remove one or more images.
 */
const chalk = require('chalk');
const store = require('../state/store');

module.exports = async function rmi(images, opts) {
  const { force = false } = opts;
  for (const ref of images) {
    try {
      // Check if any running container uses this image
      if (!force) {
        const containers = Object.values(store.getContainers());
        const inUse = containers.find(c => c.image === ref && c.status === 'running');
        if (inUse) throw new Error(`Image in use by container ${inUse.id.slice(0, 12)} (use -f to force)`);
      }
      store.deleteImage(ref);
      console.log(chalk.green(`Deleted: ${ref}`));
    } catch (err) {
      console.error(chalk.red(`Error removing ${ref}:`), err.message);
    }
  }
};
