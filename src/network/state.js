'use strict';
/**
 * Persistent network state — IP allocation table.
 *
 * Survives process restarts so that:
 *  - A running container's IP is not re-assigned to a new container.
 *  - `minicontainer ps` can show IPs correctly after a daemon restart.
 *
 * Stored in:  ~/.minicontainer/network.json
 *
 * Schema:
 * {
 *   "nextIp": 5,
 *   "subnet": "172.30.0.0/24",
 *   "bridge": "172.30.0.1",
 *   "allocations": {
 *     "172.30.0.2": "containerId",
 *     "172.30.0.3": "containerId2"
 *   }
 * }
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs-extra');

const NET_DB = path.join(os.homedir(), '.minicontainer', 'network.json');

const DEFAULTS = {
  nextIp:      2,      // .1 is the bridge itself
  subnet:      '172.30.0.0/24',
  bridge:      '172.30.0.1',
  gateway:     '172.30.0.1',
  allocations: {},
};

// ── read / write ─────────────────────────────────────────────────────────────

function readState() {
  if (!fs.existsSync(NET_DB)) return { ...DEFAULTS, allocations: {} };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(NET_DB, 'utf8')) };
  } catch {
    return { ...DEFAULTS, allocations: {} };
  }
}

function writeState(state) {
  const tmp = NET_DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, NET_DB);
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Allocate the next free IP in the subnet for a container.
 * The allocation is persisted immediately.
 *
 * @param {string} containerId
 * @returns {string}  e.g. "172.30.0.5"
 */
function allocateIp(containerId) {
  const state = readState();

  // Keep reconnects idempotent. This is important when a container is
  // attached to the bridge after its record has already been persisted.
  const existing = Object.entries(state.allocations)
    .find(([, id]) => id === containerId);
  if (existing) return existing[0];

  // Find a slot that is NOT already allocated (handles gaps from freed IPs)
  const usedIps = new Set(Object.keys(state.allocations));
  let counter = state.nextIp;

  while (true) {
    if (counter > 254) throw new Error('Subnet 172.30.0.0/24 exhausted — no free IPs');
    const candidate = `172.30.0.${counter}`;
    if (!usedIps.has(candidate)) {
      state.allocations[candidate] = containerId;
      state.nextIp = counter + 1;
      writeState(state);
      return candidate;
    }
    counter++;
  }
}

/**
 * Release the IP held by a container back to the pool.
 */
function freeIp(containerId) {
  const state = readState();
  for (const [ip, id] of Object.entries(state.allocations)) {
    if (id === containerId) {
      delete state.allocations[ip];
      writeState(state);
      return ip;
    }
  }
  return null;
}

/**
 * Look up the IP assigned to a container.
 */
function getIp(containerId) {
  const state = readState();
  return Object.entries(state.allocations).find(([, id]) => id === containerId)?.[0] || null;
}

/**
 * Return the bridge IP / gateway from the persistent config.
 */
function getGateway() {
  return readState().gateway;
}

/**
 * Return the full subnet CIDR.
 */
function getSubnet() {
  return readState().subnet;
}

module.exports = { allocateIp, freeIp, getIp, getGateway, getSubnet, readState };
