'use strict';
/**
 * Port-forwarding engine.
 *
 * Responsibilities:
 *   1. Parse and validate "-p" specs (host:container/proto)
 *   2. Keep a persistent per-container rule table so rules survive restarts
 *      and can be listed/removed individually
 *   3. Install and remove the actual OS-level rules:
 *        Linux  → iptables DNAT  (TCP and UDP, PREROUTING + OUTPUT chains)
 *        Windows → netsh portproxy (TCP only; UDP proxy via socat if present)
 *
 * ── Port spec syntax ─────────────────────────────────────────────────────────
 *
 *   [hostIp:]hostPort:containerPort[/proto]
 *
 *   Examples:
 *     8080:80              → TCP  0.0.0.0:8080 → container:80
 *     8080:80/tcp          → TCP  0.0.0.0:8080 → container:80
 *     5353:53/udp          → UDP  0.0.0.0:5353 → container:53
 *     127.0.0.1:8080:80    → TCP  127.0.0.1:8080 → container:80
 *     8080:80/tcp+udp      → both TCP and UDP
 *
 * ── Persistent rule table ────────────────────────────────────────────────────
 *
 *   ~/.minicontainer/ports.json
 *   {
 *     "<containerId>": [
 *       { hostIp, hostPort, containerPort, proto, containerIp, active }
 *     ]
 *   }
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs-extra');
const chalk  = require('chalk');

const { IS_WINDOWS, IS_LINUX } = require('../utils/platform');
const { run } = require('../utils/exec');

const PORTS_DB = path.join(os.homedir(), '.minicontainer', 'ports.json');

// ── Rule parsing ──────────────────────────────────────────────────────────────

/**
 * Parse one or more port specs into normalised rule objects.
 *
 * @param {string|string[]} specs   e.g. "8080:80" or ["8080:80/tcp","5353:53/udp"]
 * @param {string}          containerIp
 * @returns {PortRule[]}
 *
 * @typedef {object} PortRule
 * @property {string}  hostIp         bind address on the host  (default "0.0.0.0")
 * @property {number}  hostPort
 * @property {number}  containerPort
 * @property {string}  proto          "tcp" | "udp" | "tcp+udp"
 * @property {string}  containerIp
 * @property {boolean} active
 */
function parsePortSpecs(specs, containerIp) {
  if (!specs) return [];
  const list = Array.isArray(specs) ? specs : [specs];
  const rules = [];

  for (const spec of list) {
    if (!spec || !spec.trim()) continue;

    // Split off /proto suffix
    let rest  = spec.trim();
    let proto = 'tcp';
    const slashIdx = rest.lastIndexOf('/');
    if (slashIdx !== -1) {
      proto = rest.slice(slashIdx + 1).toLowerCase();
      rest  = rest.slice(0, slashIdx);
    }
    if (!['tcp', 'udp', 'tcp+udp'].includes(proto)) {
      throw new Error(`Unknown protocol in port spec "${spec}" — use tcp, udp, or tcp+udp`);
    }

    // Split remaining into parts (up to 3 colon-separated segments)
    const parts = rest.split(':');
    let hostIp, hostPort, containerPort;

    if (parts.length === 1) {
      // Just a port number — same port on host and container
      hostIp        = '0.0.0.0';
      hostPort      = parseInt(parts[0], 10);
      containerPort = hostPort;
    } else if (parts.length === 2) {
      hostIp        = '0.0.0.0';
      hostPort      = parseInt(parts[0], 10);
      containerPort = parseInt(parts[1], 10);
    } else if (parts.length === 3) {
      hostIp        = parts[0] || '0.0.0.0';
      hostPort      = parseInt(parts[1], 10);
      containerPort = parseInt(parts[2], 10);
    } else {
      throw new Error(`Invalid port spec: "${spec}"`);
    }

    validatePort(hostPort,      `host port in "${spec}"`);
    validatePort(containerPort, `container port in "${spec}"`);

    rules.push({ hostIp, hostPort, containerPort, proto, containerIp, active: false });
  }

  return rules;
}

