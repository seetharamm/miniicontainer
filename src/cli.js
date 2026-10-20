'use strict';
/**
 * minicontainer CLI entry point.
 * Builds the Commander program from the shared command registry and parses argv.
 */

const pkg      = require('../package.json');
const registry = require('./cli-registry');

const program = registry.createProgram({
  name:        'minicontainer',
  description: 'A Docker-like container runtime built from scratch in Node.js',
  version:     pkg.version,
});

program.parse(process.argv);
