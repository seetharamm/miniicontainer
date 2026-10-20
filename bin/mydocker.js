#!/usr/bin/env node
'use strict';
/**
 * mydocker — Docker-compatible CLI alias for minicontainer.
 *
 * Identical command surface to `minicontainer` but presented under the
 * `mydocker` name so users can type exactly the Docker commands they know.
 *
 * Usage examples (all equivalent to their minicontainer counterparts):
 *   mydocker ps
 *   mydocker ps -a
 *   mydocker run -d -p 8080:80 nginx:latest
 *   mydocker stop <container>
 *   mydocker build -t myapp:latest .
 *   mydocker compose up -d
 *   mydocker system df
 *   mydocker --help
 *   mydocker --version
 */

const pkg      = require('../package.json');
const registry = require('../src/cli-registry');

const program = registry.createProgram({
  name:        'mydocker',
  description: 'Docker-compatible container runtime (powered by minicontainer)',
  version:     pkg.version,
});

program.parse(process.argv);
