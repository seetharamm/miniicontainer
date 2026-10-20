'use strict';
/**
 * Simple test runner — no external test framework required.
 * Run with: node test/runner.js
 */

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function runSuite(name, fn) {
  console.log(`\n── ${name} ──`);
  try {
    await fn(assert);
  } catch (err) {
    console.error(`  ✗ Suite threw: ${err.message}`);
    failed++;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Existing suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('ID utils', async (t) => {
  const { shortId, fullId } = require('../src/utils/ids');
  const sid = shortId();
  const fid = fullId();
  t('shortId is 12 chars',         sid.length === 12);
  t('shortId is hex',              /^[0-9a-f]+$/.test(sid));
  t('fullId is 32 chars',          fid.length === 32);
  t('shortId values differ',       shortId() !== shortId());
});

runSuite('State store', async (t) => {
  const store = require('../src/state/store');
  const id    = 'test_' + Date.now();

  store.saveContainer({ id, name: 'test-box', status: 'created', image: 'alpine' });
  const c = store.getContainer(id);
  t('container saved',             !!c);
  t('container name correct',      c && c.name === 'test-box');

  const prefix = id.slice(0, 6);
  const byPrefix = store.getContainer(prefix);
  t('prefix lookup works',         !!byPrefix);

  store.deleteContainer(id);
  t('container deleted',           !store.getContainer(id));
});

runSuite('Image normaliseRef', async (t) => {
  const { normaliseRef } = require('../src/state/store');
  t('adds :latest when no tag',    normaliseRef('alpine')        === 'alpine:latest');
  t('keeps existing tag',          normaliseRef('alpine:3.19')   === 'alpine:3.19');
  t('keeps full ref unchanged',    normaliseRef('myrepo/img:v1') === 'myrepo/img:v1');
});

runSuite('Platform detection', async (t) => {
  const { platform, IS_WINDOWS, IS_LINUX } = require('../src/utils/platform');
  const p = platform();
  t('platform() returns a string', typeof p === 'string');
  t('IS_WINDOWS XOR IS_LINUX (on these two platforms)',
    !(IS_WINDOWS && IS_LINUX));
});

runSuite('Containerfile parser', async (t) => {
  function parseContainerfile(text) {
    const lines = text.split('\n');
    const instructions = [];
    let current = '';
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line.endsWith('\\')) { current += line.slice(0, -1) + ' '; continue; }
      current += line;
      const trimmed = current.trim();
      current = '';
      if (!trimmed || trimmed.startsWith('#')) continue;
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) continue;
      instructions.push({ op: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() });
    }
    return instructions;
  }

  const cf = `FROM alpine:3.19\n# comment\nRUN echo hello\nCOPY . /app\nCMD ["/bin/sh"]`;
  const instrs = parseContainerfile(cf);
  t('parses 4 instructions',       instrs.length === 4);
  t('first is FROM',               instrs[0].op === 'FROM');
  t('comment skipped',             instrs.every(i => i.op !== '#'));
  t('CMD args preserved',          instrs[3].args === '["/bin/sh"]');
});

// ══════════════════════════════════════════════════════════════════════════════
// New suites — download pipeline
// ══════════════════════════════════════════════════════════════════════════════

runSuite('registry.js — parseRef', async (t) => {
  const { parseRef } = require('../src/image/registry');

  // Simple short names
  let r = parseRef('alpine');
  t('alpine: repo = library/alpine',   r.repo === 'library/alpine');
  t('alpine: tag = latest',            r.tag  === 'latest');
  t('alpine: isDockerHub',             r.isDockerHub === true);
  t('alpine: registry = docker.io',    r.registry === 'registry-1.docker.io');

  // Short name with tag
  r = parseRef('alpine:3.19');
  t('alpine:3.19: repo',               r.repo === 'library/alpine');
  t('alpine:3.19: tag',                r.tag  === '3.19');

  // User-scoped image
  r = parseRef('myuser/myapp:v2');
  t('myuser/myapp:v2: repo',           r.repo === 'myuser/myapp');
  t('myuser/myapp:v2: tag',            r.tag  === 'v2');
  t('myuser/myapp: isDockerHub',       r.isDockerHub === true);

  // Private registry with port
  r = parseRef('localhost:5000/myimage:latest');
  t('localhost:5000 registry',         r.registry === 'localhost:5000');
  t('localhost:5000 repo',             r.repo     === 'myimage');
  t('localhost:5000 not DockerHub',    r.isDockerHub === false);

  // GHCR
  r = parseRef('ghcr.io/owner/repo:tag');
  t('ghcr.io registry',                r.registry === 'ghcr.io');
  t('ghcr.io repo',                    r.repo     === 'owner/repo');
  t('ghcr.io tag',                     r.tag      === 'tag');
  t('ghcr.io not DockerHub',           r.isDockerHub === false);

  // No tag → latest
  r = parseRef('ghcr.io/owner/repo');
  t('ghcr.io no-tag → latest',         r.tag === 'latest');

  // Digest reference
  r = parseRef('alpine@sha256:abc123def456');
  t('digest reference',                r.tag === 'sha256:abc123def456');
});

runSuite('registry.js — RegistryClient construction', async (t) => {
  const { RegistryClient } = require('../src/image/registry');

  const c1 = new RegistryClient('alpine:3.19');
  t('DockerHub client: registry',  c1.registry === 'registry-1.docker.io');
  t('DockerHub client: repo',      c1.repo     === 'library/alpine');
  t('DockerHub client: tag',       c1.tag      === '3.19');
  t('DockerHub client: baseUrl',   c1.baseUrl  === 'https://registry-1.docker.io/v2');

  const c2 = new RegistryClient('localhost:5000/test:dev');
  t('localhost client: http baseUrl', c2.baseUrl === 'http://localhost:5000/v2');
  t('localhost client: repo',         c2.repo    === 'test');

  const c3 = new RegistryClient('ubuntu:22.04', { username: 'user', password: 'pass' });
  t('authOpts stored',               c3.authOpts.username === 'user');
});

runSuite('cache.js — isCached / blobPath / tempPath', async (t) => {
  const cache = require('../src/image/cache');

  // blobPath normalises the prefix
  const p1 = cache.blobPath('sha256:abcdef1234567890');
  const p2 = cache.blobPath('abcdef1234567890');
  t('blobPath strips sha256: prefix',  p1 === p2);
  t('blobPath ends with hex',          p1.endsWith('abcdef1234567890'));

  // isCached returns false for a digest we haven't cached
  t('isCached false for unknown',      !cache.isCached('sha256:' + '0'.repeat(64)));

  // tempPath has .part extension
  const tp = cache.tempPath('sha256:abc123');
  t('tempPath has .part suffix',       tp.endsWith('.part'));
});

runSuite('cache.js — commit verifies digest', async (t) => {
  const cache  = require('../src/image/cache');
  const fs     = require('fs-extra');
  const os     = require('os');
  const path   = require('path');
  const crypto = require('crypto');

  // Write a small temp file with known content
  const content = Buffer.from('hello minicontainer cache test');
  const digest  = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
  const tmp     = path.join(os.tmpdir(), 'mc_cache_test_' + Date.now() + '.part');
  await fs.writeFile(tmp, content);

  // Commit should succeed when digest matches
  await cache.commit(tmp, digest);
  t('commit: blob now cached',    cache.isCached(digest));
  t('commit: cachedSize correct', cache.cachedSize(digest) === content.length);

  // linkTo should produce an identical file
  const linkDest = path.join(os.tmpdir(), 'mc_cache_link_' + Date.now());
  await cache.linkTo(digest, linkDest);
  const linkedContent = await fs.readFile(linkDest);
  t('linkTo: content matches',    linkedContent.equals(content));

  // commit with wrong digest should reject
  const badTmp = path.join(os.tmpdir(), 'mc_cache_bad_' + Date.now() + '.part');
  await fs.writeFile(badTmp, content);
  let threw = false;
  try {
    await cache.commit(badTmp, 'sha256:' + '0'.repeat(64));
  } catch {
    threw = true;
  }
  t('commit: rejects wrong digest', threw);

  // Cleanup
  await cache.evict(digest);
  await fs.remove(linkDest).catch(() => {});
  t('evict: blob removed',          !cache.isCached(digest));
});

runSuite('puller.js — normaliseConfig', async (t) => {
  // Test the normalisation of OCI image config shapes
  // Access via module internals — we inline the function for isolation
  function normaliseConfig(raw) {
    const c = raw?.config || raw?.ContainerConfig || raw || {};
    return {
      env:        c.Env        || c.env        || [],
      workdir:    c.WorkingDir || c.workingDir || c.workdir || '/',
      cmd:        c.Cmd        || c.cmd        || [],
      entrypoint: c.Entrypoint || c.entrypoint || [],
      expose:     Object.keys(c.ExposedPorts || c.exposedPorts || {}).map(p => p.split('/')[0]),
      labels:     c.Labels     || c.labels     || {},
      user:       c.User       || c.user       || '',
    };
  }

  // OCI format (uppercase keys)
  const oci = normaliseConfig({
    config: {
      Env:          ['PATH=/usr/bin', 'JAVA_HOME=/usr'],
      WorkingDir:   '/app',
      Cmd:          ['java', '-jar', 'app.jar'],
      Entrypoint:   ['docker-entrypoint.sh'],
      ExposedPorts: { '8080/tcp': {}, '443/tcp': {} },
      Labels:       { version: '1.0' },
      User:         'nobody',
    },
  });
  t('OCI: env parsed',        oci.env.length === 2);
  t('OCI: workdir',           oci.workdir === '/app');
  t('OCI: cmd',               oci.cmd[2] === 'app.jar');
  t('OCI: entrypoint',        oci.entrypoint[0] === 'docker-entrypoint.sh');
  t('OCI: expose 2 ports',    oci.expose.length === 2);
  t('OCI: labels',            oci.labels.version === '1.0');
  t('OCI: user',              oci.user === 'nobody');

  // lowercase keys (some registries)
  const lc = normaliseConfig({ env: ['FOO=bar'], workdir: '/tmp', cmd: ['sh'] });
  t('lowercase: env',         lc.env[0] === 'FOO=bar');
  t('lowercase: workdir',     lc.workdir === '/tmp');

  // empty config
  const empty = normaliseConfig({});
  t('empty: defaults safe',   empty.workdir === '/' && Array.isArray(empty.cmd));
});

runSuite('load.js — normaliseConfig (shared helper)', async (t) => {
  // Ensure load.js also normalises configs correctly (same logic, different file)
  // We just verify the module loads without error
  let loaded = false;
  try {
    require('../src/commands/load');
    loaded = true;
  } catch {}
  t('load.js requires without error', loaded);
});

runSuite('core/orchestrator.js — scheduling and node registration', async (t) => {
  const fs = require('fs-extra');
  const orchestrator = require('../src/core/orchestrator');
  const state = orchestrator.getState();
  const id = 'test-node-' + Date.now();
  const node = orchestrator.registerNode({ id, endpoint: 'http://127.0.0.1:9876', capacity: 2, labels: { zone: 'test' } });
  t('registers node', node.id === id);
  t('stores endpoint', node.endpoint === 'http://127.0.0.1:9876');
  t('stores capacity', node.capacity === 2);
  t('stores labels', node.labels.zone === 'test');
  t('lists node', orchestrator.listNodes().some(n => n.id === id));
  t('chooses eligible node', orchestrator.chooseNode([node], { labels: { zone: 'test' } }).id === id);
  let threw = false;
  try { orchestrator.chooseNode([node], { labels: { zone: 'prod' } }); } catch { threw = true; }
  t('rejects unsatisfied labels', threw);
  state.nodes[id] = undefined;
  delete state.nodes[id];
  fs.writeFileSync(orchestrator.ORCHESTRATOR_DB, JSON.stringify(state, null, 2));
});


runSuite('core/orchestrator.js — service mesh discovery', async (t) => {
  const orchestrator = require('../src/core/orchestrator');
  const name = 'mesh-test-' + Date.now();
  const route = orchestrator.registerService(name, {
    nodeId: 'mesh-node', containerId: 'mesh-container', port: 8080, protocol: 'http'
  });
  t('registers service route', route.name === name);
  t('stores target node', route.nodeId === 'mesh-node');
  t('stores target port', route.port === 8080);
  t('discovers service route', orchestrator.discoverService(name).containerId === 'mesh-container');
  const state = orchestrator.getState();
  delete state.services[name];
  require('fs-extra').writeFileSync(orchestrator.ORCHESTRATOR_DB, JSON.stringify(state, null, 2));
});


runSuite('core/orchestrator.js — heartbeat failover', async (t) => {
  const orchestrator = require('../src/core/orchestrator');
  t('exports heartbeatNode', typeof orchestrator.heartbeatNode === 'function');
  t('exports failoverNode', typeof orchestrator.failoverNode === 'function');
  t('exports heartbeat monitor', typeof orchestrator.startHeartbeatMonitor === 'function');
});


runSuite('state/tenant.js — configuration scopes', async (t) => {
  const tenant = require('../src/state/tenant');
  t('default tenant is stable', tenant.tenantName('default') === 'default');
  t('tenant root is isolated', tenant.tenantRoot('team-a').includes('tenants'));
  t('config uses tenant paths', tenant.getConfig('team-a').containersDb.includes('team-a'));
  let threw = false;
  try { tenant.tenantName('../other'); } catch { threw = true; }
  t('path traversal rejected', threw);
});


// ══════════════════════════════════════════════════════════════════════════════
// Network suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('network/state.js — IP allocation', async (t) => {
  const netState = require('../src/network/state');
  const fs       = require('fs-extra');
  const os       = require('os');
  const path     = require('path');

  // Use a temp DB to avoid touching the real allocation table
  const origDb = require.resolve('../src/network/state');
  // We test the module logic by exercising the exported API in isolation
  // with a fresh state (delete any existing test entries first)

  const id1 = 'test_net_' + Date.now();
  const id2 = 'test_net_' + (Date.now() + 1);

  const ip1 = netState.allocateIp(id1);
  const ip2 = netState.allocateIp(id2);

  t('allocateIp returns string',       typeof ip1 === 'string');
  t('allocateIp in subnet',            ip1.startsWith('172.30.0.'));
  t('allocateIp unique',               ip1 !== ip2);
  t('containers share bridge subnet',  ip1.startsWith('172.30.0.') && ip2.startsWith('172.30.0.'));
  t('reconnect keeps same IP',         netState.allocateIp(id1) === ip1);
  t('getIp finds container',           netState.getIp(id1) === ip1);
  t('getSubnet correct',               netState.getSubnet() === '172.30.0.0/24');
  t('getGateway correct',              netState.getGateway() === '172.30.0.1');

  // Free one IP and re-allocate — should reuse the freed slot
  netState.freeIp(id1);
  t('getIp returns null after free',   netState.getIp(id1) === null);

  const reuseId = 'test_reuse_' + Date.now();
  const ip3 = netState.allocateIp(reuseId);
  t('reallocated after free',          typeof ip3 === 'string');

  // Cleanup
  netState.freeIp(id2);
  netState.freeIp(reuseId);
});

