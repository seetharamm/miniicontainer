'use strict';
/**
 * mydocker tag — create a new image reference pointing to an existing image.
 */
const chalk = require('chalk');
const store = require('../state/store');
const eventlog = require('../state/eventlog');

module.exports = function tag(source, target) {
  try {
    const src = store.getImage(source);
    if (!src) throw new Error(`No such image: ${source}`);

    // Clone the record under the new reference
    const newRecord = { ...src, ref: target, _taggedFrom: source };
    store.saveImage(newRecord);
    eventlog.image.tag(source, target);
    console.log(chalk.green(`Tagged ${source} → ${target}`));
  } catch (err) {
    console.error(chalk.red('Error:'), err.message);
    process.exit(1);
  }
};
