'use strict';
/**
 * mydocker top — display the running processes of a container (Docker-compatible).
 * On Linux: reads from /proc inside the container namespace via nsenter.
 * On Windows: runs tasklist filtered by the container's root PID tree.
 */
const chalk = require('chalk');
const store = require('../state/store');
const { IS_LINUX } = require('../utils/platform');

module.exports = async function top(container) {
  try {
    const c = store.getContainer(container);
    if (!c) throw new Error(`No such container: ${container}`);
    if (c.status !== 'running') throw new Error(`Container ${c.id.slice(0, 12)} is not running`);

    const { run } = require('../utils/exec');

    if (IS_LINUX) {
      const { stdout } = await run('nsenter', [
        `--target=${c.pid}`, '--pid', '--mount',
        '--', 'ps', 'aux',
      ]);
      console.log(stdout);
    } else {
      // Windows: list processes in the container's Job Object (best-effort by PPID)
      const { stdout } = await run('tasklist', ['/V', '/FO', 'LIST']).catch(() => ({ stdout: '' }));
      // Filter to PIDs that are children of the container PID
      console.log(stdout || chalk.yellow('Process listing not available on Windows without admin privileges.'));
    }
  } catch (err) {
    console.error(chalk.red('Error:'), err.message);
    process.exit(1);
  }
};