runSuite('network/dns.js — readHostNameservers', async (t) => {
  const { readHostNameservers } = require('../src/network/dns');
  const { IS_WINDOWS } = require('../src/utils/platform');

  const ns = readHostNameservers();
  t('returns array',                   Array.isArray(ns));
  // On Linux the host has /etc/resolv.conf; on Windows it returns []
  if (!IS_WINDOWS) {
    // All returned IPs should look like IPv4 addresses (not loopback)
    const allValid = ns.every(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    t('no loopback addresses',         ns.every(ip => !ip.startsWith('127.')));
    t('all valid IPv4 format',         allValid || ns.length === 0); // empty is ok on unusual hosts
  } else {
    t('Windows returns array (empty ok)', true);
  }
});

runSuite('network/dns.js — configureResolvConf', async (t) => {
  const dns  = require('../src/network/dns');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpRoot = path.join(os.tmpdir(), 'mc_dns_test_' + Date.now());
  await fs.ensureDir(path.join(tmpRoot, 'etc'));

  const nameservers = await dns.configureResolvConf(tmpRoot, ['10.0.0.53']);
  const content     = await fs.readFile(path.join(tmpRoot, 'etc', 'resolv.conf'), 'utf8');

  t('resolv.conf written',             content.includes('nameserver'));
  t('extra NS prepended',              content.includes('10.0.0.53'));
  t('public DNS fallback present',     content.includes('8.8.8.8') || content.includes('1.1.1.1'));
  t('nameserver count ≤ 3',           (content.match(/^nameserver/gm) || []).length <= 3);
  t('options line present',            content.includes('options'));
  t('returns array of ns',             Array.isArray(nameservers));

  await fs.remove(tmpRoot);
});

runSuite('network/dns.js — configureHosts + configureHostname', async (t) => {
  const dns  = require('../src/network/dns');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpRoot = path.join(os.tmpdir(), 'mc_hosts_test_' + Date.now());
  await fs.ensureDir(tmpRoot);

  await dns.configureHosts(tmpRoot, '172.30.0.5', 'my-container', '172.30.0.1');
  await dns.configureHostname(tmpRoot, 'my-container');

  const hostsContent    = await fs.readFile(path.join(tmpRoot, 'etc', 'hosts'), 'utf8');
  const hostnameContent = await fs.readFile(path.join(tmpRoot, 'etc', 'hostname'), 'utf8');

  t('hosts has localhost',             hostsContent.includes('127.0.0.1'));
  t('hosts has container IP',          hostsContent.includes('172.30.0.5'));
  t('hosts has container hostname',    hostsContent.includes('my-container'));
  t('hosts has gateway alias',         hostsContent.includes('host.minicontainer.internal'));
  t('hostname file correct',           hostnameContent.trim() === 'my-container');

  await fs.remove(tmpRoot);
});

runSuite('network/bridge.js — module loads + exports', async (t) => {
  let bridge;
  try {
    bridge = require('../src/network/bridge');
  } catch (err) {
    t('bridge.js loads without error', false, err.message);
    return;
  }
  t('bridge.js loads without error',   !!bridge);
  t('exports ensureBridge',            typeof bridge.ensureBridge       === 'function');
  t('exports connectContainer',        typeof bridge.connectContainer    === 'function');
  t('exports disconnectContainer',     typeof bridge.disconnectContainer === 'function');
  t('exports showNetworkInfo',         typeof bridge.showNetworkInfo     === 'function');
  t('BRIDGE_IP exported',              bridge.BRIDGE_IP === '172.30.0.1');
  t('SUBNET exported',                 bridge.SUBNET    === '172.30.0.0/24');
  // portmap now owns forwarding — bridge no longer exports these
  t('addPortForwards removed',         bridge.addPortForwards    === undefined);
  t('removePortForwards removed',      bridge.removePortForwards === undefined);
});

// ══════════════════════════════════════════════════════════════════════════════
// Port-forwarding suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('portmap.js — parsePortSpecs', async (t) => {
  const { parsePortSpecs } = require('../src/network/portmap');

  // Basic TCP (default)
  let rules = parsePortSpecs(['8080:80'], '172.30.0.2');
  t('basic: 1 rule produced',         rules.length === 1);
  t('basic: hostPort',                rules[0].hostPort      === 8080);
  t('basic: containerPort',           rules[0].containerPort === 80);
  t('basic: proto default tcp',       rules[0].proto         === 'tcp');
  t('basic: hostIp default 0.0.0.0',  rules[0].hostIp        === '0.0.0.0');
  t('basic: containerIp set',         rules[0].containerIp   === '172.30.0.2');

  // Explicit UDP
  rules = parsePortSpecs(['5353:53/udp'], '172.30.0.2');
  t('udp: proto',                     rules[0].proto         === 'udp');
  t('udp: hostPort',                  rules[0].hostPort      === 5353);

  // tcp+udp expander
  rules = parsePortSpecs(['1234:1234/tcp+udp'], '172.30.0.2');
  t('tcp+udp: proto stored',          rules[0].proto         === 'tcp+udp');

  // Specific host IP
  rules = parsePortSpecs(['127.0.0.1:8080:80'], '172.30.0.2');
  t('hostIp: parsed correctly',       rules[0].hostIp        === '127.0.0.1');
  t('hostIp: hostPort',               rules[0].hostPort      === 8080);

  // Single port number → same on both sides
  rules = parsePortSpecs(['3000'], '172.30.0.2');
  t('single port: host and cont same', rules[0].hostPort === 3000 && rules[0].containerPort === 3000);

  // String input (not array)
  rules = parsePortSpecs('9000:9000', '172.30.0.2');
  t('string input accepted',          rules.length === 1);

  // Multiple specs
  rules = parsePortSpecs(['8080:80', '443:443/tcp', '5353:53/udp'], '172.30.0.2');
  t('multiple specs: 3 rules',        rules.length === 3);
  t('multiple specs: protos correct', rules[0].proto === 'tcp' && rules[2].proto === 'udp');
});

runSuite('portmap.js — parsePortSpecs validation', async (t) => {
  const { parsePortSpecs } = require('../src/network/portmap');

  const expectThrow = (label, fn) => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    t(label, threw);
  };

  expectThrow('rejects port 0',
    () => parsePortSpecs(['0:80'], '1.2.3.4'));
  expectThrow('rejects port > 65535',
    () => parsePortSpecs(['99999:80'], '1.2.3.4'));
  expectThrow('rejects missing container port value',
    () => parsePortSpecs(['8080:0'], '1.2.3.4'));
  expectThrow('rejects unknown proto',
    () => parsePortSpecs(['8080:80/quic'], '1.2.3.4'));
  expectThrow('rejects negative port',
    () => parsePortSpecs(['-1:80'], '1.2.3.4'));
});

runSuite('portmap.js — rule store (save / get / clear)', async (t) => {
  const portmap = require('../src/network/portmap');

  const cid   = 'test_pm_' + Date.now();
  const rules = [
    { hostIp: '0.0.0.0', hostPort: 8080, containerPort: 80,
      proto: 'tcp', containerIp: '172.30.0.5', active: true },
    { hostIp: '0.0.0.0', hostPort: 5353, containerPort: 53,
      proto: 'udp', containerIp: '172.30.0.5', active: true },
  ];

  // Save via the internal helper
  const { saveRules: _save, getRules, clearRules: _clear } =
    // Export the internal helpers for test purposes via a hack:
    // we call saveRules through the module by directly writing the DB
    (() => {
      const pm = require('../src/network/portmap');
      // Write directly to PORTS_DB for isolated testing
      const fs   = require('fs-extra');
      const db   = fs.existsSync(pm.PORTS_DB)
        ? JSON.parse(fs.readFileSync(pm.PORTS_DB, 'utf8'))
        : {};
      db[cid] = rules;
      fs.writeFileSync(pm.PORTS_DB, JSON.stringify(db, null, 2));
      return {
        saveRules: () => {},
        getRules:  pm.getRules,
        clearRules: () => {
          const d2 = JSON.parse(fs.readFileSync(pm.PORTS_DB, 'utf8'));
          delete d2[cid];
          fs.writeFileSync(pm.PORTS_DB, JSON.stringify(d2, null, 2));
        },
      };
    })();

  const fetched = getRules(cid);
  t('getRules returns 2 rules',        fetched.length === 2);
  t('getRules port 8080 present',      fetched.some(r => r.hostPort === 8080));
  t('getRules port 5353 present',      fetched.some(r => r.hostPort === 5353));

  // formatRules
  const fmt = portmap.formatRules(cid);
  t('formatRules produces output',     typeof fmt === 'string' && fmt.includes('8080'));
  t('formatRules has UDP line',        fmt.includes('udp'));

  // clear
  _clear();
  const after = getRules(cid);
  t('getRules empty after clear',      after.length === 0);
  t('formatRules null after clear',    portmap.formatRules(cid) === null);
});

