'use strict';
/**
 * mydocker history — show the build history of an image.
 */
const chalk = require('chalk');
const store = require('../state/store');

module.exports = function history(imageRef, opts) {
  try {
    const img = store.getImage(imageRef);
    if (!img) throw new Error(`No such image: ${imageRef}`);

    const layers = img.layers || [];
    const { noTrunc = false, quiet = false } = opts;

    if (quiet) {
      for (const l of layers) {
        const d = typeof l === 'string' ? l : l.digest || '';
        console.log(noTrunc ? d : d.slice(0, 19));
      }
      return;
    }

    const cols = [
      { label: 'IMAGE',    width: 14 },
      { label: 'CREATED', width: 22 },
      { label: 'SIZE',    width: 12 },
      { label: 'DIGEST',  width: 22 },
    ];
    console.log(cols.map(c => c.label.padEnd(c.width)).join('  '));

    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      const digest = typeof l === 'string' ? l : (l.digest || '');
      const size   = typeof l === 'object' && l.size ? `${Math.round(l.size / 1024)} KB` : '';
      const id     = noTrunc ? digest : digest.replace('sha256:', '').slice(0, 12);
      const row = [
        id.padEnd(cols[0].width),
        (img.created || '').slice(0, 22).padEnd(cols[1].width),
        size.padEnd(cols[2].width),
        (noTrunc ? digest : digest.slice(0, 22)).padEnd(cols[3].width),
      ].join('  ');
      console.log(row);
    }
  } catch (err) {
    console.error(chalk.red('Error:'), err.message);
    process.exit(1);
  }
};
