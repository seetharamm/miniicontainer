'use strict';
const { table } = require('table');
const chalk     = require('chalk');
const store     = require('../state/store');

module.exports = function images() {
  const imgs = Object.values(store.getImages());

  const header = [
    chalk.bold('REPOSITORY'),
    chalk.bold('TAG'),
    chalk.bold('IMAGE ID'),
    chalk.bold('CREATED'),
    chalk.bold('LAYERS'),
  ];

  const rows = imgs.map(img => [
    chalk.white(img.repo),
    chalk.cyan(img.tag),
    chalk.gray(img.id.slice(0, 12)),
    img.created ? new Date(img.created).toLocaleString() : '-',
    String(img.layerCount || 0),
  ]);

  console.log(table([header, ...rows]));
};