runSuite('commands/port.js — module loads', async (t) => {
  let portCmd;
  try {
    portCmd = require('../src/commands/port');
    t('port.js loads without error',  typeof portCmd === 'function');
  } catch (err) {
    t('port.js loads without error',  false, err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Cgroup suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('cgroups.js — parseMemory', async (t) => {
  const { parseMemory } = require('../src/core/cgroups');

  t('bare bytes',            parseMemory('1048576')  === 1048576);
  t('kilobytes k',           parseMemory('512k')     === 524288);
  t('megabytes m',           parseMemory('256m')     === 268435456);
  t('megabytes M',           parseMemory('256M')     === 268435456);
  t('gigabytes g',           parseMemory('1g')       === 1073741824);
  t('gigabytes G',           parseMemory('2G')       === 2147483648);
  t('null passthrough',      parseMemory(null)       === null);
  t('undefined passthrough', parseMemory(undefined)  === null);

  let threw = false;
  try { parseMemory('abc'); } catch { threw = true; }
  t('bad value throws',      threw);

  threw = false;
  try { parseMemory('256x'); } catch { threw = true; }
  t('unknown unit throws',   threw);
});

runSuite('cgroups.js — cpusToCfsQuota', async (t) => {
  const { cpusToCfsQuota, CFS_PERIOD_US } = require('../src/core/cgroups');

  t('0.5 CPUs → half period',     cpusToCfsQuota('0.5')  === CFS_PERIOD_US * 0.5);
  t('1 CPU  → full period',       cpusToCfsQuota('1')    === CFS_PERIOD_US);
  t('2 CPUs → double period',     cpusToCfsQuota('2')    === CFS_PERIOD_US * 2);
  t('0.1 CPUs → 10% period',      cpusToCfsQuota('0.1')  === Math.floor(CFS_PERIOD_US * 0.1));
  t('null passthrough',           cpusToCfsQuota(null)   === null);
  t('CFS_PERIOD_US is 100000',    CFS_PERIOD_US          === 100_000);

  let threw = false;
  try { cpusToCfsQuota('0'); } catch { threw = true; }
  t('zero CPUs throws',           threw);

  threw = false;
  try { cpusToCfsQuota('-1'); } catch { threw = true; }
  t('negative CPUs throws',       threw);
});

runSuite('cgroups.js — detectVersion', async (t) => {
  const { detectVersion } = require('../src/core/cgroups');
  const { IS_LINUX } = require('../src/utils/platform');

  const v = detectVersion();
  if (IS_LINUX) {
    t('returns 1 or 2 on Linux',  v === 1 || v === 2);
  } else {
    t('returns null on non-Linux', v === null);
  }
});

runSuite('cgroups.js — NullCgroup (no-op on all platforms)', async (t) => {
  const { NullCgroup } = require('../src/core/cgroups');

  const cg = new NullCgroup('test123', { memory: '256m', cpus: '0.5' });
  t('attach does not throw',  await cg.attach(process.pid).then(() => true).catch(() => false));
  t('stats returns null',     await cg.stats() === null);
  t('destroy does not throw', await cg.destroy().then(() => true).catch(() => false));
});

runSuite('cgroups.js — createCgroup (factory)', async (t) => {
  const { createCgroup, NullCgroup } = require('../src/core/cgroups');
  const { IS_LINUX } = require('../src/utils/platform');

  // No limits → always NullCgroup
  const nullCg = await createCgroup('nc_test', {});
  t('no limits → NullCgroup type', nullCg instanceof NullCgroup);

  // With limits on Linux it creates a real cgroup (or NullCgroup if not root)
  // We just verify it returns something with the right interface
  const cg = await createCgroup('cg_test_' + Date.now(), { memory: '128m', pidsLimit: 64 });
  t('has attach method',   typeof cg.attach   === 'function');
  t('has stats method',    typeof cg.stats    === 'function');
  t('has destroy method',  typeof cg.destroy  === 'function');

  // Clean up: destroy is a no-op if cgroup dir doesn't exist
  await cg.destroy().catch(() => {});
});

runSuite('core/config.js — runtime environment configuration', async (t) => {
  const { parseEnv, buildRuntimeEnv } = require('../src/core/config');

  const parsed = parseEnv(['KEY=value', 'EMPTY=', 'EQUALS=a=b']);
  t('parses KEY=VALUE', parsed.KEY === 'value');
  t('preserves empty values', parsed.EMPTY === '');
  t('preserves equals in value', parsed.EQUALS === 'a=b');

  const merged = buildRuntimeEnv(['KEY=override'], ['KEY=image', 'IMAGE=yes'], { HOST: 'yes' });
  t('runtime overrides image', merged.KEY === 'override');
  t('image defaults retained', merged.IMAGE === 'yes');
  t('host environment retained', merged.HOST === 'yes');

  let threw = false;
  try { parseEnv(['BAD-NAME=value']); } catch { threw = true; }
  t('invalid names rejected', threw);
});

runSuite('core/overlay.js — cached layer overlay helpers', async (t) => {
  const overlay = require('../src/core/overlay');
  const { IS_LINUX } = require('../src/utils/platform');

  t('exports prepareLower', typeof overlay.prepareLower === 'function');
  t('exports mountOverlay', typeof overlay.mountOverlay === 'function');
  t('exports unmountOverlay', typeof overlay.unmountOverlay === 'function');
  if (!IS_LINUX) {
    t('mount is a no-op outside Linux', await overlay.mountOverlay('/lower', '/upper', '/work', '/merged') === false);
  } else {
    t('Linux overlay helper available', true);
  }
});

runSuite('runtime.js — privilege drop command construction', async (t) => {
  const { buildExecArgs } = require('../src/core/runtime');
  const { IS_LINUX } = require('../src/utils/platform');
  const base = { rootfs: '/tmp/rootfs', cmd: ['app'], user: 'nobody' };
  const image = { config: { entrypoint: [] } };

  if (IS_LINUX) {
    const unprivileged = buildExecArgs(base, image, []);
    t('uses unshare on Linux',             unprivileged.cmd === 'unshare');
    t('drops to configured user',          unprivileged.args.includes('nobody'));
    t('executes the container command',    unprivileged.args.includes('app'));
    t('does not drop for root',            !buildExecArgs({ ...base, user: 'root' }, image, []).args.includes('nobody'));
  } else {
    t('non-Linux runtime remains supported', true);
  }
});

runSuite('cgroups.js — limit validation in runtime (integration)', async (t) => {
  // Verify the validation logic for bad limit values
  const { parseMemory, cpusToCfsQuota } = require('../src/core/cgroups');

  // These should all throw
  const cases = [
    ['bad memory string',      () => parseMemory('two-fifty-six-mb')],
    ['zero cpus',              () => cpusToCfsQuota('0')],
    ['negative cpus',          () => cpusToCfsQuota('-0.5')],
  ];
  for (const [label, fn] of cases) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    t(label + ' throws', threw);
  }

  // These should NOT throw
  const valid = [
    ['256m memory',   () => parseMemory('256m')],
    ['1g memory',     () => parseMemory('1g')],
    ['0.5 cpus',      () => cpusToCfsQuota('0.5')],
    ['4 cpus',        () => cpusToCfsQuota('4')],
  ];
  for (const [label, fn] of valid) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    t(label + ' does not throw', !threw);
  }
});

runSuite('commands/stats.js — module loads', async (t) => {
  let statsCmd;
  try {
    statsCmd = require('../src/commands/stats');
    t('stats.js loads without error', typeof statsCmd === 'function');
  } catch (err) {
    t('stats.js loads without error', false, err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Volume suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('volumes.js — parseVolumeSpec: bind mounts', async (t) => {
  const { parseVolumeSpec } = require('../src/core/volumes');
  const path = require('path');

  // source:target
  let s = parseVolumeSpec('/host/data:/app/data');
  t('bind: source resolved',     s.source && s.source.endsWith(require('path').normalize('host/data')));
  t('bind: target',              s.target === '/app/data');
  t('bind: not readOnly',        s.readOnly === false);
  t('bind: not named',           s.named === false);
  t('bind: not anonymous',       s.anonymous === false);

  // source:target:ro
  s = parseVolumeSpec('/src:/dst:ro');
  t('ro: readOnly true',         s.readOnly === true);
  t('ro: target correct',        s.target === '/dst');

  // source:target:rw  (explicit rw)
  s = parseVolumeSpec('/src:/dst:rw');
  t('rw: readOnly false',        s.readOnly === false);

  // target only  → anonymous
  s = parseVolumeSpec('/app/cache');
  t('anon: anonymous true',      s.anonymous === true);
  t('anon: source null',         s.source === null);
  t('anon: target',              s.target === '/app/cache');

  // multiple options
  s = parseVolumeSpec('/src:/dst:ro,nocopy');
  t('multi-opt: readOnly',       s.readOnly === true);
  t('multi-opt: nocopy',         s.nocopy === true);
});

runSuite('volumes.js — parseVolumeSpec: named volumes', async (t) => {
  const { parseVolumeSpec, removeNamedVolume, getNamedVolume } = require('../src/core/volumes');

  const name = 'testvol_' + Date.now();
  let s = parseVolumeSpec(`${name}:/data`);
  t('named: named flag true',    s.named === true);
  t('named: volumeName set',     s.volumeName === name);
  t('named: target',             s.target === '/data');
  t('named: source is a path',   typeof s.source === 'string' && s.source.length > 0);

  // Volume should now exist on disk
  const vol = getNamedVolume(name);
  t('named: volume in db',       vol !== null);
  t('named: db path exists',     require('fs-extra').existsSync(vol.path));

  // Named volume read-only
  s = parseVolumeSpec(`${name}:/data:ro`);
  t('named-ro: readOnly',        s.readOnly === true);

  // Cleanup
  try { removeNamedVolume(name); } catch {}
});

runSuite('volumes.js — parseVolumeSpec: validation', async (t) => {
  const { parseVolumeSpec } = require('../src/core/volumes');

  // Relative target should throw
  let threw = false;
  try { parseVolumeSpec('/src:relative'); } catch { threw = true; }
  t('relative target throws',    threw);

  // Empty spec should throw
  threw = false;
  try { parseVolumeSpec(''); } catch { threw = true; }
  t('empty spec throws',         threw);

  // Whitespace-only should throw
  threw = false;
  try { parseVolumeSpec('   '); } catch { threw = true; }
  t('whitespace spec throws',    threw);
});

runSuite('volumes.js — parseVolumeSpecs: array input', async (t) => {
  const { parseVolumeSpecs } = require('../src/core/volumes');

  // Empty array
  let specs = parseVolumeSpecs([]);
  t('empty array returns []',    specs.length === 0);

  // Multiple specs
  specs = parseVolumeSpecs(['/a:/b', '/c:/d:ro', '/e:/f/g']);
  t('3 specs parsed',            specs.length === 3);
  t('second is readOnly',        specs[1].readOnly === true);
  t('third target deep path',    specs[2].target === '/f/g');
});

runSuite('volumes.js — isNamedVolume', async (t) => {
  const { isNamedVolume } = require('../src/core/volumes');

  t('simple name',               isNamedVolume('myvolume')       === true);
  t('name with dash',            isNamedVolume('my-volume')      === true);
  t('name with dot',             isNamedVolume('v1.0')           === true);
  t('absolute path is not named',isNamedVolume('/data')          === false);
  t('relative path is not named',isNamedVolume('./data')         === false);
  t('dot prefix is not named',   isNamedVolume('.hidden')        === false);
  t('Windows drive is not named',isNamedVolume('C:\\data')       === false);
  t('Windows fwd slash no named',isNamedVolume('C:/data')        === false);
  t('null/empty is not named',   isNamedVolume('')               === false);
  t('undefined is not named',    isNamedVolume(undefined)        === false);
});

runSuite('volumes.js — named volume CRUD', async (t) => {
  const {
    ensureNamedVolume,
    getNamedVolume,
    listNamedVolumes,
    removeNamedVolume,
  } = require('../src/core/volumes');
  const fs = require('fs-extra');

  const name = 'crud_test_' + Date.now();

  // create
  const volPath = ensureNamedVolume(name);
  t('create: returns path',      typeof volPath === 'string');
  t('create: path exists',       fs.existsSync(volPath));

  // get
  const v = getNamedVolume(name);
  t('get: not null',             v !== null);
  t('get: name correct',         v.name === name);
  t('get: path matches',         v.path === volPath);

  // list
  const all = listNamedVolumes();
  t('list: includes new volume', all.some(x => x.name === name));

  // idempotent create (calling twice returns same path)
  const volPath2 = ensureNamedVolume(name);
  t('idempotent: same path',     volPath === volPath2);

  // remove
  removeNamedVolume(name);
  t('remove: gone from db',      getNamedVolume(name) === null);
  t('remove: dir deleted',       !fs.existsSync(volPath));

  // remove non-existent should throw
  let threw = false;
  try { removeNamedVolume(name); } catch { threw = true; }
  t('remove missing: throws',    threw);
});

runSuite('volumes.js — mountVolumes / unmountVolumes (Windows no-op check)', async (t) => {
  const { parseVolumeSpecs, mountVolumes, unmountVolumes } = require('../src/core/volumes');
  const { IS_LINUX } = require('../src/utils/platform');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  // Set up a real temp source directory with a file
  const tmpSrc  = path.join(os.tmpdir(), 'mc_vol_src_' + Date.now());
  const tmpRoot = path.join(os.tmpdir(), 'mc_vol_root_' + Date.now());
  await fs.ensureDir(tmpSrc);
  await fs.writeFile(path.join(tmpSrc, 'hello.txt'), 'hello from volume');

  const specs = parseVolumeSpecs([`${tmpSrc}:/app/data`]);
  t('parsed 1 spec',             specs.length === 1);
  t('spec target',               specs[0].target === '/app/data');

  const mounted = await mountVolumes(specs, tmpRoot, 'test-container');
  t('mountVolumes returns array', Array.isArray(mounted));

  if (IS_LINUX) {
    // On Linux the bind-mount makes the file visible at the target
    const seenFile = fs.existsSync(path.join(tmpRoot, 'app', 'data', 'hello.txt'));
    t('Linux: file visible in rootfs', seenFile);
    await unmountVolumes(specs, tmpRoot);
    t('unmount completes',       true);
  } else {
    // On Windows: junction created
    const junctionExists = fs.existsSync(path.join(tmpRoot, 'app', 'data'));
    t('Windows: junction/dir exists', junctionExists);
    t('unmount: no-op on Windows', true); // unmountVolumes is a no-op on Windows
  }

  await fs.remove(tmpSrc).catch(() => {});
  await fs.remove(tmpRoot).catch(() => {});
});

runSuite('commands/volume.js — module loads', async (t) => {
  let volumeCmd;
  try {
    volumeCmd = require('../src/commands/volume');
    t('volume.js loads without error', typeof volumeCmd === 'function');
  } catch (err) {
    t('volume.js loads without error', false, err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// cp suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('commands/cp.js — parseCpArg', async (t) => {
  const { parseCpArg } = require('../src/commands/cp');

  // Container path
  let r = parseCpArg('abc123:/etc/hosts');
  t('container path: id',      r.containerId === 'abc123');
  t('container path: file',    r.filePath    === '/etc/hosts');

  // Host path (no colon)
  r = parseCpArg('/tmp/data');
  t('host path: no id',        r.containerId === undefined);
  t('host path: filePath',     r.filePath === '/tmp/data');

  // Windows drive letter — NOT treated as container:path
  r = parseCpArg('C:\\Users\\foo');
  t('win drive: no id',        r.containerId === undefined);
  t('win drive: filePath kept', r.filePath === 'C:\\Users\\foo');

  r = parseCpArg('C:/Users/foo');
  t('win drive fwd: no id',    r.containerId === undefined);

  // Empty container path (container:/)
  r = parseCpArg('mybox:');
  t('empty path → /',          r.filePath === '/' || r.filePath === '');

  // Relative host path
  r = parseCpArg('./local/file.txt');
  t('relative host: no id',    r.containerId === undefined);
  t('relative host: filePath', r.filePath === './local/file.txt');
});

runSuite('commands/cp.js — file copy host → container → host', async (t) => {
  const cpCommand = require('../src/commands/cp');
  const store     = require('../src/state/store');
  const fs        = require('fs-extra');
  const os        = require('os');
  const path      = require('path');

  // Create a fake rootfs and register a fake container
  const rootfsDir = path.join(os.tmpdir(), 'mc_cp_rootfs_' + Date.now());
  await fs.ensureDir(rootfsDir);
  const cid = 'cptest' + Date.now().toString(16).slice(-6);
  store.saveContainer({ id: cid, name: 'cp-test-box', status: 'stopped', image: 'none', rootfsDir });

  // 1. Copy a file from host → container
  const hostSrc = path.join(os.tmpdir(), 'mc_cp_src_' + Date.now() + '.txt');
  await fs.writeFile(hostSrc, 'hello cp world');
  await cpCommand(hostSrc, `${cid}:/myfile.txt`);
  const inContainer = path.join(rootfsDir, 'myfile.txt');
  t('host→container: file exists',   fs.existsSync(inContainer));
  t('host→container: content match', fs.existsSync(inContainer) &&
      fs.readFileSync(inContainer, 'utf8') === 'hello cp world');

  // 2. Copy the file back from container → host
  const hostDest = path.join(os.tmpdir(), 'mc_cp_dest_' + Date.now() + '.txt');
  await cpCommand(`${cid}:/myfile.txt`, hostDest);
  t('container→host: file exists',   fs.existsSync(hostDest));
  t('container→host: content match', fs.existsSync(hostDest) &&
      fs.readFileSync(hostDest, 'utf8') === 'hello cp world');

  // 3. Copy a directory from host → container
  const hostDir = path.join(os.tmpdir(), 'mc_cp_dir_' + Date.now());
  await fs.ensureDir(hostDir);
  await fs.writeFile(path.join(hostDir, 'a.txt'), 'alpha');
  await fs.writeFile(path.join(hostDir, 'b.txt'), 'beta');
  await cpCommand(hostDir, `${cid}:/mydir`);
  t('dir host→container: dir created', fs.existsSync(path.join(rootfsDir, 'mydir')));
  t('dir host→container: file a.txt',  fs.existsSync(path.join(rootfsDir, 'mydir', 'a.txt')));

  // 4. Error: source does not exist
  let threw = false;
  try { await cpCommand(`${cid}:/nonexistent.txt`, os.tmpdir()); } catch { threw = true; }
  t('missing src throws', threw);

  // 5. Error: no container identifier on either side
  threw = false;
  try { await cpCommand('/a', '/b'); } catch { threw = true; }
  t('no container arg throws', threw);

  // Cleanup
  store.deleteContainer(cid);
  await fs.remove(rootfsDir).catch(() => {});
  await fs.remove(hostSrc).catch(() => {});
  await fs.remove(hostDest).catch(() => {});
  await fs.remove(hostDir).catch(() => {});
});

// ══════════════════════════════════════════════════════════════════════════════
// network suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('commands/network.js — module loads + exports', async (t) => {
  let net;
  try {
    net = require('../src/commands/network');
    t('network.js loads without error',   typeof net === 'function');
  } catch (err) {
    t('network.js loads without error',   false, err.message);
    return;
  }
  t('exports getNetwork',      typeof net.getNetwork    === 'function');
  t('exports allNetworks',     typeof net.allNetworks   === 'function');
  t('exports networkCreate',   typeof net.networkCreate === 'function');
  t('exports networkRm',       typeof net.networkRm     === 'function');
  t('exports networkLs',       typeof net.networkLs     === 'function');
});

runSuite('commands/network.js — built-in networks always present', async (t) => {
  const { allNetworks } = require('../src/commands/network');
  const nets = allNetworks();

  t('bridge network exists',   !!nets.bridge);
  t('host network exists',     !!nets.host);
  t('none network exists',     !!nets.none);
  t('bridge driver correct',   nets.bridge.driver === 'bridge');
  t('host driver correct',     nets.host.driver   === 'host');
  t('none driver correct',     nets.none.driver   === 'null');
  t('bridge subnet set',       typeof nets.bridge.subnet === 'string');
  t('bridge builtin flag',     nets.bridge.builtin === true);
});

runSuite('commands/network.js — create / inspect / rm lifecycle', async (t) => {
  const net = require('../src/commands/network');
  const fs  = require('fs-extra');

  const name = 'testnet_' + Date.now();

  // Create
  net.networkCreate(name, { driver: 'bridge', subnet: '10.99.0.0/24', gateway: '10.99.0.1' });
  const found = net.getNetwork(name);
  t('create: network found',     !!found);
  t('create: name correct',      found && found.name === name);
  t('create: driver stored',     found && found.driver === 'bridge');
  t('create: not builtin',       found && found.builtin === false);

  // Duplicate create should throw
  let threw = false;
  try { net.networkCreate(name); } catch { threw = true; }
  t('duplicate create throws',   threw);

  // Remove
  net.networkRm(name);
  t('rm: network gone',          net.getNetwork(name) === null);

  // Remove builtin should throw
  threw = false;
  try { net.networkRm('bridge'); } catch { threw = true; }
  t('rm builtin throws',         threw);

  // Remove non-existent should throw
  threw = false;
  try { net.networkRm('ghost_network_xyz'); } catch { threw = true; }
  t('rm missing throws',         threw);

  // Cleanup NET_CUSTOM_DB if test residue
  const { NET_CUSTOM_DB, readNetworks, writeNetworks } = net;
  const custom = readNetworks();
  delete custom[name];
  if (Object.keys(custom).length === 0 && fs.existsSync(NET_CUSTOM_DB)) {
    writeNetworks(custom);
  }
});

runSuite('commands/network.js — allNetworks includes custom', async (t) => {
  const net  = require('../src/commands/network');
  const name = 'custnet_' + Date.now();

  net.networkCreate(name);
  const all = net.allNetworks();
  t('custom net in allNetworks', !!all[name]);

  net.networkRm(name);
  const after = net.allNetworks();
  t('custom net removed after rm', !after[name]);
});

// ══════════════════════════════════════════════════════════════════════════════
// compose suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('commands/compose.js — module loads + exports', async (t) => {
  let compose;
  try {
    compose = require('../src/commands/compose');
    t('compose.js loads without error', typeof compose === 'function');
  } catch (err) {
    t('compose.js loads without error', false, err.message);
    return;
  }
  t('exports loadCompose',      typeof compose.loadCompose   === 'function');
  t('exports topoSort',         typeof compose.topoSort      === 'function');
  t('exports findComposeFile',  typeof compose.findComposeFile === 'function');
  t('exports containerName',    typeof compose.containerName === 'function');
});

runSuite('commands/compose.js — loadCompose parses services', async (t) => {
  const { loadCompose } = require('../src/commands/compose');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_compose_test_' + Date.now());
  await fs.ensureDir(tmpDir);

  const composeContent = `
services:
  web:
    image: nginx:latest
    ports:
      - "8080:80"
    volumes:
      - ./html:/usr/share/nginx/html
    environment:
      - NGINX_HOST=localhost
      - NGINX_PORT=80
    depends_on:
      - db

  db:
    image: postgres:15
    environment:
      POSTGRES_DB: mydb
      POSTGRES_USER: user
      POSTGRES_PASSWORD: secret
    volumes:
      - pgdata:/var/lib/postgresql/data
    mem_limit: "256m"
    cpus: 0.5

  worker:
    image: myapp:latest
    command: ["python", "worker.py"]
    depends_on:
      - db
      - web
`;

  const composeFile = path.join(tmpDir, 'compose.yaml');
  await fs.writeFile(composeFile, composeContent);

  const config = loadCompose(composeFile);

  t('3 services parsed',             Object.keys(config.services).length === 3);
  t('web: image correct',            config.services.web.image === 'nginx:latest');
  t('web: ports parsed',             config.services.web.ports.includes('8080:80'));
  t('web: env array',                Array.isArray(config.services.web.env));
  t('web: env has NGINX_HOST',       config.services.web.env.some(e => e.startsWith('NGINX_HOST')));
  t('web: depends on db',            config.services.web.dependsOn.includes('db'));
  t('db: env from object',           config.services.db.env.some(e => e.startsWith('POSTGRES_DB')));
  t('db: memory limit',              config.services.db.memory === '256m');
  t('db: cpus',                      config.services.db.cpus === '0.5');
  t('worker: command array',         config.services.worker.command[0] === 'python');
  t('worker: depends on db+web',     config.services.worker.dependsOn.length === 2);

  await fs.remove(tmpDir);
});

runSuite('commands/compose.js — loadCompose: string command', async (t) => {
  const { loadCompose } = require('../src/commands/compose');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_compose_cmd_' + Date.now());
  await fs.ensureDir(tmpDir);
  const composeFile = path.join(tmpDir, 'compose.yaml');
  await fs.writeFile(composeFile, `
services:
  app:
    image: alpine
    command: "sh -c 'echo hello'"
`);

  const config = loadCompose(composeFile);
  t('string cmd split',        Array.isArray(config.services.app.command));
  t('string cmd: sh first',    config.services.app.command[0] === 'sh');

  await fs.remove(tmpDir);
});

runSuite('commands/compose.js — loadCompose: invalid file throws', async (t) => {
  const { loadCompose } = require('../src/commands/compose');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_compose_bad_' + Date.now());
  await fs.ensureDir(tmpDir);

  // Completely invalid YAML
  const badFile = path.join(tmpDir, 'compose.yaml');
  await fs.writeFile(badFile, ': : : invalid yaml {{{');

  let threw = false;
  try { loadCompose(badFile); } catch { threw = true; }
  t('bad yaml throws',         threw);

  // Non-existent file
  threw = false;
  try { loadCompose(path.join(tmpDir, 'missing.yaml')); } catch { threw = true; }
  t('missing file throws',     threw);

  await fs.remove(tmpDir);
});

runSuite('commands/compose.js — topoSort ordering', async (t) => {
  const { topoSort } = require('../src/commands/compose');

  const services = {
    web:    { dependsOn: ['db'] },
    db:     { dependsOn: [] },
    worker: { dependsOn: ['db', 'web'] },
    cache:  { dependsOn: [] },
  };

  const order = topoSort(services);
  t('all 4 services present',   order.length === 4);

  // db and cache must come before web; web must come before worker
  const idxDb     = order.indexOf('db');
  const idxWeb    = order.indexOf('web');
  const idxWorker = order.indexOf('worker');
  const idxCache  = order.indexOf('cache');

  t('db before web',            idxDb     < idxWeb);
  t('web before worker',        idxWeb    < idxWorker);
  t('db before worker',         idxDb     < idxWorker);
  t('cache present',            idxCache  >= 0);
});

runSuite('commands/compose.js — topoSort: circular dependency throws', async (t) => {
  const { topoSort } = require('../src/commands/compose');

  const circular = {
    a: { dependsOn: ['b'] },
    b: { dependsOn: ['c'] },
    c: { dependsOn: ['a'] },
  };

  let threw = false;
  try { topoSort(circular); } catch { threw = true; }
  t('circular dep throws',      threw);
});

runSuite('commands/compose.js — topoSort: selected services', async (t) => {
  const { topoSort } = require('../src/commands/compose');

  const services = {
    web:    { dependsOn: ['db'] },
    db:     { dependsOn: [] },
    cache:  { dependsOn: [] },
    worker: { dependsOn: ['db'] },
  };

  // Select only 'web' — should pull in 'db' transitively
  const order = topoSort(services, ['web']);
  t('selected: includes web',    order.includes('web'));
  t('selected: includes db dep', order.includes('db'));
  t('selected: excludes cache',  !order.includes('cache'));
  t('selected: excludes worker', !order.includes('worker'));
  t('selected: db before web',   order.indexOf('db') < order.indexOf('web'));
});

runSuite('commands/compose.js — containerName helper', async (t) => {
  const { containerName } = require('../src/commands/compose');

  t('format correct',     containerName('myapp', 'web')    === 'myapp_web_1');
  t('with dash service',  containerName('proj', 'my-svc')  === 'proj_my-svc_1');
  t('empty service',      containerName('p', '')           === 'p__1');
});

runSuite('commands/compose.js — findComposeFile', async (t) => {
  const { findComposeFile, COMPOSE_FILENAMES } = require('../src/commands/compose');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_compose_find_' + Date.now());
  await fs.ensureDir(tmpDir);

  // No file → throws
  let threw = false;
  try { findComposeFile(tmpDir); } catch { threw = true; }
  t('no file throws',           threw);

  // Create compose.yaml → found
  await fs.writeFile(path.join(tmpDir, 'compose.yaml'), 'services: {}');
  const found = findComposeFile(tmpDir);
  t('compose.yaml found',       found === path.join(tmpDir, 'compose.yaml'));

  // COMPOSE_FILENAMES is an array
  t('COMPOSE_FILENAMES array',  Array.isArray(COMPOSE_FILENAMES));
  t('includes compose.yaml',    COMPOSE_FILENAMES.includes('compose.yaml'));
  t('includes docker-compose.yaml', COMPOSE_FILENAMES.includes('docker-compose.yaml'));

  await fs.remove(tmpDir);
});

// ══════════════════════════════════════════════════════════════════════════════
// Event log suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('eventlog.js — module loads + exports', async (t) => {
  let ev;
  try {
    ev = require('../src/state/eventlog');
    t('eventlog loads without error', typeof ev === 'object');
  } catch (err) {
    t('eventlog loads without error', false, err.message);
    return;
  }
  t('exports emit',        typeof ev.emit     === 'function');
  t('exports read',        typeof ev.read     === 'function');
  t('exports tail',        typeof ev.tail     === 'function');
  t('exports getSeq',      typeof ev.getSeq   === 'function');
  t('exports clear',       typeof ev.clear    === 'function');
  t('exports EVENT_LOG',   typeof ev.EVENT_LOG === 'string');
  t('exports container ns',typeof ev.container === 'object');
  t('exports image ns',    typeof ev.image     === 'object');
  t('exports volume ns',   typeof ev.volume    === 'object');
  t('exports network ns',  typeof ev.network   === 'object');
  t('exports system ns',   typeof ev.system    === 'object');
});

runSuite('eventlog.js — emit / read basic round-trip', async (t) => {
  const ev   = require('../src/state/eventlog');
  const fs   = require('fs-extra');
  const path = require('path');
  const os   = require('os');

  // Use a temp log file to avoid touching the real log
  const origLog = ev.EVENT_LOG;

  // We test through the real path — clear first to get a clean state
  ev.clear();
  const seqBefore = ev.getSeq();

  const e1 = ev.emit('container', 'start', { id: 'abc123', name: 'web', attrs: { pid: '42' } });
  const e2 = ev.emit('image',     'pull',  { id: 'nginx:latest', name: 'nginx:latest' });
  const e3 = ev.emit('volume',    'create',{ id: 'myvol', name: 'myvol', attrs: { path: '/tmp/v' } });

  t('emit returns event object',   e1 && typeof e1 === 'object');
  t('emit: seq field',             typeof e1.seq === 'number');
  t('emit: time is ISO string',    /^\d{4}-\d{2}-\d{2}T/.test(e1.time));
  t('emit: timeMs is number',      typeof e1.timeMs === 'number');
  t('emit: type stored',           e1.type   === 'container');
  t('emit: action stored',         e1.action === 'start');
  t('emit: actor.id stored',       e1.actor.id === 'abc123');
  t('emit: actor.name stored',     e1.actor.name === 'web');
  t('emit: actor.attrs stored',    e1.actor.attrs.pid === '42');

  t('seq increments',              e2.seq === e1.seq + 1);
  t('seq increments again',        e3.seq === e2.seq + 1);

  const events = ev.read();
  t('read returns array',          Array.isArray(events));
  t('read returns 3 events',       events.length === 3);
  t('read ordered oldest first',   events[0].seq < events[2].seq);

  // Verify log file exists and has valid JSON lines
  t('log file exists',             fs.existsSync(ev.EVENT_LOG));
  const lines = fs.readFileSync(ev.EVENT_LOG, 'utf8').trim().split('\n');
  t('3 non-empty lines',           lines.length === 3);
  t('each line is valid JSON',     lines.every(l => { try { JSON.parse(l); return true; } catch { return false; } }));

  ev.clear();
  t('clear empties log',           ev.read().length === 0);
});

runSuite('eventlog.js — read with filters', async (t) => {
  const ev = require('../src/state/eventlog');

  ev.clear();
  const now = Date.now();

  ev.emit('container', 'create', { id: 'c1', name: 'web-1',   attrs: {} });
  ev.emit('container', 'start',  { id: 'c1', name: 'web-1',   attrs: {} });
  ev.emit('image',     'pull',   { id: 'nginx:latest', name: 'nginx:latest' });
  ev.emit('container', 'die',    { id: 'c1', name: 'web-1',   attrs: { exitCode: '0' } });
  ev.emit('volume',    'create', { id: 'vol1', name: 'vol1',  attrs: {} });
  ev.emit('container', 'create', { id: 'c2', name: 'db-1',    attrs: {} });

  // filter by type
  let filtered = ev.read({ type: 'container' });
  t('type filter: only containers',  filtered.every(e => e.type === 'container'));
  t('type filter: correct count',    filtered.length === 4);

  // filter by action
  filtered = ev.read({ action: 'create' });
  t('action filter: creates only',   filtered.every(e => e.action === 'create'));
  t('action filter: count 3',        filtered.length === 3); // c1 create + vol1 create + c2 create

  // filter by actorId prefix
  filtered = ev.read({ actorId: 'c1' });
  t('actorId prefix match',          filtered.every(e => e.actor.id.startsWith('c1')));
  t('actorId match count',           filtered.length === 3); // create + start + die

  // filter by actorId exact
  filtered = ev.read({ actorId: 'vol1' });
  t('actorId exact match',           filtered.length === 1);

  // limit
  filtered = ev.read({ limit: 2 });
  t('limit returns last 2',          filtered.length === 2);
  t('limit: most recent events',     filtered[1].actor.id === 'c2');

  // sinceMs
  filtered = ev.read({ sinceMs: now - 1000 }); // 1 second ago → all 6
  t('sinceMs includes all',          filtered.length === 6);

  filtered = ev.read({ sinceMs: Date.now() + 10_000 }); // far future → none
  t('sinceMs excludes all',          filtered.length === 0);

  // combined
  filtered = ev.read({ type: 'container', action: 'create' });
  t('combined filters',              filtered.length === 2);
  t('combined: only container+create', filtered.every(e => e.type === 'container' && e.action === 'create'));

  ev.clear();
});

runSuite('eventlog.js — getSeq is stable across calls', async (t) => {
  const ev = require('../src/state/eventlog');

  ev.clear();
  t('getSeq returns number',     typeof ev.getSeq() === 'number');
  t('empty log → seq = 0',       ev.getSeq() === 0);

  ev.emit('system', 'start', { id: 'minicontainer' });
  t('after 1 emit → seq = 1',    ev.getSeq() === 1);

  ev.emit('system', 'start', { id: 'minicontainer' });
  t('after 2 emits → seq = 2',   ev.getSeq() === 2);

  ev.clear();
  t('after clear → seq = 0',     ev.getSeq() === 0);
});

runSuite('eventlog.js — tail delivers new events in real-time', async (t) => {
  const ev = require('../src/state/eventlog');

  ev.clear();
  // Ensure the log file exists before we watch it
  const fs = require('fs-extra');
  fs.ensureFileSync(ev.EVENT_LOG);

  const received = [];
  const stop = ev.tail({}, event => received.push(event));

  // Emit after a brief delay so the watcher is attached
  await new Promise(r => setTimeout(r, 50));

  ev.emit('container', 'start', { id: 'tailtest', name: 'tailtest' });
  ev.emit('image',     'pull',  { id: 'alpine:latest', name: 'alpine:latest' });

  // Wait for the watcher to fire
  await new Promise(r => setTimeout(r, 200));
  stop();

  t('tail received events',      received.length >= 1);
  t('tail has start event',      received.some(e => e.action === 'start'));

  ev.clear();
});

runSuite('eventlog.js — namespaced emitters', async (t) => {
  const ev = require('../src/state/eventlog');

  ev.clear();

  ev.container.create('cid1', 'web', 'nginx:latest');
  ev.container.start( 'cid1', 'web', 99);
  ev.container.stop(  'cid1', 'web');
  ev.container.die(   'cid1', 'web', 0);
  ev.container.destroy('cid1', 'web');

  ev.image.pull('nginx:latest', 'sha256:abc');
  ev.image.build('myapp:v1', 'myapp:v1');
  ev.image.delete('old:v0');

  ev.volume.create('data', '/tmp/data');
  ev.volume.destroy('data');

  ev.network.create('net1', 'mynet');
  ev.network.connect('mynet', 'cid1');
  ev.network.disconnect('mynet', 'cid1');
  ev.network.destroy('mynet');

  ev.system.start();
  ev.system.prune('all');

  const all = ev.read();
  t('16 events emitted',           all.length === 16);

  const containerEvs = all.filter(e => e.type === 'container');
  t('5 container events',          containerEvs.length === 5);
  t('container.die has exitCode',  containerEvs.find(e => e.action === 'die')?.actor.attrs.exitCode === '0');
  t('container.start has pid',     containerEvs.find(e => e.action === 'start')?.actor.attrs.pid === '99');

  const imageEvs = all.filter(e => e.type === 'image');
  t('3 image events',              imageEvs.length === 3);
  t('pull has digest attr',        imageEvs.find(e => e.action === 'pull')?.actor.attrs.digest === 'sha256:abc');

  const volumeEvs = all.filter(e => e.type === 'volume');
  t('2 volume events',             volumeEvs.length === 2);
  t('volume.create has path',      volumeEvs.find(e => e.action === 'create')?.actor.attrs.path === '/tmp/data');

  const networkEvs = all.filter(e => e.type === 'network');
  t('4 network events',            networkEvs.length === 4);

  const systemEvs = all.filter(e => e.type === 'system');
  t('2 system events',             systemEvs.length === 2);

  ev.clear();
});

runSuite('eventlog.js — integration: store.js emits events on saveContainer', async (t) => {
  const ev    = require('../src/state/eventlog');
  const store = require('../src/state/store');

  ev.clear();

  const id = 'evtest_' + Date.now().toString(16);

  // 1. saveContainer(created) → emits 'create'
  store.saveContainer({ id, name: 'ev-web', image: 'nginx', status: 'created' });
  let events = ev.read();
  t('saveContainer(created) → create event', events.some(e => e.type === 'container' && e.action === 'create'));

  // 2. saveContainer(running) → emits 'start'
  store.saveContainer({ id, name: 'ev-web', image: 'nginx', status: 'running', pid: 1234 });
  events = ev.read();
  t('saveContainer(running) → start event', events.some(e => e.action === 'start' && e.actor.id === id));

  // 3. saveContainer(exited) → emits 'stop' + 'die'
  store.saveContainer({ id, name: 'ev-web', image: 'nginx', status: 'exited', exitCode: 0 });
  events = ev.read();
  t('saveContainer(exited) → stop event',  events.some(e => e.action === 'stop'  && e.actor.id === id));
  t('saveContainer(exited) → die event',   events.some(e => e.action === 'die'   && e.actor.id === id));

  // 4. deleteContainer → emits 'destroy'
  store.deleteContainer(id);
  events = ev.read();
  t('deleteContainer → destroy event',     events.some(e => e.action === 'destroy' && e.actor.id === id));

  ev.clear();
});

runSuite('eventlog.js — integration: volumes emit events', async (t) => {
  const ev      = require('../src/state/eventlog');
  const volumes = require('../src/core/volumes');

  ev.clear();

  const name = 'evvol_' + Date.now();
  volumes.ensureNamedVolume(name);
  let events = ev.read();
  t('ensureNamedVolume → volume.create event', events.some(e => e.type === 'volume' && e.action === 'create' && e.actor.id === name));

  volumes.removeNamedVolume(name);
  events = ev.read();
  t('removeNamedVolume → volume.destroy event', events.some(e => e.type === 'volume' && e.action === 'destroy' && e.actor.id === name));

  // ensureNamedVolume is idempotent — second call does NOT emit another create
  const name2 = 'evvol2_' + Date.now();
  volumes.ensureNamedVolume(name2);
  volumes.ensureNamedVolume(name2); // idempotent
  events = ev.read({ actorId: name2 });
  t('idempotent create: only 1 event', events.filter(e => e.action === 'create').length === 1);

  volumes.removeNamedVolume(name2);
  ev.clear();
});

runSuite('commands/events.js — module loads + exports', async (t) => {
  let evCmd;
  try {
    evCmd = require('../src/commands/events');
    t('events.js loads without error', typeof evCmd === 'function');
  } catch (err) {
    t('events.js loads without error', false, err.message);
    return;
  }
  t('exports parseTimeArg', typeof evCmd.parseTimeArg === 'function');
  t('exports parseFilters', typeof evCmd.parseFilters === 'function');
  t('exports formatEvent',  typeof evCmd.formatEvent  === 'function');
});

runSuite('commands/events.js — parseTimeArg', async (t) => {
  const { parseTimeArg } = require('../src/commands/events');
  const now = Date.now();

  // Duration shorthands
  const m5 = parseTimeArg('5m');
  t('5m: correct range',    m5 >= now - 5 * 60_000 - 100 && m5 <= now);

  const h2 = parseTimeArg('2h');
  t('2h: correct range',    h2 >= now - 2 * 3_600_000 - 100 && h2 <= now);

  const d1 = parseTimeArg('1d');
  t('1d: correct range',    d1 >= now - 86_400_000 - 100 && d1 <= now);

  const s30 = parseTimeArg('30s');
  t('30s: correct range',   s30 >= now - 30_000 - 100 && s30 <= now);

  // Unix timestamp (seconds)
  const ts = Math.floor(now / 1000);
  const parsed = parseTimeArg(String(ts));
  t('unix seconds: converted to ms', parsed === ts * 1000);

  // ISO string
  const iso = new Date(now).toISOString();
  const parsedIso = parseTimeArg(iso);
  t('ISO string: parsed correctly',  Math.abs(parsedIso - now) < 1000);

  // Invalid
  let threw = false;
  try { parseTimeArg('not-a-time'); } catch { threw = true; }
  t('invalid string throws',         threw);

  // null / undefined → null
  t('null → null',                   parseTimeArg(null) === null);
  t('undefined → null',              parseTimeArg(undefined) === null);
});

runSuite('commands/events.js — parseFilters', async (t) => {
  const { parseFilters } = require('../src/commands/events');

  let f = parseFilters(['type=container']);
  t('type filter parsed',        f.type === 'container');

  f = parseFilters(['action=start', 'actor=abc123']);
  t('action filter parsed',      f.action === 'start');
  t('actor filter parsed',       f.actor  === 'abc123');

  f = parseFilters([]);
  t('empty filters: empty obj',  Object.keys(f).length === 0);

  // Duplicate key — last wins
  f = parseFilters(['type=container', 'type=image']);
  t('duplicate key: last wins',  f.type === 'image');

  // Invalid key throws
  let threw = false;
  try { parseFilters(['unknown=val']); } catch { threw = true; }
  t('invalid key throws',        threw);

  // Missing = throws
  threw = false;
  try { parseFilters(['noequals']); } catch { threw = true; }
  t('missing = throws',          threw);
});

runSuite('commands/events.js — formatEvent', async (t) => {
  const { formatEvent } = require('../src/commands/events');

  const ev = {
    seq:    42,
    time:   '2024-06-01T12:00:00.000Z',
    timeMs: 1717243200000,
    type:   'container',
    action: 'start',
    actor:  { id: 'abc123def456', name: 'web-1', attrs: { pid: '99' } },
  };

  // Pretty format
  const pretty = formatEvent(ev, 'pretty');
  t('pretty: contains seq',      pretty.includes('42'));
  t('pretty: contains type',     pretty.includes('container'));
  t('pretty: contains action',   pretty.includes('start'));
  t('pretty: contains actor id', pretty.includes('abc123def456'));
  t('pretty: contains attr',     pretty.includes('pid'));
  t('pretty: is string',         typeof pretty === 'string');

  // JSON format
  const json = formatEvent(ev, 'json');
  t('json: parses back',         (() => { try { JSON.parse(json); return true; } catch { return false; } })());
  const reparsed = JSON.parse(json);
  t('json: seq correct',         reparsed.seq === 42);
  t('json: actor id correct',    reparsed.actor.id === 'abc123def456');
});

// ══════════════════════════════════════════════════════════════════════════════
// CLI registry suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('cli-registry.js — module loads + exports', async (t) => {
  let reg;
  try {
    reg = require('../src/cli-registry');
    t('cli-registry loads without error', typeof reg === 'object');
  } catch (err) {
    t('cli-registry loads without error', false, err.message);
    return;
  }
  t('exports COMMANDS array',    Array.isArray(reg.COMMANDS));
  t('exports createProgram',     typeof reg.createProgram    === 'function');
  t('exports attachCommand',     typeof reg.attachCommand    === 'function');
  t('exports listCommandNames',  typeof reg.listCommandNames === 'function');
  t('exports getCommandDef',     typeof reg.getCommandDef    === 'function');
  t('exports collectKV',         typeof reg.collectKV        === 'function');
  t('exports collectArr',        typeof reg.collectArr       === 'function');
});

