'use strict';
/**
 * Virtual network bridge — provides internet connectivity to containers.
 *
 * ── Linux topology ────────────────────────────────────────────────────────
 *
 *   Internet
 *      │
 *   eth0 / ens3  (host physical NIC)
 *      │  ← MASQUERADE (iptables NAT)
 *   minicontainer0  172.30.0.1/24  (bridge)
 *      ├── veth_<id7>  ↔  eth0 @ 172.30.0.2  (container 1)
 *      ├── veth_<id7>  ↔  eth0 @ 172.30.0.3  (container 2)
 *      └── ...
 *
 *   iptables rules added:
 *     nat  POSTROUTING  -s 172.30.0.0/24  ! -o minicontainer0  -j MASQUERADE
 *     nat  PREROUTING   -p tcp --dport H  -j DNAT --to C:P    (port forwards)
 *     nat  OUTPUT       -p tcp --dport H  -j DNAT --to C:P    (host loopback)
 *     filter  FORWARD   -i minicontainer0 -j ACCEPT
 *     filter  FORWARD   -o minicontainer0 -j ACCEPT
 *
 * ── Windows topology ──────────────────────────────────────────────────────
 *
 *   Containers share the host network stack (no kernel netns).
 *   Port forwarding is done with `netsh interface portproxy`.
 *   DNS resolution works automatically via the host stack.
 *
 * ── Requirements ─────────────────────────────────────────────────────────
 *   Linux: CAP_NET_ADMIN  (root or sudo)
 *          ip, iptables, nsenter, mount
 *   Windows: Administrator (for netsh portproxy)
 */

'use strict';

const { IS_WINDOWS, IS_LINUX } = require('../utils/platform');
const { run }   = require('../utils/exec');
const netState  = require('./state');
const chalk     = require('chalk');

const BRIDGE_NAME  = 'minicontainer0';
const BRIDGE_CIDR  = '172.30.0.1/24';
const BRIDGE_IP    = '172.30.0.1';
const SUBNET       = '172.30.0.0/24';

// ── Bridge lifecycle ──────────────────────────────────────────────────────────

/**
 * Ensure the host bridge and all required iptables rules exist.
 * Idempotent — safe to call on every container start.
 */
async function ensureBridge() {
  if (!IS_LINUX) return;

  // 1. Enable IP forwarding and bridge netfilter inspection (kernel flags —
  // persist until reboot). The latter makes bridge-to-bridge isolation rules
  // effective on hosts where bridged packets bypass iptables by default.
  await run('sysctl', ['-w', 'net.ipv4.ip_forward=1']).catch(() => {});
  await run('sysctl', ['-w', 'net.bridge.bridge-nf-call-iptables=1']).catch(() => {});

  // 2. Create bridge if it does not exist
  const { stdout: linkOut } = await run('ip', ['link', 'show', BRIDGE_NAME])
    .catch(() => ({ stdout: '' }));

  if (!linkOut.includes(BRIDGE_NAME)) {
    await run('ip', ['link', 'add', BRIDGE_NAME, 'type', 'bridge']);
    await run('ip', ['addr', 'add', BRIDGE_CIDR, 'dev', BRIDGE_NAME]);
    await run('ip', ['link', 'set', BRIDGE_NAME, 'up']);
    console.log(chalk.gray(`  Bridge ${BRIDGE_NAME} (${BRIDGE_IP}) created`));
  }

  // 3. iptables: NAT masquerade for outbound internet access
  await ensureIptables('nat', 'POSTROUTING',
    ['-s', SUBNET, '!', '-o', BRIDGE_NAME, '-j', 'MASQUERADE']);

  // 4. Explicitly allow bridge-to-bridge traffic so isolated container
  // namespaces can communicate with each other.
  await ensureIptables('filter', 'FORWARD',
    ['-i', BRIDGE_NAME, '-o', BRIDGE_NAME, '-j', 'ACCEPT']);

  // 5. iptables: allow forwarding through the bridge (both directions)
  await ensureIptables('filter', 'FORWARD',
    ['-i', BRIDGE_NAME, '-j', 'ACCEPT']);
  await ensureIptables('filter', 'FORWARD',
    ['-o', BRIDGE_NAME, '-j', 'ACCEPT']);
}

/**
 * Add an iptables rule only if it does not already exist (-C check first).
 */
async function ensureIptables(table, chain, ruleArgs) {
  const checkResult = await run('iptables', ['-t', table, '-C', chain, ...ruleArgs])
    .catch(() => ({ code: 1 }));
  if (checkResult.code !== 0) {
    await run('iptables', ['-t', table, '-A', chain, ...ruleArgs]).catch(() => {});
  }
}

