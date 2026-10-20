'use strict';
/**
 * mydocker kill — send a signal to a running container.
 */
const chalk = require('chalk');
const store = require('../state/store');
const { IS_WINDOWS } = require('../utils/platform');

module.exports = async function kill(containers, opts) {
  const signal = (opts.signal || 'KILL').toUpperCase();
  for (const idOrName of containers) {
    try {
      const c = store.getContainer(idOrName);
      if (!c) throw new Error(`No such container: ${idOrName}`);
      if (c.status !== 'running' || !c.pid) {
        throw new Error(`Container ${c.id.slice(0, 12)} is not running`);
      }
      if (IS_WINDOWS) {
        const { run } = require('../utils/exec');
        await run('taskkill', ['/PID', String(c.pid), '/F']);
      } else {
        process.kill(c.pid, `SIG${signal}`);
      }
      console.log(c.id);
    } catch (err) {
      console.error(chalk.red(`Error killing ${idOrName}:`), err.message);
    }
  }
};