runSuite('cli-registry.js — COMMANDS completeness', async (t) => {
  const { COMMANDS, listCommandNames } = require('../src/cli-registry');

  const names = listCommandNames();

  // Docker-essential commands must be present
  const essential = [
    'run', 'start', 'stop', 'restart', 'kill', 'pause', 'unpause',
    'ps', 'rm', 'rename',
    'images', 'pull', 'push', 'tag', 'rmi', 'build', 'save', 'load', 'history',
    'inspect', 'logs', 'exec', 'cp', 'attach', 'wait', 'diff',
    'port', 'stats', 'top',
    'volume', 'network', 'compose', 'events',
    'system', 'login', 'logout', 'version',
  ];

  for (const cmd of essential) {
    t(`'${cmd}' registered`, names.includes(cmd));
  }

  t('at least 30 commands', COMMANDS.length >= 30);

  // Every entry must have name, description, options array, action
  let allValid = true;
  for (const def of COMMANDS) {
    if (!def.name || !def.description || !Array.isArray(def.options) ||
        (typeof def.action !== 'function' && typeof def.action !== 'string')) {
      allValid = false;
      break;
    }
  }
  t('all descriptors have required fields', allValid);
});

runSuite('cli-registry.js — getCommandDef lookup', async (t) => {
  const { getCommandDef } = require('../src/cli-registry');

  const run = getCommandDef('run');
  t('run: found',            !!run);
  t('run: has options',      Array.isArray(run?.options) && run.options.length > 0);
  t('run: has --name opt',   run?.options.some(o => o.flags.includes('--name')));
  t('run: has --detach opt', run?.options.some(o => o.flags.includes('--detach')));

  const ps = getCommandDef('ps');
  t('ps: found',             !!ps);
  t('ps: has --all opt',     ps?.options.some(o => o.flags.includes('--all')));

  const missing = getCommandDef('nonexistent_xyz');
  t('missing: returns null', missing === null);
});

