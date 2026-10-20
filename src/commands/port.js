'use strict';
/**
 * minicontainer port <container> [containerPort[/proto]]
 *
 * List or query the port mappings of a running container.
 *
 * Usage:
 *   minicontainer port myapi           → list all forwarded ports
 *   minicontainer port myapi 80        → show host binding for container port 80
 *   minicontainer port myapi 80/tcp    → same, explicit protocol
 *   minicontainer port myapi 53/udp    → UDP mapping
 *
 * Output format (matches `docker port`):
 *   80/tcp   →  0.0.0.0:8080
 *   53/udp   →  0.0.0.0:5353
 */

const chalk  = require('chalk');
const store  = require('../state/store');
const portmap = require('../network/portmap');
const { IS_WINDOWS } = require('../utils/platform');

module.exports = async function port(containerId, querySpec, opts) {
  const record = store.getContainer(containerId);
  if (!record) {
    console.error(chalk.red(`No such container: ${containerId}`));
    process.exit(1);
  }

  const rules = portmap.getRules(record.id);

  if (rules.length === 0) {
    // Container has no port mappings at all
    if (IS_WINDOWS) {
      // On Windows also show the global netsh table in case rules were added externally
      const proxy = await portmap.showWindowsPortProxy();
      if (proxy.trim()) {
        console.log(chalk.gray('netsh portproxy rules:\n') + proxy);
      } else {
        console.log(chalk.gray(`Container ${record.id.slice(0, 12)} has no port mappings`));
      }
    } else {
      console.log(chalk.gray(`Container ${record.id.slice(0, 12)} has no port mappings`));
    }
    return;
  }

  // Filter by querySpec if provided (e.g. "80" or "80/tcp")
  let filtered = rules;
  if (querySpec) {
    const [qPort, qProto] = querySpec.split('/');
    const qPortNum = parseInt(qPort, 10);
    filtered = rules.filter(r => {
      const portMatch  = r.containerPort === qPortNum;
      const protoMatch = !qProto || r.proto === qProto || r.proto === 'tcp+udp';
      return portMatch && protoMatch;
    });

    if (filtered.length === 0) {
      console.error(chalk.red(
        `Container ${record.id.slice(0, 12)} does not expose ${querySpec}`
      ));
      process.exit(1);
    }
  }

  // Print each rule, expanding tcp+udp into two lines
  for (const r of filtered) {
    const protos = r.proto === 'tcp+udp' ? ['tcp', 'udp'] : [r.proto];
    for (const p of protos) {
      const cPort = chalk.cyan(`${r.containerPort}/${p}`);
      const hBind = chalk.white(`${r.hostIp}:${r.hostPort}`);
      console.log(`${cPort.padEnd(14)}  →  ${hBind}`);
    }
  }
};
