'use strict';
const { table } = require('table');
const chalk     = require('chalk');
const store     = require('../state/store');

module.exports = function ps(opts) {
  const all = opts.all;
  const containers = Object.values(store.getContainers());

  const rows = containers
    .filter(c => all || c.status === 'running')
    .map(c => [
      chalk.cyan(c.id.slice(0, 12)),
      chalk.white(c.image),
      chalk.gray((c.cmd || []).join(' ').slice(0, 28) || '-'),
      statusBadge(c.status),
      chalk.gray(c.ip || '-'),
      c.created ? new Date(c.created).toLocaleString() : '-',
      chalk.white(c.name),
    ]);

  const header = [
    chalk.bold('CONTAINER ID'),
    chalk.bold('IMAGE'),
    chalk.bold('COMMAND'),
    chalk.bold('STATUS'),
    chalk.bold('IP'),
    chalk.bold('CREATED'),
    chalk.bold('NAMES'),
  ];

  console.log(table([header, ...rows], { border: borderStyle() }));
};

function statusBadge(status) {
  switch (status) {
    case 'running': return chalk.green('● running');
    case 'exited':  return chalk.gray('○ exited');
    case 'created': return chalk.yellow('◌ created');
    default:        return chalk.gray(status);
  }
}

function borderStyle() {
  return {
    topBody:    '─', topJoin:    '┬', topLeft:    '┌', topRight:    '┐',
    bottomBody: '─', bottomJoin: '┴', bottomLeft: '└', bottomRight: '┘',
    bodyLeft:   '│', bodyRight:  '│', bodyJoin:   '│',
    joinBody:   '─', joinLeft:   '├', joinRight:  '┤', joinJoin:    '┼',
  };
}