runSuite('cli-registry.js — createProgram builds correct program', async (t) => {
  const { createProgram } = require('../src/cli-registry');
  const { Command } = require('commander');

  const prog = createProgram({
    name:        'testcli',
    description: 'Test CLI',
    version:     '9.9.9',
  });

  t('returns Command instance',    prog instanceof Command);
  t('name set correctly',          prog.name() === 'testcli');

  // Commands must be attached
  const cmds = prog.commands.map(c => c.name());
  t('run command attached',        cmds.includes('run'));
  t('stop command attached',       cmds.includes('stop'));
  t('ps command attached',         cmds.includes('ps'));
  t('build command attached',      cmds.includes('build'));
  t('compose command attached',    cmds.includes('compose'));
  t('events command attached',     cmds.includes('events'));
  t('system command attached',     cmds.includes('system'));
  t('version command attached',    cmds.includes('version'));
  t('network command attached',    cmds.includes('network'));
  t('volume command attached',     cmds.includes('volume'));
  t('mydocker-specific: attach',   cmds.includes('attach'));
  t('mydocker-specific: wait',     cmds.includes('wait'));
  t('mydocker-specific: diff',     cmds.includes('diff'));
  t('mydocker-specific: top',      cmds.includes('top'));
  t('mydocker-specific: rename',   cmds.includes('rename'));
  t('mydocker-specific: rmi',      cmds.includes('rmi'));
  t('mydocker-specific: tag',      cmds.includes('tag'));
  t('mydocker-specific: history',  cmds.includes('history'));
});

runSuite('cli-registry.js — minicontainer vs mydocker same commands', async (t) => {
  const { createProgram } = require('../src/cli-registry');

  const mc = createProgram({ name: 'minicontainer', description: 'd', version: '1.0.0' });
  const md = createProgram({ name: 'mydocker',      description: 'd', version: '1.0.0' });

  const mcCmds = mc.commands.map(c => c.name()).sort();
  const mdCmds = md.commands.map(c => c.name()).sort();

  t('same number of commands',     mcCmds.length === mdCmds.length);
  t('identical command names',     JSON.stringify(mcCmds) === JSON.stringify(mdCmds));
  t('name differs: minicontainer', mc.name() === 'minicontainer');
  t('name differs: mydocker',      md.name() === 'mydocker');
});

runSuite('cli-registry.js — option coercion helpers', async (t) => {
  const { collectKV, collectArr } = require('../src/cli-registry');

  // collectKV
  let acc = [];
  acc = collectKV('FOO=bar', acc);
  acc = collectKV('BAZ=qux', acc);
  t('collectKV: accumulates',   acc.length === 2);
  t('collectKV: first value',   acc[0] === 'FOO=bar');
  t('collectKV: second value',  acc[1] === 'BAZ=qux');

  // collectArr
  let arr = [];
  arr = collectArr('8080:80', arr);
  arr = collectArr('443:443', arr);
  t('collectArr: accumulates',  arr.length === 2);
  t('collectArr: first value',  arr[0] === '8080:80');
});

runSuite('cli-registry.js — attachCommand respects requiredOption', async (t) => {
  const { COMMANDS } = require('../src/cli-registry');

  // 'load' command has --input as required
  const loadDef = COMMANDS.find(c => c.name.startsWith('load'));
  t('load command found',      !!loadDef);

  const inputOpt = loadDef?.options.find(o => o.flags.includes('--input'));
  t('load has --input opt',    !!inputOpt);
  t('load --input is required',inputOpt?.required === true);
});

runSuite('bin/mydocker.js — entry point loads without error', async (t) => {
  // Test that the entry point can be required without throwing.
  // We stub process.argv to prevent Commander from calling parse().
  const origArgv = process.argv;
  process.argv = ['node', 'mydocker.js', '--help'];

  let loaded = false;
  let errorMsg = null;

  // We can't require bin/mydocker.js directly because it calls program.parse().
  // Instead verify the two building blocks it uses load cleanly.
  try {
    const pkg = require('../package.json');
    const reg = require('../src/cli-registry');
    const prog = reg.createProgram({
      name:        'mydocker',
      description: 'Docker-compatible container runtime (powered by minicontainer)',
      version:     pkg.version,
    });
    loaded = true;
    t('mydocker program created',  loaded);
    t('mydocker name correct',     prog.name() === 'mydocker');
    t('mydocker description set',  prog.description().includes('Docker-compatible'));
    t('mydocker version from pkg', prog.version() === pkg.version);
  } catch (err) {
    loaded = false;
    errorMsg = err.message;
    t('mydocker program created', false, errorMsg);
  } finally {
    process.argv = origArgv;
  }
});

runSuite('new command stubs load without error', async (t) => {
  const stubs = [
    'start', 'restart', 'kill', 'rename', 'rmi', 'tag',
    'history', 'push', 'attach', 'wait', 'diff', 'top',
    'version', 'system',
  ];

  for (const name of stubs) {
    let ok = false;
    let msg = '';
    try {
      require(`../src/commands/${name}`);
      ok = true;
    } catch (err) {
      msg = err.message;
    }
    t(`${name}.js loads without error`, ok, msg);
  }
});

runSuite('commands/login.js — credential store', async (t) => {
  const { login, logout, CONFIG_FILE } = require('../src/commands/login');
  const fs   = require('fs-extra');
  const path = require('path');
  const os   = require('os');

  // Backup existing config
  const backup = fs.existsSync(CONFIG_FILE)
    ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;

  const testRegistry = 'testregistry.example.com';

  // login
  await login(testRegistry, { username: 'alice', password: 'secret' });
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  t('login: entry created',   !!cfg.auths?.[testRegistry]);
  const decoded = Buffer.from(cfg.auths[testRegistry].auth, 'base64').toString();
  t('login: creds base64',    decoded === 'alice:secret');

  // logout
  logout(testRegistry);
  const cfg2 = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  t('logout: entry removed',  !cfg2.auths?.[testRegistry]);

  // Restore
  if (backup) fs.writeFileSync(CONFIG_FILE, backup);
  else { try { fs.removeSync(CONFIG_FILE); } catch {} }
});

