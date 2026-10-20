'use strict';
/**
 * minicontainer network — manage virtual networks
 *
 * Subcommands:
 *   ls                      List all networks (always includes the built-in bridge)
 *   inspect <network>       Show network details and connected containers
 *   connect    <network> <container>   Allocate an IP for a container (state only; full veth on Linux)
 *   disconnect <network> <container>   Release the container's IP allocation
 *
 * Built-in networks  (always present, cannot be removed):
 *   bridge   — minicontainer0 (172.30.0.0/24)
 *   host     — shares host network stack
 *   none     — no networking
 */

const chalk    = require('chalk');
const path     = require('path');
const os       = require('os');
const fs       = require('fs-extra');
const store    = require('../state/store');
const netState = require('../network/state');
const bridge   = require('../network/bridge');
const eventlog = require('../state/eventlog');
const { IS_LINUX, IS_WINDOWS } = require('../utils/platform');

// ── Network DB ────────────────────────────────────────────────────────────────

const NET_CUSTOM_DB = path.join(os.homedir(), '.minicontainer', 'networks.json');

function readNetworks() {
  if (!fs.existsSync(NET_CUSTOM_DB)) return {};
  try { return JSON.parse(fs.readFileSync(NET_CUSTOM_DB, 'utf8')); }
  catch { return {}; }
}

function writeNetworks(data) {
  const tmp = NET_CUSTOM_DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, NET_CUSTOM_DB);
}

// Built-in network descriptors
function builtinNetworks() {
  const state = netState.readState();
  return {
    bridge: {
      id:      'bridge',
      name:    'bridge',
      driver:  'bridge',
      subnet:  state.subnet,
      gateway: state.gateway,
      scope:   'local',
      builtin: true,
    },
    host: {
      id:      'host',
      name:    'host',
      driver:  'host',
      subnet:  null,
      gateway: null,
      scope:   'local',
      builtin: true,
    },
    none: {
      id:      'none',
      name:    'none',
      driver:  'null',
      subnet:  null,
      gateway: null,
      scope:   'local',
      builtin: true,
    },
  };
}

function allNetworks() {
  return { ...builtinNetworks(), ...readNetworks() };
}

function getNetwork(nameOrId) {
  const nets = allNetworks();
  // Exact match
  if (nets[nameOrId]) return nets[nameOrId];
  // Prefix match on id
  const found = Object.values(nets).find(n => n.id.startsWith(nameOrId));
  return found || null;
}

// ── ls ────────────────────────────────────────────────────────────────────────

function networkLs() {
  const nets = allNetworks();
  const cols = [
    { label: 'NETWORK ID',  width: 12 },
    { label: 'NAME',        width: 18 },
    { label: 'DRIVER',      width: 10 },
    { label: 'SCOPE',       width: 8  },
    { label: 'SUBNET',      width: 20 },
  ];

  const header = cols.map(c => c.label.padEnd(c.width)).join('  ');
  console.log(chalk.bold(header));

  for (const net of Object.values(nets)) {
    const row = [
      net.id.slice(0, cols[0].width).padEnd(cols[0].width),
      net.name.padEnd(cols[1].width),
      (net.driver || '').padEnd(cols[2].width),
      (net.scope  || '').padEnd(cols[3].width),
      (net.subnet || '').padEnd(cols[4].width),
    ].join('  ');
    console.log(row);
  }
}

// ── inspect ───────────────────────────────────────────────────────────────────

function networkInspect(nameOrId) {
  const net = getNetwork(nameOrId);
  if (!net) throw new Error(`No such network: ${nameOrId}`);

  // Gather connected containers (containers whose ip is in the subnet)
  const containers = store.getContainers();
  const connected = [];
  const allocState = netState.readState();

  for (const [ip, cid] of Object.entries(allocState.allocations)) {
    const c = containers[cid];
    if (c) {
      connected.push({
        id:   cid.slice(0, 12),
        name: c.name || cid.slice(0, 12),
        ip,
      });
    }
  }

  console.log(JSON.stringify({
    ...net,
    containers: connected,
  }, null, 2));
}

// ── create ────────────────────────────────────────────────────────────────────

function networkCreate(name, opts = {}) {
  if (!name) throw new Error('Network name is required');
  const nets = allNetworks();
  if (nets[name]) throw new Error(`Network already exists: ${name}`);

  const { shortId } = require('../utils/ids');
  const id = shortId();

  const net = {
    id,
    name,
    driver:  opts.driver  || 'bridge',
    subnet:  opts.subnet  || null,
    gateway: opts.gateway || null,
    scope:   'local',
    builtin: false,
  };

  const custom = readNetworks();
  custom[name]  = net;
  writeNetworks(custom);
  eventlog.network.create(id, name);
  console.log(id);
}

// ── rm ────────────────────────────────────────────────────────────────────────