function validatePort(n, label) {
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid ${label}: ${n} — must be 1–65535`);
  }
}

// ── Persistent rule store ─────────────────────────────────────────────────────

function readDb() {
  if (!fs.existsSync(PORTS_DB)) return {};
  try { return JSON.parse(fs.readFileSync(PORTS_DB, 'utf8')); } catch { return {}; }
}

function writeDb(db) {
  const tmp = PORTS_DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, PORTS_DB);
}

function getRules(containerId) {
  return readDb()[containerId] || [];
}

function saveRules(containerId, rules) {
  const db = readDb();
  db[containerId] = rules;
  writeDb(db);
}

function clearRules(containerId) {
  const db = readDb();
  delete db[containerId];
  writeDb(db);
}

// ── Install forwarding rules ──────────────────────────────────────────────────

/**
 * Install OS-level port-forwarding rules for all rules in the list.
 * Updates the persistent rule table to mark each rule as active.
 *
 * @param {string}     containerId
 * @param {PortRule[]} rules
 */
async function installRules(containerId, rules) {
  if (!rules || rules.length === 0) return;

  const activated = [];

  for (const rule of rules) {
    const protos = rule.proto === 'tcp+udp' ? ['tcp', 'udp'] : [rule.proto];

    for (const p of protos) {
      if (IS_LINUX) {
        await installLinux(rule, p);
      } else if (IS_WINDOWS) {
        await installWindows(rule, p);
      }
    }

    console.log(chalk.gray(
      `  Port forward: ${rule.hostIp}:${rule.hostPort} → ` +
      `${rule.containerIp}:${rule.containerPort}/${rule.proto}`
    ));

    activated.push({ ...rule, active: true });
  }

  saveRules(containerId, activated);
  return activated;
}

/**
 * Remove OS-level port-forwarding rules for a container.
 * Reads the persistent table so it works even after a process restart.
 *
 * @param {string}      containerId
 * @param {PortRule[]}  [rules]   Defaults to all saved rules for this container
 */
async function removeRules(containerId, rules) {
  const saved = rules || getRules(containerId);
  if (!saved || saved.length === 0) return;

  for (const rule of saved) {
    const protos = rule.proto === 'tcp+udp' ? ['tcp', 'udp'] : [rule.proto];
    for (const p of protos) {
      if (IS_LINUX) {
        await removeLinux(rule, p);
      } else if (IS_WINDOWS) {
        await removeWindows(rule, p);
      }
    }
  }

  clearRules(containerId);
}

// ── Linux iptables ────────────────────────────────────────────────────────────

async function installLinux(rule, proto) {
  const dest = `${rule.containerIp}:${rule.containerPort}`;

  // PREROUTING: traffic arriving from the network (external clients)
  await iptablesEnsure('nat', 'PREROUTING', [
    '-p', proto,
    ...inInterface(rule.hostIp),
    '--dport', String(rule.hostPort),
    '-j', 'DNAT', '--to-destination', dest,
  ]);

  // OUTPUT: traffic from the host itself (curl localhost:hostPort)
  await iptablesEnsure('nat', 'OUTPUT', [
    '-p', proto,
    '-d', rule.hostIp === '0.0.0.0' ? '127.0.0.1' : rule.hostIp,
    '--dport', String(rule.hostPort),
    '-j', 'DNAT', '--to-destination', dest,
  ]);
}

async function removeLinux(rule, proto) {
  const dest = `${rule.containerIp}:${rule.containerPort}`;

  await run('iptables', [
    '-t', 'nat', '-D', 'PREROUTING',
    '-p', proto,
    ...inInterface(rule.hostIp),
    '--dport', String(rule.hostPort),
    '-j', 'DNAT', '--to-destination', dest,
  ]).catch(() => {});

  await run('iptables', [
    '-t', 'nat', '-D', 'OUTPUT',
    '-p', proto,
    '-d', rule.hostIp === '0.0.0.0' ? '127.0.0.1' : rule.hostIp,
    '--dport', String(rule.hostPort),
    '-j', 'DNAT', '--to-destination', dest,
  ]).catch(() => {});
}

/**
 * When hostIp is not 0.0.0.0, add -d <hostIp> to scope the rule.
 */
function inInterface(hostIp) {
  return hostIp && hostIp !== '0.0.0.0' ? ['-d', hostIp] : [];
}

/**
 * Add an iptables rule only if it does not already exist.
 */
async function iptablesEnsure(table, chain, args) {
  const check = await run('iptables', ['-t', table, '-C', chain, ...args])
    .catch(() => ({ code: 1 }));
  if (check.code !== 0) {
    await run('iptables', ['-t', table, '-A', chain, ...args]).catch(() => {});
  }
}

// ── Windows netsh + socat ─────────────────────────────────────────────────────

async function installWindows(rule, proto) {
  if (proto === 'tcp') {
    // netsh portproxy handles TCP natively
    await run('netsh', [
      'interface', 'portproxy', 'add', 'v4tov4',
      `listenport=${rule.hostPort}`,
      `listenaddress=${rule.hostIp === '0.0.0.0' ? '' : rule.hostIp}`,
      `connectport=${rule.containerPort}`,
      `connectaddress=${rule.containerIp}`,
    ]).catch(err => {
      console.warn(chalk.yellow(`  portproxy warning (${rule.hostPort}): ${err.message}`));
    });
  } else if (proto === 'udp') {
    // netsh portproxy does not support UDP.
    // If socat is available use it; otherwise warn.
    const socatAvailable = await run('where', ['socat'])
      .then(r => r.code === 0).catch(() => false);

    if (socatAvailable) {
      // Spawn a background socat relay: UDP4-RECVFROM → UDP4-SENDTO
      const { spawn } = require('child_process');
      spawn('socat', [
        `UDP4-RECVFROM:${rule.hostPort},fork`,
        `UDP4-SENDTO:${rule.containerIp}:${rule.containerPort}`,
      ], { detached: true, stdio: 'ignore' }).unref();
    } else {
      console.warn(chalk.yellow(
        `  UDP port forward ${rule.hostPort}→${rule.containerPort} skipped on Windows` +
        ` (install socat for UDP support)`
      ));
    }
  }
}

async function removeWindows(rule, proto) {
  if (proto === 'tcp') {
    await run('netsh', [
      'interface', 'portproxy', 'delete', 'v4tov4',
      `listenport=${rule.hostPort}`,
      `listenaddress=${rule.hostIp === '0.0.0.0' ? '' : rule.hostIp}`,
    ]).catch(() => {});
  }
  // UDP socat processes are not tracked — they exit when the host port is freed
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

/**
 * Return a formatted string listing all active port rules for a container.
 * Output format mirrors `docker port`:
 *
 *   80/tcp  → 0.0.0.0:8080
 *   53/udp  → 0.0.0.0:5353
 */
function formatRules(containerId) {
  const rules = getRules(containerId);
  if (rules.length === 0) return null;

  return rules
    .map(r => {
      const protos = r.proto === 'tcp+udp' ? ['tcp', 'udp'] : [r.proto];
      return protos.map(p =>
        `${String(r.containerPort).padEnd(5)}/${p}  →  ${r.hostIp}:${r.hostPort}`
      ).join('\n');
    })
    .join('\n');
}

/**
 * List all port-proxy rules currently active on Windows (netsh portproxy show all).
 */
async function showWindowsPortProxy() {
  const { run } = require('../utils/exec');
  const { stdout } = await run('netsh', ['interface', 'portproxy', 'show', 'all'])
    .catch(() => ({ stdout: '' }));
  return stdout;
}

module.exports = {
  parsePortSpecs,
  installRules,
  removeRules,
  getRules,
  formatRules,
  showWindowsPortProxy,
  PORTS_DB,
};