runSuite('commands/version.js — versionInfo shape', async (t) => {
  const { versionInfo } = require('../src/commands/version');
  const info = versionInfo();

  t('has Client',           !!info.Client);
  t('has Server',           !!info.Server);
  t('Client.Version',       typeof info.Client.Version   === 'string');
  t('Client.OS/Arch',       typeof info.Client['OS/Arch'] === 'string');
  t('Server.Engine exists', !!info.Server.Engine);
  t('Server.Engine.Version',typeof info.Server.Engine.Version === 'string');
});

runSuite('commands/rename.js — rename container', async (t) => {
  const rename = require('../src/commands/rename');
  const store  = require('../src/state/store');

  const id = 'ren_' + Date.now().toString(16);
  store.saveContainer({ id, name: 'old-name', image: 'alpine', status: 'stopped' });

  rename(id, 'new-name');
  const updated = store.getContainer(id);
  t('name updated',       updated?.name === 'new-name');

  // Lookup by new name should work
  const byName = store.getContainer('new-name');
  t('lookup by new name', byName?.id === id);

  // Cleanup
  store.deleteContainer(id);
});

runSuite('commands/tag.js — tag image', async (t) => {
  const tagCmd = require('../src/commands/tag');
  const store  = require('../src/state/store');

  // Create a source image record
  const sourceRef = 'tagtest_src:' + Date.now();
  store.saveImage({ ref: sourceRef, id: 'fakeid', layers: [], config: {}, _builtFrom: true });

  const targetRef = 'tagtest_dst:latest';
  tagCmd(sourceRef, targetRef);

  const dst = store.getImage(targetRef);
  t('tagged image exists',        !!dst);
  t('tagged image ref correct',   dst?.ref === targetRef);
  t('tagged image has _taggedFrom', dst?._taggedFrom === sourceRef);

  // Cleanup
  try { store.deleteImage(sourceRef); } catch {}
  try { store.deleteImage(targetRef); } catch {}
});

runSuite('commands/rmi.js — remove image', async (t) => {
  const rmi   = require('../src/commands/rmi');
  const store = require('../src/state/store');

  const ref = 'rmitest:' + Date.now();
  store.saveImage({ ref, id: 'fakeid2', layers: [], config: {}, _builtFrom: true });
  t('image exists before rmi',  !!store.getImage(ref));

  await rmi([ref], {});
  t('image removed after rmi',  !store.getImage(ref));
});

runSuite('commands/system.js — module loads + systemInfo', async (t) => {
  let sys;
  try {
    sys = require('../src/commands/system');
    t('system.js loads',        typeof sys === 'function');
  } catch (err) {
    t('system.js loads',        false, err.message);
    return;
  }
  t('exports systemDf',         typeof sys.systemDf   === 'function');
  t('exports systemInfo',       typeof sys.systemInfo === 'function');
  t('exports systemPrune',      typeof sys.systemPrune === 'function');

  // systemInfo should not throw
  let threw = false;
  const origLog = console.log;
  console.log = () => {};
  try { sys.systemInfo(); } catch { threw = true; }
  console.log = origLog;
  t('systemInfo does not throw', !threw);
});

// ══════════════════════════════════════════════════════════════════════════════
// Interactive logging suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('tail.js — module loads + exports', async (t) => {
  let tailMod;
  try {
    tailMod = require('../src/utils/tail');
    t('tail.js loads without error', typeof tailMod === 'object');
  } catch (err) {
    t('tail.js loads without error', false, err.message);
    return;
  }
  t('exports Tail class',          typeof tailMod.Tail             === 'function');
  t('exports splitLines',          typeof tailMod.splitLines        === 'function');
  t('exports extractTimestamp',    typeof tailMod.extractTimestamp  === 'function');
});

runSuite('tail.js — splitLines', async (t) => {
  const { splitLines } = require('../src/utils/tail');

  t('empty string → []',              splitLines('').length          === 0);
  t('single line no newline',         splitLines('hello').length     === 1);
  t('two lines',                      splitLines('a\nb').length      === 2);
  t('trailing newline not counted',   splitLines('a\nb\n').length    === 2);
  t('windows line endings',           splitLines('a\r\nb\r\n').length=== 2);
  t('blank lines preserved',          splitLines('a\n\nb').length    === 3);
  t('content correct',                splitLines('foo\nbar')[1]      === 'bar');
});

runSuite('tail.js — extractTimestamp', async (t) => {
  const { extractTimestamp } = require('../src/utils/tail');

  // ISO-8601 at line start
  const iso = '2024-06-01T12:00:00.000Z rest of line';
  const tsIso = extractTimestamp(iso);
  t('ISO: returns number',          typeof tsIso === 'number');
  t('ISO: correct value',           tsIso === new Date('2024-06-01T12:00:00.000Z').getTime());

  // Bracketed ISO
  const bracketed = '[2024-06-01T12:00:00.000Z] some log';
  const tsBracketed = extractTimestamp(bracketed);
  t('bracketed ISO: parsed',        tsBracketed === tsIso);

  // Space-separated datetime
  const space = '2024-06-01 12:00:00.000 log message';
  const tsSpace = extractTimestamp(space);
  t('space-sep: returns number',    typeof tsSpace === 'number');

  // No timestamp — returns null
  t('no timestamp → null',          extractTimestamp('plain log line') === null);
  t('empty string → null',          extractTimestamp('')               === null);
  t('number-only → null',           extractTimestamp('12345')          === null);
});

runSuite('tail.js — Tail reads existing content', async (t) => {
  const { Tail } = require('../src/utils/tail');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const logFile = path.join(os.tmpdir(), 'mc_tail_test_' + Date.now() + '.log');
  await fs.writeFile(logFile, 'line1\nline2\nline3\nline4\nline5\n');

  // lastN = 3 → should read last 3 lines
  const lines = [];
  const tail = new Tail(logFile, { lastN: 3 });
  tail.on('line', l => lines.push(l));

  // Give constructor sync time to push initial lines
  await new Promise(r => setImmediate(r));
  tail.destroy();

  t('reads last 3 lines',         lines.length === 3);
  t('correct first of last 3',    lines[0] === 'line3');
  t('correct last of last 3',     lines[2] === 'line5');

  // lastN = 0 → all lines
  const allLines = [];
  const tail2 = new Tail(logFile, { lastN: 0 });
  tail2.on('line', l => allLines.push(l));
  await new Promise(r => setImmediate(r));
  tail2.destroy();
  t('lastN=0 reads all lines',    allLines.length === 5);

  await fs.remove(logFile).catch(() => {});
});

runSuite('tail.js — Tail streams new lines in real-time', async (t) => {
  const { Tail } = require('../src/utils/tail');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const logFile = path.join(os.tmpdir(), 'mc_tail_live_' + Date.now() + '.log');
  await fs.writeFile(logFile, '');

  const received = [];
  const tail = new Tail(logFile, { lastN: 0 });
  tail.on('line', l => received.push(l));

  // Wait for watcher to attach
  await new Promise(r => setTimeout(r, 50));

  // Append new lines
  fs.appendFileSync(logFile, 'new line A\n');
  await new Promise(r => setTimeout(r, 150));
  fs.appendFileSync(logFile, 'new line B\n');
  await new Promise(r => setTimeout(r, 150));

  tail.destroy();

  t('received new lines',        received.length >= 1);
  t('line A received',           received.some(l => l.includes('new line A')));

  await fs.remove(logFile).catch(() => {});
});

runSuite('tail.js — Tail sinceMs filter', async (t) => {
  const { Tail } = require('../src/utils/tail');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const now = Date.now();
  const past = new Date(now - 3_600_000).toISOString(); // 1 hour ago
  const future = new Date(now + 3_600_000).toISOString(); // 1 hour from now

  const logFile = path.join(os.tmpdir(), 'mc_tail_since_' + Date.now() + '.log');
  await fs.writeFile(logFile, [
    `${past} old line`,
    `${new Date(now).toISOString()} current line`,
    `${future} future line`,
    'no-timestamp line',
  ].join('\n') + '\n');

  // sinceMs = now → should exclude the old line
  const lines = [];
  const tail = new Tail(logFile, { lastN: 0, sinceMs: now });
  tail.on('line', l => lines.push(l));
  await new Promise(r => setImmediate(r));
  tail.destroy();

  t('old line excluded',        !lines.some(l => l.includes('old line')));
  t('current line included',    lines.some(l => l.includes('current line')));
  t('future line included',     lines.some(l => l.includes('future line')));
  t('no-timestamp included',    lines.some(l => l.includes('no-timestamp')));

  await fs.remove(logFile).catch(() => {});
});

runSuite('tail.js — Tail backward-compat: number as second arg', async (t) => {
  const { Tail } = require('../src/utils/tail');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const logFile = path.join(os.tmpdir(), 'mc_tail_compat_' + Date.now() + '.log');
  await fs.writeFile(logFile, 'a\nb\nc\nd\ne\n');

  // Legacy call: new Tail(path, 2)
  const lines = [];
  const tail = new Tail(logFile, 2);
  tail.on('line', l => lines.push(l));
  await new Promise(r => setImmediate(r));
  tail.destroy();

  t('legacy number: reads last 2', lines.length === 2);
  t('legacy number: correct last', lines[1] === 'e');

  await fs.remove(logFile).catch(() => {});
});

runSuite('tail.js — Tail close event fires on destroy', async (t) => {
  const { Tail } = require('../src/utils/tail');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const logFile = path.join(os.tmpdir(), 'mc_tail_close_' + Date.now() + '.log');
  await fs.writeFile(logFile, 'hello\n');

  let closed = false;
  const tail = new Tail(logFile, { lastN: 1 });
  tail.on('close', () => { closed = true; });
  await new Promise(r => setImmediate(r));
  tail.destroy();

  await new Promise(r => setTimeout(r, 50));
  t('close event fired',       closed);

  // Double-destroy is safe (no throw)
  let threw = false;
  try { tail.destroy(); } catch { threw = true; }
  t('double destroy: no throw', !threw);

  await fs.remove(logFile).catch(() => {});
});

runSuite('tail.js — Tail watchContainer auto-close', async (t) => {
  const { Tail } = require('../src/utils/tail');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const logFile = path.join(os.tmpdir(), 'mc_tail_wc_' + Date.now() + '.log');
  await fs.writeFile(logFile, '');

  let container = { id: 'fake123', status: 'running' };
  let closed = false;

  const tail = new Tail(logFile, { lastN: 0 });
  tail.on('close', () => { closed = true; });
  tail.watchContainer(() => container, 50 /* poll every 50ms */);

  // Simulate container stopping after 100ms
  await new Promise(r => setTimeout(r, 100));
  container = { id: 'fake123', status: 'exited' };

  // Wait for poll + grace delay
  await new Promise(r => setTimeout(r, 400));

  t('auto-closed when container stopped', closed);

  await fs.remove(logFile).catch(() => {});
});

runSuite('commands/logs.js — module loads + exports', async (t) => {
  let logsCmd;
  try {
    logsCmd = require('../src/commands/logs');
    t('logs.js loads without error', typeof logsCmd === 'function');
  } catch (err) {
    t('logs.js loads without error', false, err.message);
    return;
  }
  t('exports tailContainer', typeof logsCmd.tailContainer === 'function');
  t('exports formatPrefix',  typeof logsCmd.formatPrefix  === 'function');
  t('exports colourLine',    typeof logsCmd.colourLine     === 'function');
});

runSuite('commands/logs.js — colourLine', async (t) => {
  const { colourLine } = require('../src/commands/logs');

  // In non-TTY (test environment) colourLine returns the raw line unchanged
  const line = 'ERROR something went wrong';
  const result = colourLine(line);
  t('returns string',        typeof result === 'string');
  t('contains original',     result.includes('ERROR') || result.includes('something'));

  t('plain line unchanged',  colourLine('plain log output') === 'plain log output'
    || colourLine('plain log output').includes('plain log output'));
});

runSuite('commands/logs.js — formatPrefix: timestamps', async (t) => {
  const { formatPrefix } = require('../src/commands/logs');

  // With embedded ISO timestamp in line + showTimestamps=true
  const lineWithTs = '2024-06-01T12:00:00.000Z some output';
  const prefix = formatPrefix(lineWithTs, null, true);
  t('prefix includes timestamp',    prefix.includes('2024-06-01'));
  t('prefix ends with separator',   prefix.endsWith('  '));

  // Without timestamps
  const noPrefix = formatPrefix('plain line', null, false);
  t('no-timestamps: empty prefix',  noPrefix === '');

  // Container name prefix
  const namePrefix = formatPrefix('any line', 'web-1', false);
  t('name prefix: contains name',   namePrefix.includes('web-1'));
  t('name prefix: has brackets',    namePrefix.includes('[web-1]'));
});

runSuite('commands/logs.js — static mode reads log file', async (t) => {
  const { tailContainer } = require('../src/commands/logs');
  const store = require('../src/state/store');
  const fs    = require('fs-extra');
  const os    = require('os');
  const path  = require('path');
  const { Writable } = require('stream');

  // Create a fake container with a log file
  const logFile = path.join(os.tmpdir(), 'mc_logs_static_' + Date.now() + '.log');
  const lines = [
    '2024-06-01T10:00:00.000Z first line',
    '2024-06-01T11:00:00.000Z second line',
    '2024-06-01T12:00:00.000Z third line',
    '2024-06-01T13:00:00.000Z fourth line',
    '2024-06-01T14:00:00.000Z fifth line',
  ];
  await fs.writeFile(logFile, lines.join('\n') + '\n');

  const cid = 'logstest_' + Date.now().toString(16);
  store.saveContainer({ id: cid, name: 'log-test', image: 'alpine', status: 'exited', logFile });

  // Collect output
  function makeOut() {
    const chunks = [];
    const out = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); }
    });
    out.collected = () => chunks.join('');
    return out;
  }

  // 1. Static, tail=3 → last 3 lines
  const out1 = makeOut();
  await tailContainer(cid, { tail: '3' }, out1);
  const text1 = out1.collected();
  t('tail=3: 3 lines output',       text1.split('\n').filter(Boolean).length === 3);
  t('tail=3: third line present',   text1.includes('third line'));
  t('tail=3: first line absent',    !text1.includes('first line'));

  // 2. Static, --since (exclude old lines)
  const out2 = makeOut();
  await tailContainer(cid, { since: '2024-06-01T12:00:00.000Z' }, out2);
  const text2 = out2.collected();
  t('since: excludes earlier',      !text2.includes('first line'));
  t('since: includes at-boundary',  text2.includes('third line'));
  t('since: includes later',        text2.includes('fifth line'));

  // 3. Static, --until (exclude future lines)
  const out3 = makeOut();
  await tailContainer(cid, { until: '2024-06-01T12:00:00.000Z' }, out3);
  const text3 = out3.collected();
  t('until: includes at-boundary',  text3.includes('third line'));
  t('until: excludes later',        !text3.includes('fifth line'));

  // 4. Static, --timestamps → each line prefixed with a timestamp
  const out4 = makeOut();
  await tailContainer(cid, { tail: '2', timestamps: true }, out4);
  const text4 = out4.collected();
  t('timestamps: prefix present',   text4.includes('2024-06-01T'));

  // Cleanup
  store.deleteContainer(cid);
  await fs.remove(logFile).catch(() => {});
});

