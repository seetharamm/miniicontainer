'use strict';
/**
 * mydocker attach — attach terminal I/O to a running container.
 * On Linux: uses nsenter to join the container's namespaces.
 * On Windows: spawns an additional shell in the rootfs directory.
 */
const chalk = require('chalk');
const store = require('../state/store');
const { IS_LINUX } = require('../utils/platform');

module.exports = async function attach(container, opts) {
  try {
    const c = store.getContainer(container);
    if (!c) throw new Error(`No such container: ${container}`);
    if (c.status !== 'running') throw new Error(`Container ${c.id.slice(0, 12)} is not running`);

    const { runInteractive } = require('../utils/exec');

    if (IS_LINUX) {
      await runInteractive('nsenter', [
        `--target=${c.pid}`,
        '--pid', '--mount', '--uts', '--ipc', '--net',
        '--', 'sh',
      ]);
    } else {
      await runInteractive('cmd.exe', [], { cwd: c.rootfs });
    }
  } catch (err) {
    console.error(chalk.red('Error:'), err.message);
    process.exit(1);
  }
};
