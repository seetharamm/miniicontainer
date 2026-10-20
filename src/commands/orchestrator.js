'use strict';

const chalk = require('chalk');
const orchestrator = require('../core/orchestrator');

module.exports = async function orchestratorCommand(subcommand, args, opts) {
  try {
    if (subcommand === 'node' && args[0] === 'register') {
      const node = orchestrator.registerNode({
        id: args[1], endpoint: opts.endpoint, capacity: opts.capacity,
        labels: opts.label ? Object.fromEntries(opts.label.map(v => v.split('='))) : {},
        token: opts.token,
      });
      console.log(JSON.stringify(node, null, 2));
      return;
    }
    if (subcommand === 'node' && args[0] === 'ls') {
      console.log(JSON.stringify(orchestrator.listNodes(), null, 2));
      return;
    }
    if (subcommand === 'monitor') {
      orchestrator.startHeartbeatMonitor({
        intervalMs: Number(opts.interval) * 1000,
        failureThreshold: Number(opts.threshold),
      });
      console.log(chalk.green('Heartbeat monitor started'));
      return;
    }
    if (subcommand === 'deploy') {
      const workload = JSON.parse(await require('fs-extra').readFile(args[0], 'utf8'));
      console.log(JSON.stringify(await orchestrator.deploy(workload), null, 2));
      return;
    }
    if (subcommand === 'service' && args[0] === 'ls') {
      console.log(JSON.stringify(orchestrator.getState().services || {}, null, 2));
      return;
    }
    if (subcommand === 'agent') {
      const server = orchestrator.createAgentServer({ host: opts.host, port: Number(opts.port), token: opts.token });
      server.listen(Number(opts.port), opts.host, () => console.log(chalk.green(`Orchestrator agent listening on ${opts.host}:${opts.port}`)));
      return;
    }
    throw new Error('Usage: orchestrator node register <id> --endpoint <url> | node ls | deploy <workload.json> | agent');
  } catch (err) {
    console.error(chalk.red('Error:'), err.message);
    process.exitCode = 1;
  }
};