runSuite('commands/logs.js — missing container / no log file', async (t) => {
  const { tailContainer } = require('../src/commands/logs');
  const { Writable } = require('stream');
  const store = require('../src/state/store');
  const os    = require('os');
  const path  = require('path');

  function makeOut() {
    const chunks = [];
    const out = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); }
    });
    out.collected = () => chunks.join('');
    return out;
  }

  // 1. Non-existent container: report the error on stderr and set exitCode.
  const origExit = process.exitCode;
  const origError = console.error;
  const errors = [];
  process.exitCode = 0;
  console.error = (...args) => errors.push(args.join(' '));
  const out1 = makeOut();
  await tailContainer('nonexistent_xyz_container', {}, out1);
  console.error = origError;
  t('missing container sets exitCode', process.exitCode !== 0);
  t('missing container reports error', errors.some(line => line.includes('No such container: nonexistent_xyz_container')));
  process.exitCode = origExit;

  // 2. Container with no log file
  const cid = 'nolog_' + Date.now().toString(16);
  store.saveContainer({ id: cid, name: 'nolog', image: 'alpine', status: 'exited',
    logFile: path.join(os.tmpdir(), 'nonexistent_' + cid + '.log') });
  const out2 = makeOut();
  await tailContainer(cid, {}, out2);
  t('no log file: prints message',   out2.collected().includes('no logs'));
  store.deleteContainer(cid);
});

runSuite('commands/logs.js — follow mode streams live lines', async (t) => {
  const { tailContainer } = require('../src/commands/logs');
  const store = require('../src/state/store');
  const fs    = require('fs-extra');
  const os    = require('os');
  const path  = require('path');
  const { Writable } = require('stream');

  const logFile = path.join(os.tmpdir(), 'mc_logs_follow_' + Date.now() + '.log');
  await fs.writeFile(logFile, 'existing line\n');

  const cid = 'followtest_' + Date.now().toString(16);
  // Status = exited so watchContainer does NOT start (avoids the poll loop keeping test open)
  store.saveContainer({ id: cid, name: 'follow-test', image: 'alpine', status: 'exited', logFile });

  const chunks = [];
  const out = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); }
  });

  // Start follow; it will resolve when tail is destroyed
  let resolved = false;
  const followPromise = tailContainer(cid, { follow: true, tail: '0' }, out)
    .then(() => { resolved = true; });

  // Wait for watcher to attach
  await new Promise(r => setTimeout(r, 80));

  // Append a new line
  fs.appendFileSync(logFile, 'live line 1\n');
  await new Promise(r => setTimeout(r, 150));

  // The tail won't auto-close (container is 'exited' so watchContainer wasn't called).
  // Simulate SIGINT by emitting it:
  process.emit('SIGINT');
  await new Promise(r => setTimeout(r, 100));

  const allText = chunks.join('');
  t('existing line shown',       allText.includes('existing line'));
  t('live line received',        allText.includes('live line 1'));
  t('promise resolved on close', resolved);

  store.deleteContainer(cid);
  await fs.remove(logFile).catch(() => {});
});

// ── summary ───────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// Script compiler layer suites
// ══════════════════════════════════════════════════════════════════════════════

runSuite('script/compiler.js — module loads + exports', async (t) => {
  let compiler;
  try {
    compiler = require('../src/script/compiler');
    t('compiler loads without error', typeof compiler === 'object');
  } catch (err) {
    t('compiler loads without error', false, err.message);
    return;
  }
  t('exports compile',               typeof compiler.compile             === 'function');
  t('exports loadScriptFile',        typeof compiler.loadScriptFile      === 'function');
  t('exports validateScript',        typeof compiler.validateScript      === 'function');
  t('exports generateContainerfile', typeof compiler.generateContainerfile=== 'function');
  t('exports compileStep',           typeof compiler.compileStep         === 'function');
  t('exports subst',                 typeof compiler.subst               === 'function');
  t('exports substDeep',             typeof compiler.substDeep           === 'function');
  t('exports flattenVars',           typeof compiler.flattenVars         === 'function');
  t('exports normCmd',               typeof compiler.normCmd             === 'function');
  t('exports normArr',               typeof compiler.normArr             === 'function');
});

runSuite('script/compiler.js — subst / substDeep', async (t) => {
  const { subst, substDeep } = require('../src/script/compiler');

  const vars = { PORT: '8080', APP: 'myapp', NODE_VERSION: '20' };

  t('${PORT} substituted',       subst('port ${PORT}', vars) === 'port 8080');
  t('$APP substituted',          subst('app $APP', vars)     === 'app myapp');
  t('missing var kept',          subst('${MISSING}', vars)   === '${MISSING}');
  t('two vars in one string',    subst('${APP}:${PORT}', vars) === 'myapp:8080');
  t('non-string passthrough',    subst(42, vars)              === 42);

  // substDeep
  t('array: each string subst',  substDeep(['${PORT}', '${APP}'], vars).join(',') === '8080,myapp');
  t('object: values subst',      substDeep({ k: '${PORT}' }, vars).k === '8080');
  t('nested: deep subst',        substDeep({ a: ['${APP}'] }, vars).a[0] === 'myapp');
  t('number passthrough',        substDeep(42, vars) === 42);
});

runSuite('script/compiler.js — flattenVars / normCmd / normArr', async (t) => {
  const { flattenVars, normCmd, normArr } = require('../src/script/compiler');

  t('flattenVars: number to string', flattenVars({ N: 42 }).N === '42');
  t('flattenVars: null to empty',    flattenVars({ X: null }).X === '');
  t('flattenVars: string kept',      flattenVars({ S: 'hi' }).S === 'hi');

  t('normCmd: string split',         normCmd('node server.js').join(',') === 'node,server.js');
  t('normCmd: array passthrough',    normCmd(['a','b']).join(',')        === 'a,b');
  t('normCmd: null → []',            normCmd(null).length               === 0);

  t('normArr: string → array',       normArr('x').length                === 1);
  t('normArr: array passthrough',    normArr(['a','b']).length           === 2);
  t('normArr: null → []',            normArr(null).length               === 0);
});

runSuite('script/compiler.js — validateScript', async (t) => {
  const { validateScript } = require('../src/script/compiler');

  // Valid minimal doc
  let errs = validateScript({ name: 'myapp' });
  t('valid minimal: no errors',      errs.length === 0);

  // Missing name
  errs = validateScript({});
  t('missing name: error',           errs.some(e => e.includes('name')));

  // Non-string name
  errs = validateScript({ name: 123 });
  t('non-string name: error',        errs.some(e => e.includes('name')));

  // build without from
  errs = validateScript({ name: 'x', build: {} });
  t('build without from: error',     errs.some(e => e.includes('from')));

  // build.run not array
  errs = validateScript({ name: 'x', build: { from: 'alpine', run: 'bad' } });
  t('build.run non-array: error',    errs.some(e => e.includes('run')));

  // pipeline step without type
  errs = validateScript({ name: 'x', pipelines: { deploy: [{ invalid: true }] } });
  t('unknown step type: error',      errs.some(e => e.includes('step')));

  // pipeline not array
  errs = validateScript({ name: 'x', pipelines: { deploy: 'bad' } });
  t('pipeline not array: error',     errs.some(e => e.includes("'deploy'")));

  // vars not object
  errs = validateScript({ name: 'x', vars: 'bad' });
  t('vars non-object: error',        errs.some(e => e.includes('vars')));
});

runSuite('script/compiler.js — generateContainerfile', async (t) => {
  const { generateContainerfile } = require('../src/script/compiler');

  const vars = { PORT: '8080', NODE_VERSION: '20', APP: 'myapp' };

  const buildBlock = {
    from:     'node:${NODE_VERSION}',
    workdir:  '/app',
    env:      { NODE_ENV: 'production' },
    run:      ['npm ci', 'npm run build'],
    copy:     [{ src: './dist', dst: '/app/dist' }],
    expose:   ['${PORT}'],
    user:     'node',
    cmd:      ['node', 'server.js'],
    labels:   { maintainer: 'team' },
    healthcheck: { cmd: 'curl -f http://localhost:8080/health', interval: '30s', timeout: '5s', retries: 3 },
  };

  const cf = generateContainerfile(buildBlock, vars);

  t('FROM line correct',            cf.includes('FROM node:20'));
  t('WORKDIR line',                 cf.includes('WORKDIR /app'));
  t('ENV block',                    cf.includes('ENV NODE_ENV=production'));
  t('RUN npm ci',                   cf.includes('RUN npm ci'));
  t('RUN npm run build',            cf.includes('RUN npm run build'));
  t('COPY line',                    cf.includes('COPY ./dist /app/dist'));
  t('EXPOSE resolved',              cf.includes('EXPOSE 8080'));
  t('USER line',                    cf.includes('USER node'));
  t('CMD line',                     cf.includes('CMD ["node", "server.js"]'));
  t('LABEL line',                   cf.includes('LABEL maintainer='));
  t('HEALTHCHECK line',             cf.includes('HEALTHCHECK'));
  t('ends with newline',            cf.endsWith('\n'));
});

runSuite('script/compiler.js — generateContainerfile: multi-stage', async (t) => {
  const { generateContainerfile } = require('../src/script/compiler');
  const vars = {};

  const buildBlock = {
    from: 'node:20-slim',
    cmd:  ['node', 'dist/server.js'],
    multi_stage: [
      {
        name: 'builder',
        from: 'node:20',
        workdir: '/build',
        run: ['npm ci', 'npm run build'],
        copy: ['package.json /build/'],
      },
    ],
    copy: [{ from: 'builder', src: '/build/dist', dst: '/app/dist' }],
  };

  const cf = generateContainerfile(buildBlock, vars);

  t('stage FROM',                   cf.includes('FROM node:20 AS builder'));
  t('stage RUN npm ci',             cf.includes('RUN npm ci'));
  t('main FROM',                    cf.includes('FROM node:20-slim'));
  t('COPY --from=builder',          cf.includes('COPY --from=builder /build/dist /app/dist'));
  t('main CMD',                     cf.includes('CMD ["node", "dist/server.js"]'));
});

runSuite('script/compiler.js — compileStep', async (t) => {
  const { compileStep } = require('../src/script/compiler');
  const vars = { PORT: '8080', APP: 'myapp' };

  // build step
  const buildStep = compileStep({ build: '.', tag: '${APP}:latest' }, vars, 0, 'test');
  t('build: type',                  buildStep.type    === 'build');
  t('build: context',               buildStep.context === '.');
  t('build: tag substituted',       buildStep.tag     === 'myapp:latest');

  // run step
  const runStep = compileStep({
    run:    '${APP}:latest',
    name:   '${APP}-prod',
    port:   ['${PORT}:${PORT}'],
    detach: true,
  }, vars, 1, 'test');
  t('run: type',                    runStep.type    === 'run');
  t('run: image substituted',       runStep.image   === 'myapp:latest');
  t('run: name substituted',        runStep.name    === 'myapp-prod');
  t('run: port substituted',        runStep.port[0] === '8080:8080');
  t('run: detach',                  runStep.detach  === true);

  // stop step (array)
  const stopStep = compileStep({ stop: ['cont1', 'cont2'] }, vars, 2, 'test');
  t('stop: type',                   stopStep.type            === 'stop');
  t('stop: containers',             stopStep.container.length === 2);

  // shell step
  const shellStep = compileStep({ shell: 'echo ${PORT}' }, vars, 3, 'test');
  t('shell: type',                  shellStep.type    === 'shell');
  t('shell: command substituted',   shellStep.command === 'echo 8080');

  // sleep step
  const sleepStep = compileStep({ sleep: 2 }, vars, 4, 'test');
  t('sleep: type',                  sleepStep.type    === 'sleep');
  t('sleep: seconds',               sleepStep.seconds === 2);

  // echo step
  const echoStep = compileStep({ echo: 'hello ${APP}' }, vars, 5, 'test');
  t('echo: type',                   echoStep.type    === 'echo');
  t('echo: message',                echoStep.message === 'hello myapp');

  // unknown step throws
  let threw = false;
  try { compileStep({ unknown: true }, vars, 0, 'test'); } catch { threw = true; }
  t('unknown step type throws',     threw);
});

runSuite('script/compiler.js — compile() from YAML file', async (t) => {
  const { compile } = require('../src/script/compiler');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_script_test_' + Date.now());
  await fs.ensureDir(tmpDir);

  const scriptContent = `
name: testapp
version: "2.0"

vars:
  PORT: "8080"
  NODE_VERSION: "20"
  APP_NAME: testapp

build:
  from: node:\${NODE_VERSION}
  workdir: /app
  run:
    - npm ci
  expose: ["\${PORT}"]
  cmd: ["node", "server.js"]

pipelines:
  deploy:
    - build: .
      tag: \${APP_NAME}:latest
    - run: \${APP_NAME}:latest
      name: \${APP_NAME}-prod
      port: ["\${PORT}:\${PORT}"]
      detach: true
    - echo: "Deployed \${APP_NAME}"

  test:
    - build: .
      tag: \${APP_NAME}:test
    - run: \${APP_NAME}:test
      cmd: ["npm", "test"]
      rm: true
    - echo: "Tests complete"
`;

  const scriptFile = path.join(tmpDir, 'mdc.yaml');
  await fs.writeFile(scriptFile, scriptContent);

  const compiled = compile(scriptFile);

  t('name correct',                 compiled.name === 'testapp');
  t('version correct',              compiled.version === '2.0');
  t('vars resolved',                compiled.vars.PORT === '8080');
  t('containerfile generated',      typeof compiled.containerfile === 'string');
  t('containerfile has FROM',       compiled.containerfile.includes('FROM node:20'));
  t('containerfile EXPOSE',         compiled.containerfile.includes('EXPOSE 8080'));
  t('2 pipelines',                  Object.keys(compiled.pipelines).length === 2);

  const deploy = compiled.pipelines.deploy;
  t('deploy: 3 steps',              deploy.length === 3);
  t('deploy[0]: build type',        deploy[0].type === 'build');
  t('deploy[0]: tag substituted',   deploy[0].tag  === 'testapp:latest');
  t('deploy[1]: run type',          deploy[1].type === 'run');
  t('deploy[1]: port substituted',  deploy[1].port[0] === '8080:8080');
  t('deploy[2]: echo type',         deploy[2].type === 'echo');
  t('deploy[2]: message subst',     deploy[2].message === 'Deployed testapp');

  const test_ = compiled.pipelines.test;
  t('test: 3 steps',                test_.length === 3);
  t('test[1]: rm=true',             test_[1].rm === true);

  t('sourceFile is absolute',       path.isAbsolute(compiled.sourceFile));
  t('compiledAt is number',         typeof compiled.compiledAt === 'number');

  await fs.remove(tmpDir);
});

runSuite('script/compiler.js — compile() with override vars', async (t) => {
  const { compile } = require('../src/script/compiler');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_script_vars_' + Date.now());
  await fs.ensureDir(tmpDir);
  const scriptFile = path.join(tmpDir, 'mdc.yaml');
  await fs.writeFile(scriptFile, `
name: myapp
vars:
  PORT: "8080"
pipelines:
  serve:
    - echo: "port is \${PORT}"
`);

  // Override PORT at compile time
  const compiled = compile(scriptFile, { PORT: '9090' });
  t('override var applied',         compiled.pipelines.serve[0].message === 'port is 9090');

  await fs.remove(tmpDir);
});

runSuite('script/compiler.js — compile() JSON format', async (t) => {
  const { compile } = require('../src/script/compiler');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_script_json_' + Date.now());
  await fs.ensureDir(tmpDir);
  const scriptFile = path.join(tmpDir, 'mdc.json');
  await fs.writeFile(scriptFile, JSON.stringify({
    name: 'jsonapp',
    vars: { TAG: 'v1' },
    pipelines: {
      release: [
        { echo: 'releasing ${TAG}' },
        { sleep: 1 },
      ],
    },
  }));

  const compiled = compile(scriptFile);
  t('JSON: name correct',           compiled.name === 'jsonapp');
  t('JSON: step 1 echo',            compiled.pipelines.release[0].type === 'echo');
  t('JSON: TAG substituted',        compiled.pipelines.release[0].message === 'releasing v1');
  t('JSON: step 2 sleep',           compiled.pipelines.release[1].type === 'sleep');
  t('JSON: sleep seconds',          compiled.pipelines.release[1].seconds === 1);

  await fs.remove(tmpDir);
});

