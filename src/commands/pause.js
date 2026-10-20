'use strict';
/**
 * mydocker pause / unpause — suspend/resume container processes.
 * On Linux: sends SIGSTOP/SIGCONT to the container's init PID.
 * On Windows: uses NtSuspendProcess via taskkill approximation (not supported — informational).
 */
const chalk = require('chalk');
const store = require('../state/store');
const eventlog = require('../state/eventlog');
const { IS_LINUX } = require('../utils/platform');

async function pauseOrUnpause(containers, pause) {
  const signal = pause ? 'SIGSTOP' : 'SIGCONT';
  const action = pause ? 'pause' : 'unpause';

  for (const idOrName of containers) {
    try {
      const c = store.getContainer(idOrName);
      if (!c) throw new Error(`No such container: ${idOrName}`);
      if (c.status !== 'running' || !c.pid) {
        throw new Error(`Container ${c.id.slice(0, 12)} is not running`);
      }
      if (!IS_LINUX) {
        throw new Error(`${action} requires Linux (SIGSTOP/SIGCONT)`);
      }
      process.kill(c.pid, signal);

      const newStatus = pause ? 'paused' : 'running';
      store.saveContainer({ ...c, status: newStatus });
      if (pause) eventlog.container.pause(c.id, c.name);
      else       eventlog.container.unpause(c.id, c.name);
      console.log(c.id);
    } catch (err) {
      console.error(chalk.red(`Error ${action} ${idOrName}:`), err.message);
    }
  }
}

module.exports = {
  pause:   (containers) => pauseOrUnpause(containers, true),
  unpause: (containers) => pauseOrUnpause(containers, false),
};