function networkRm(nameOrId) {
  const net = getNetwork(nameOrId);
  if (!net) throw new Error(`No such network: ${nameOrId}`);
  if (net.builtin) throw new Error(`Cannot remove built-in network: ${net.name}`);

  const custom = readNetworks();
  delete custom[net.name];
  writeNetworks(custom);
  eventlog.network.destroy(net.name);
  console.log(chalk.green(`Removed network: ${net.name}`));
}

// ── connect / disconnect ──────────────────────────────────────────────────────

async function networkConnect(nameOrId, containerNameOrId) {
  const net = getNetwork(nameOrId);
  if (!net) throw new Error(`No such network: ${nameOrId}`);

  const c = store.getContainer(containerNameOrId);
  if (!c) throw new Error(`No such container: ${containerNameOrId}`);

  if (net.name !== 'bridge') {
    // For non-bridge networks we just record the allocation in state
    console.log(chalk.yellow(`Warning: full veth wiring only supported for 'bridge' network`));
  }

  // Reuse an existing allocation so reconnecting a running container can
  // repair its veth without changing the address other containers use.
  const ip = netState.allocateIp(c.id);
  c.ip = ip;
  store.saveContainer(c);
  const existing = netState.getIp(c.id);
  if (existing && c.status !== 'running') {
    console.log(chalk.gray(`Container ${c.id.slice(0, 12)} already connected (${existing})`));
    return;
  }
  eventlog.network.connect(net.name, c.id);
  console.log(chalk.green(`Connected ${c.id.slice(0, 12)} to ${net.name} (${ip})`));

  // On Linux with a running container we can also wire the veth using the
  // allocation above, keeping the persisted address and interface in sync.
  if (IS_LINUX && c.status === 'running' && c.pid) {
    try {
      await bridge.connectContainer(c.id, c.pid, ip);
    } catch (err) {
      console.error(chalk.yellow(`  Note: veth wiring failed (container may not have a netns): ${err.message}`));
    }
  }
}

async function networkDisconnect(nameOrId, containerNameOrId) {
  const net = getNetwork(nameOrId);
  if (!net) throw new Error(`No such network: ${nameOrId}`);

  const c = store.getContainer(containerNameOrId);
  if (!c) throw new Error(`No such container: ${containerNameOrId}`);

  const freed = netState.freeIp(c.id);
  if (!freed) {
    console.log(chalk.yellow(`Container ${c.id.slice(0, 12)} is not connected to ${net.name}`));
    return;
  }

  if (IS_LINUX && net.name === 'bridge') {
    await bridge.disconnectContainer(c.id);
  }

  c.ip = null;
  store.saveContainer(c);
  eventlog.network.disconnect(net.name, c.id);
  console.log(chalk.green(`Disconnected ${c.id.slice(0, 12)} from ${net.name}`));
}

// ── prune ─────────────────────────────────────────────────────────────────────

function networkPrune() {
  const custom = readNetworks();
  const names  = Object.keys(custom);
  if (names.length === 0) {
    console.log('No unused custom networks to remove');
    return;
  }
  writeNetworks({});
  for (const n of names) console.log(`Removed: ${n}`);
}

// ── main command handler ──────────────────────────────────────────────────────

async function networkCommand(subcommand, args, opts) {
  switch (subcommand) {
    case 'ls':
    case 'list':
      networkLs();
      break;

    case 'inspect': {
      const name = args[0];
      if (!name) { console.error('Usage: minicontainer network inspect <network>'); process.exit(1); }
      networkInspect(name);
      break;
    }

    case 'create': {
      const name = args[0];
      if (!name) { console.error('Usage: minicontainer network create <name>'); process.exit(1); }
      networkCreate(name, opts);
      break;
    }

    case 'rm':
    case 'remove': {
      if (!args.length) { console.error('Usage: minicontainer network rm <network>'); process.exit(1); }
      for (const n of args) networkRm(n);
      break;
    }

    case 'connect': {
      const [network, container] = args;
      if (!network || !container) {
        console.error('Usage: minicontainer network connect <network> <container>');
        process.exit(1);
      }
      await networkConnect(network, container);
      break;
    }

    case 'disconnect': {
      const [network, container] = args;
      if (!network || !container) {
        console.error('Usage: minicontainer network disconnect <network> <container>');
        process.exit(1);
      }
      await networkDisconnect(network, container);
      break;
    }

    case 'prune':
      networkPrune();
      break;

    default:
      console.error(`Unknown network subcommand: ${subcommand}`);
      console.error('Available: ls, inspect, create, rm, connect, disconnect, prune');
      process.exit(1);
  }
}

module.exports = networkCommand;
module.exports.getNetwork      = getNetwork;
module.exports.allNetworks     = allNetworks;
module.exports.networkCreate   = networkCreate;
module.exports.networkRm       = networkRm;
module.exports.networkLs       = networkLs;
module.exports.networkInspect  = networkInspect;
module.exports.readNetworks    = readNetworks;
module.exports.writeNetworks   = writeNetworks;
module.exports.NET_CUSTOM_DB   = NET_CUSTOM_DB;
