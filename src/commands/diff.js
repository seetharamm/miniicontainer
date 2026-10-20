'use strict';
/**
 * mydocker diff — inspect filesystem changes in a container's rootfs.
 * Walks the rootfs directory and compares mtime against the image unpack time.
 *
 * Output codes (Docker-compatible):
 *   A  added
 *   C  changed
 *   D  deleted  (detected via whiteout files: .wh.<name>)
 */
const chalk = require('chalk');
const path  = require('path');
const fs    = require('fs-extra');
const store = require('../state/store');

module.exports = function diff(container) {
  try {
    const c = store.getContainer(container);
    if (!c) throw new Error(`No such container: ${container}`);
    if (!c.rootfs || !fs.existsSync(c.rootfs)) {
      throw new Error(`Rootfs not found: ${c.rootfs}`);
    }

    const baseTime = c.startedAt ? new Date(c.startedAt).getTime() : 0;
    const changes  = [];

    function walk(dir, rel) {
      let entries;
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry);
        const relPath = rel ? `${rel}/${entry}` : entry;

        // Whiteout = deleted file in overlayfs
        if (entry.startsWith('.wh.')) {
          changes.push({ code: 'D', path: '/' + relPath.replace('.wh.', '') });
          continue;
        }

        let stat;
        try { stat = fs.statSync(full); } catch { continue; }

        if (stat.isDirectory()) {
          // Check if the dir itself was created after image unpack
          if (stat.mtimeMs > baseTime) changes.push({ code: 'A', path: '/' + relPath });
          walk(full, relPath);
        } else {
          const code = stat.mtimeMs > baseTime ? 'C' : 'A';
          changes.push({ code, path: '/' + relPath });
        }
      }
    }

    walk(c.rootfs, '');

    for (const { code, path: p } of changes.slice(0, 200)) {
      const colour = code === 'A' ? chalk.green : code === 'D' ? chalk.red : chalk.yellow;
      console.log(`${colour(code)} ${p}`);
    }
    if (changes.length > 200) {
      console.log(chalk.gray(`... and ${changes.length - 200} more`));
    }
  } catch (err) {
    console.error(chalk.red('Error:'), err.message);
    process.exit(1);
  }
};