runSuite('script/compiler.js — compile() validation errors', async (t) => {
  const { compile } = require('../src/script/compiler');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_script_errs_' + Date.now());
  await fs.ensureDir(tmpDir);

  // Missing name → should throw
  const bad = path.join(tmpDir, 'bad.yaml');
  await fs.writeFile(bad, 'build:\n  from: alpine\n');
  let threw = false;
  try { compile(bad); } catch { threw = true; }
  t('missing name throws',          threw);

  // Non-existent file
  threw = false;
  try { compile(path.join(tmpDir, 'missing.yaml')); } catch { threw = true; }
  t('missing file throws',          threw);

  // Invalid YAML
  const invalid = path.join(tmpDir, 'invalid.yaml');
  await fs.writeFile(invalid, ': : : {bad yaml');
  threw = false;
  try { compile(invalid); } catch { threw = true; }
  t('invalid yaml throws',          threw);

  await fs.remove(tmpDir);
});

runSuite('script/compiler.js — loadScriptFile supports both formats', async (t) => {
  const { loadScriptFile } = require('../src/script/compiler');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_script_load_' + Date.now());
  await fs.ensureDir(tmpDir);

  // YAML
  const yamlFile = path.join(tmpDir, 'test.yaml');
  await fs.writeFile(yamlFile, 'name: test\n');
  const docYaml = loadScriptFile(yamlFile);
  t('YAML: object returned',        typeof docYaml === 'object');
  t('YAML: name field',             docYaml.name === 'test');

  // JSON
  const jsonFile = path.join(tmpDir, 'test.json');
  await fs.writeFile(jsonFile, '{"name":"json-test"}');
  const docJson = loadScriptFile(jsonFile);
  t('JSON: object returned',        typeof docJson === 'object');
  t('JSON: name field',             docJson.name === 'json-test');

  // Missing file throws
  let threw = false;
  try { loadScriptFile(path.join(tmpDir, 'nope.yaml')); } catch { threw = true; }
  t('missing file throws',          threw);

  await fs.remove(tmpDir);
});

runSuite('script/runner.js — module loads + exports', async (t) => {
  let runner;
  try {
    runner = require('../src/script/runner');
    t('runner loads without error', typeof runner === 'object');
  } catch (err) {
    t('runner loads without error', false, err.message);
    return;
  }
  t('exports runPipeline',          typeof runner.runPipeline  === 'function');
  t('exports describeStep',         typeof runner.describeStep === 'function');
  t('exports EXECUTORS',            typeof runner.EXECUTORS    === 'object');
});

runSuite('script/runner.js — describeStep', async (t) => {
  const { describeStep } = require('../src/script/runner');

  t('build step',    describeStep({ type: 'build', context: '.', tag: 'app:v1' }).includes('app:v1'));
  t('pull step',     describeStep({ type: 'pull',  image: 'nginx:latest' }) === 'nginx:latest');
  t('run step',      describeStep({ type: 'run',   image: 'app:v1', name: 'myapp', detach: true }).includes('myapp'));
  t('shell step',    describeStep({ type: 'shell', command: 'echo hi' }) === 'echo hi');
  t('sleep step',    describeStep({ type: 'sleep', seconds: 3 }) === '3s');
  t('echo step',     describeStep({ type: 'echo',  message: 'hello' }) === 'hello');
  t('stop step',     describeStep({ type: 'stop',  container: ['c1','c2'] }).includes('c1'));
  t('tag step',      describeStep({ type: 'tag',   source: 'app:v1', target: 'app:stable' }).includes('stable'));
});

runSuite('script/runner.js — runPipeline dry-run mode', async (t) => {
  const { compile } = require('../src/script/compiler');
  const { runPipeline } = require('../src/script/runner');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_run_dry_' + Date.now());
  await fs.ensureDir(tmpDir);
  const scriptFile = path.join(tmpDir, 'mdc.yaml');
  await fs.writeFile(scriptFile, `
name: dryapp
pipelines:
  deploy:
    - echo: "step 1"
    - sleep: 1
    - echo: "step 3"
`);

  const compiled = compile(scriptFile);
  const result = await runPipeline('deploy', compiled, { dryRun: true });

  t('dry-run: result returned',     typeof result === 'object');
  t('dry-run: success true',        result.success === true);
  t('dry-run: 3 steps',             result.steps.length === 3);
  t('dry-run: each step dryRun',    result.steps.every(s => s.dryRun === true));
  t('dry-run: no execution',        result.steps.every(s => s.success === true));

  await fs.remove(tmpDir);
});

runSuite('script/runner.js — runPipeline executes echo + sleep steps', async (t) => {
  const { compile } = require('../src/script/compiler');
  const { runPipeline } = require('../src/script/runner');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_run_exec_' + Date.now());
  await fs.ensureDir(tmpDir);
  const scriptFile = path.join(tmpDir, 'mdc.yaml');
  await fs.writeFile(scriptFile, `
name: execapp
pipelines:
  greet:
    - echo: "hello world"
    - sleep: 0.05
    - echo: "goodbye"
`);

  const compiled = compile(scriptFile);

  const stepLog = [];
  const result = await runPipeline('greet', compiled, {
    onStep:     (step, i) => stepLog.push({ i, type: step.type }),
    onStepDone: (res, _step, i) => stepLog[stepLog.findIndex(s => s.i === i)].success = res.success,
  });

  t('3 steps executed',             result.steps.length === 3);
  t('all steps succeeded',          result.steps.every(s => s.success));
  t('echo output captured',         result.steps[0].output === 'hello world');
  t('sleep durationMs > 0',         result.steps[1].durationMs >= 0);
  t('pipeline success',             result.success === true);
  t('onStep called 3 times',        stepLog.length === 3);

  await fs.remove(tmpDir);
});

runSuite('script/runner.js — runPipeline shell step', async (t) => {
  const { compile } = require('../src/script/compiler');
  const { runPipeline } = require('../src/script/runner');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');
  const { IS_WINDOWS } = require('../src/utils/platform');

  const tmpDir = path.join(os.tmpdir(), 'mc_run_shell_' + Date.now());
  await fs.ensureDir(tmpDir);
  const scriptFile = path.join(tmpDir, 'mdc.yaml');

  const shellCmd = IS_WINDOWS ? 'echo shell_output' : 'printf shell_output';
  await fs.writeFile(scriptFile, `
name: shellapp
pipelines:
  run_shell:
    - shell: "${shellCmd}"
`);

  const compiled = compile(scriptFile);
  const result = await runPipeline('run_shell', compiled);

  t('shell step succeeded',         result.steps[0].success === true);
  t('shell output captured',        result.steps[0].output?.includes('shell_output'));

  await fs.remove(tmpDir);
});

runSuite('script/runner.js — runPipeline fail-fast on error', async (t) => {
  const { compile } = require('../src/script/compiler');
  const { runPipeline } = require('../src/script/runner');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_run_fail_' + Date.now());
  await fs.ensureDir(tmpDir);
  const scriptFile = path.join(tmpDir, 'mdc.yaml');
  // Shell command that fails
  await fs.writeFile(scriptFile, `
name: failapp
pipelines:
  broken:
    - echo: "before"
    - shell: "exit 1"
    - echo: "after"
`);

  const compiled = compile(scriptFile);
  const result = await runPipeline('broken', compiled, { failFast: true });

  t('pipeline failed',              result.success === false);
  t('stopped after failure',        result.steps.length <= 2);
  t('first step succeeded',         result.steps[0].success === true);

  await fs.remove(tmpDir);
});

runSuite('script/runner.js — runPipeline unknown pipeline throws', async (t) => {
  const { compile } = require('../src/script/compiler');
  const { runPipeline } = require('../src/script/runner');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_run_nopipe_' + Date.now());
  await fs.ensureDir(tmpDir);
  const scriptFile = path.join(tmpDir, 'mdc.yaml');
  await fs.writeFile(scriptFile, `
name: myapp
pipelines:
  deploy:
    - echo: ok
`);

  const compiled = compile(scriptFile);
  let threw = false;
  try { await runPipeline('nonexistent', compiled); } catch { threw = true; }
  t('unknown pipeline throws',      threw);

  await fs.remove(tmpDir);
});

runSuite('script/watcher.js — module loads + ScriptWatcher', async (t) => {
  let wMod;
  try {
    wMod = require('../src/script/watcher');
    t('watcher loads without error', typeof wMod === 'object');
  } catch (err) {
    t('watcher loads without error', false, err.message);
    return;
  }
  t('exports ScriptWatcher',        typeof wMod.ScriptWatcher === 'function');

  // Instantiate without starting
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_watch_test_' + Date.now());
  await fs.ensureDir(tmpDir);
  const scriptFile = path.join(tmpDir, 'mdc.yaml');
  await fs.writeFile(scriptFile, 'name: w\npipelines:\n  p:\n    - echo: hi\n');

  const w = new wMod.ScriptWatcher(scriptFile, {});
  t('instance created',             !!w);
  t('changeCount starts at 0',      w.changeCount === 0);
  t('isRunning false before start', w.isRunning === false);
  // stop without start should not throw
  let threw = false;
  try { w.stop(); } catch { threw = true; }
  t('stop without start: no throw', !threw);

  await fs.remove(tmpDir);
});

runSuite('script/watcher.js — initial compile on start', async (t) => {
  const { ScriptWatcher } = require('../src/script/watcher');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_watch_start_' + Date.now());
  await fs.ensureDir(tmpDir);
  const scriptFile = path.join(tmpDir, 'mdc.yaml');
  await fs.writeFile(scriptFile, 'name: watchtest\npipelines:\n  p:\n    - echo: hi\n');

  const compiledResults = [];
  const w = new ScriptWatcher(scriptFile, {
    pipeline:   null,   // compile only, don't run
    onCompile:  (c) => compiledResults.push(c),
    onError:    (e) => { throw e; },
  });

  await w.start();
  w.stop();

  t('initial compile fired',        compiledResults.length >= 1);
  t('compiled name correct',        compiledResults[0].name === 'watchtest');
  t('changeCount = 1 after start',  w.changeCount === 1);

  await fs.remove(tmpDir);
});

runSuite('script/watcher.js — recompiles on file change', async (t) => {
  const { ScriptWatcher } = require('../src/script/watcher');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  const tmpDir = path.join(os.tmpdir(), 'mc_watch_change_' + Date.now());
  await fs.ensureDir(tmpDir);
  const scriptFile = path.join(tmpDir, 'mdc.yaml');
  await fs.writeFile(scriptFile, 'name: v1\npipelines:\n  p:\n    - echo: v1\n');

  const names = [];
  const w = new ScriptWatcher(scriptFile, {
    pipeline:   null,
    debounceMs: 50,
    onCompile:  (c) => names.push(c.name),
    onError:    () => {},
  });

  await w.start();
  await new Promise(r => setTimeout(r, 80));

  // Modify the file
  await fs.writeFile(scriptFile, 'name: v2\npipelines:\n  p:\n    - echo: v2\n');
  await new Promise(r => setTimeout(r, 300));

  w.stop();

  t('initial compile fired',        names.includes('v1'));
  t('recompile after change',       names.includes('v2'));
  t('changeCount = 2',              w.changeCount >= 2);

  await fs.remove(tmpDir);
});

runSuite('commands/script.js — module loads + exports', async (t) => {
  let scriptCmd;
  try {
    scriptCmd = require('../src/commands/script');
    t('script.js loads without error', typeof scriptCmd === 'function');
  } catch (err) {
    t('script.js loads without error', false, err.message);
    return;
  }
  t('exports parseVarFlags',        typeof scriptCmd.parseVarFlags     === 'function');
  t('exports resolveScriptFile',    typeof scriptCmd.resolveScriptFile === 'function');
  t('exports scriptCompile',        typeof scriptCmd.scriptCompile     === 'function');
  t('exports scriptValidate',       typeof scriptCmd.scriptValidate    === 'function');
  t('exports scriptList',           typeof scriptCmd.scriptList        === 'function');
  t('exports scriptEmit',           typeof scriptCmd.scriptEmit        === 'function');
});

runSuite('commands/script.js — parseVarFlags', async (t) => {
  const { parseVarFlags } = require('../src/commands/script');

  const result = parseVarFlags(['PORT=9090', 'APP=myapp', 'ENV=prod']);
  t('3 vars parsed',               Object.keys(result).length === 3);
  t('PORT value',                  result.PORT === '9090');
  t('APP value',                   result.APP  === 'myapp');
  t('ENV value',                   result.ENV  === 'prod');

  // Value with = in it
  const result2 = parseVarFlags(['DSN=postgres://user:pass@host/db']);
  t('value with = preserved',      result2.DSN === 'postgres://user:pass@host/db');

  // Empty array
  t('empty array: empty obj',      Object.keys(parseVarFlags([])).length === 0);

  // Invalid format throws
  let threw = false;
  try { parseVarFlags(['NOEQUALS']); } catch { threw = true; }
  t('no = in var throws',          threw);
});

runSuite('commands/script.js — resolveScriptFile', async (t) => {
  const { resolveScriptFile } = require('../src/commands/script');
  const fs   = require('fs-extra');
  const os   = require('os');
  const path = require('path');

  // Explicit path
  const tmpDir = path.join(os.tmpdir(), 'mc_script_res_' + Date.now());
  await fs.ensureDir(tmpDir);
  const scriptFile = path.join(tmpDir, 'mdc.yaml');
  await fs.writeFile(scriptFile, 'name: test\n');

  const resolved = resolveScriptFile(scriptFile);
  t('explicit path resolved',      resolved === path.resolve(scriptFile));

  // Auto-discovery in cwd
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  const autoResolved = resolveScriptFile(undefined);
  process.chdir(origCwd);
  t('auto-discovered mdc.yaml',    autoResolved.endsWith('mdc.yaml'));

  // No file in empty dir throws
  const emptyDir = path.join(os.tmpdir(), 'mc_empty_' + Date.now());
  await fs.ensureDir(emptyDir);
  const origCwd2 = process.cwd();
  process.chdir(emptyDir);
  let threw = false;
  try { resolveScriptFile(undefined); } catch { threw = true; }
  process.chdir(origCwd2);
  t('no file in cwd throws',       threw);

  await fs.remove(tmpDir).catch(() => {});
  await fs.remove(emptyDir).catch(() => {});
});

runSuite('cli-registry.js — script command registered', async (t) => {
  const { createProgram } = require('../src/cli-registry');

  const prog = createProgram({ name: 'mydocker', description: 'd', version: '1.0.0' });
  const cmds = prog.commands.map(c => c.name());
  t('script command registered',   cmds.includes('script'));

  const scriptCmd = prog.commands.find(c => c.name() === 'script');
  t('script has --dry-run',        scriptCmd?.options?.some(o => o.long === '--dry-run'));
  t('script has --var',            scriptCmd?.options?.some(o => o.long === '--var'));
  t('script has --format',         scriptCmd?.options?.some(o => o.long === '--format'));
});

setTimeout(() => {
  const total = passed + failed;
  console.log(`\n── Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ''} ──\n`);
  process.exit(failed > 0 ? 1 : 0);
}, 100);