// ── Container network lifecycle ───────────────────────────────────────────────

/**
 * Wire a newly-spawned container into the bridge network.
 *
 * Call this AFTER the container process is running (pid is known) so we can
 * move the veth interface into the container's network namespace.
 *
 * Steps:
 *   1. Allocate a unique IP from the persistent pool
 *   2. Create a veth pair  (host-side: veth_<7chars>  container-side: eth0)
 *   3. Move container-side into the container's netns  (via pid)
 *   4. Attach host-side to the bridge
 *   5. Bring both interfaces up
 *   6. Assign the IP and default route inside the container netns
 *   7. Bring loopback up inside the container netns
 *
 * @param {string} containerId
 * @param {number} pid           PID of the container init process
 * @returns {string}             The IP assigned to the container
 */
async function connectContainer(containerId, pid, containerIp = null) {
  if (!IS_LINUX) return null;

  await ensureBridge();

  // Reuse the existing allocation when a container is attached explicitly.
  containerIp = containerIp || netState.allocateIp(containerId);
  const vethHost    = `veth${containerId.slice(0, 7)}`;   // max 15 chars for ifname
  const vethCont    = 'eth0';

  // Clean up any leftover veth from a previous failed start
  await run('ip', ['link', 'delete', vethHost]).catch(() => {});

  // 1. Create veth pair
  await run('ip', ['link', 'add', vethHost, 'type', 'veth', 'peer', 'name', vethCont]);

  // 2. Move container end into the container's network namespace
  await run('ip', ['link', 'set', vethCont, 'netns', String(pid)]);

  // 3. Attach host end to the bridge and bring it up
  await run('ip', ['link', 'set', vethHost, 'master', BRIDGE_NAME]);
  await run('ip', ['link', 'set', vethHost, 'up']);

  // 4. Configure the interface inside the container netns
  const ns = ['nsenter', `--target=${pid}`, '--net', '--'];

  await run(ns[0], [...ns.slice(1), 'ip', 'addr', 'add', `${containerIp}/24`, 'dev', vethCont]);
  await run(ns[0], [...ns.slice(1), 'ip', 'link', 'set', vethCont, 'up']);

  // 5. Add default route via the bridge gateway
  await run(ns[0], [...ns.slice(1), 'ip', 'route', 'add', 'default', 'via', BRIDGE_IP]);

  // 6. Bring loopback up (critical for apps that bind 127.0.0.1)
  await run(ns[0], [...ns.slice(1), 'ip', 'link', 'set', 'lo', 'up']);

  console.log(chalk.gray(`  Network: ${containerId.slice(0, 12)} → ${containerIp} (via ${BRIDGE_IP})`));
  return containerIp;
}

/**
 * Remove network resources for a stopped container.
 * Port-forwarding rules are managed separately by portmap.js — call
 * portmap.removeRules() before calling this function.
 */
async function disconnectContainer(containerId) {
  if (!IS_LINUX) return;

  // Delete the veth pair (deleting host-side cascades to container-side)
  const vethHost = `veth${containerId.slice(0, 7)}`;
  await run('ip', ['link', 'delete', vethHost]).catch(() => {});

  // Release IP back to the pool
  netState.freeIp(containerId);
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

/**
 * Print a summary of the current bridge state to stdout.
 * Useful for `minicontainer network ls` or debug output.
 */
async function showNetworkInfo() {
  if (!IS_LINUX) {
    console.log(chalk.yellow('Network isolation: Windows — containers share host network stack'));
    return;
  }

  const { stdout: bridgeOut } = await run('ip', ['addr', 'show', BRIDGE_NAME])
    .catch(() => ({ stdout: '' }));

  if (!bridgeOut) {
    console.log(chalk.gray(`Bridge ${BRIDGE_NAME}: not created yet`));
    return;
  }

  console.log(chalk.cyan(`\nBridge: ${BRIDGE_NAME}`));
  console.log(chalk.gray(bridgeOut.trim()));

  const state = netState.readState();
  const allocs = Object.entries(state.allocations);
  if (allocs.length > 0) {
    console.log(chalk.cyan('\nAllocations:'));
    for (const [ip, cid] of allocs) {
      console.log(chalk.gray(`  ${ip.padEnd(16)} → ${cid}`));
    }
  }
}

module.exports = {
  ensureBridge,
  connectContainer,
  disconnectContainer,
  showNetworkInfo,
  BRIDGE_NAME,
  BRIDGE_IP,
  SUBNET,
};
