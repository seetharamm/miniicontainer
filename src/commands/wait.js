'use strict';
/**
 * mydocker wait — block until containers stop, print exit codes.
 */
const chalk = require('chalk');
const store = require('../state/store');

module.exports = async function wait(containers) {
  for (const idOrName of containers) {
    try {
      const c = store.getContainer(idOrName);
      if (!c) throw new Error(`No such container: ${idOrName}`);

      // Poll until the container exits
      await new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          const current = store.getContainer(c.id);
          if (!current || current.status !== 'running') {
            clearInterval(interval);
            resolve(current?.exitCode ?? 0);
          }
        }, 500);
        // Timeout after 24 hours (same as Docker default)
        setTimeout(() => { clearInterval(interval); resolve(124); }, 86_400_000);
      });

      const final = store.getContainer(c.id);
      console.log(final?.exitCode ?? 0);
    } catch (err) {
      console.error(chalk.red(`Error waiting for ${idOrName}:`), err.message);
    }
  }
};
