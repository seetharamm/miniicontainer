'use strict';
/**
 * Container runtime — creates and manages container processes.
 *
 * On Linux:
 *   Uses "unshare" to create PID, NET, UTS, IPC, and MNT namespaces and
 *   "chroot" for filesystem isolation.
 *   After spawn, connectContainer() wires a veth pair into the container's
 *   network namespace and configures an IP + default route so the container
 *   can reach the internet.
 *
 * On Windows:
 *   Container processes share the host network stack — internet access
 *   works automatically.  Port forwarding uses netsh portproxy.
 */

const path    = require('path');
const fs      = require('fs-extra');
const { spawn } = require('child_process');
const chalk   = require('chalk');

const store       = require('../state/store');
const { shortId } = require('../utils/ids');
const { unpackImage } = require('../image/puller');
const { IS_WINDOWS, IS_LINUX } = require('../utils/platform');
const network     = require('../network/bridge');
const dns         = require('../network/dns');
const netState    = require('../network/state');
const portmap     = require('../network/portmap');
const { createCgroup, parseMemory, cpusToCfsQuota } = require('./cgroups');
const volumes = require('./volumes');
const { parseEnv, buildRuntimeEnv } = require('./config');
const overlay = require('./overlay');

// ------------------------------------------------------------------ run

/**
 * Create and start a container.
 * @param {object} opts
 *   image, name, cmd, env[], volume[], port[], detach, rm, memory, cpus
 */
async function runContainer(opts) {
  const { image: imageRef, name, cmd, env = [], volume = [], port = [],
          detach = false, rm: autoRemove = false,
          memory, cpus, pidsLimit, blkio, user } = opts;

  // Resolve image
  let imageRecord = store.getImage(imageRef);
  if (!imageRecord) {
    // Attempt auto-pull
    console.log(chalk.yellow(`Image '${imageRef}' not found locally. Pulling...`));
    const { pullImage } = require('../image/puller');
    imageRecord = await pullImage(imageRef);
  }

  const id  = shortId();
  const cName = name || `mc_${id}`;
  const cDir = store.containerDir(id);
  const rootfs = path.join(cDir, 'rootfs');
  const logFile = path.join(cDir, 'container.log');
  let overlayMounted = false;

  await fs.ensureDir(cDir);
  await fs.ensureDir(rootfs);

  // Reuse a cached lower layer on Linux. If OverlayFS is unavailable,
  // preserve the existing extraction path as a fallback.
  if (IS_LINUX) {
    try {
      const lowerDir = await overlay.prepareLower(imageRecord);
      overlayMounted = await overlay.mountOverlay(
        lowerDir,
        path.join(cDir, 'overlay', 'upper'),
        path.join(cDir, 'overlay', 'work'),
        rootfs
      );
    } catch (overlayErr) {
      console.warn(chalk.yellow(`  OverlayFS unavailable; extracting image: ${overlayErr.message}`));
    }
  }
  if (!overlayMounted) await unpackImage(imageRecord, rootfs);

  // Mount /proc, /sys, /dev and inject resolv.conf (Linux only; no-op on Windows)
  await prepareRootfs(rootfs);

  // ── Parse and validate volume specs before starting the container ─────────
  // Bad specs throw here rather than after the container is running.
  let volumeSpecs = [];
  if (volume.length > 0) {
    try {
      volumeSpecs = volumes.parseVolumeSpecs(volume);
    } catch (volErr) {
      throw new Error(`Invalid volume spec: ${volErr.message}`);
    }
    // Apply the mounts into rootfs
    await volumes.mountVolumes(volumeSpecs, rootfs, id);
  }

  let runtimeEnv;
  try {
    runtimeEnv = parseEnv(env);
  } catch (envErr) {
    throw new Error(`Invalid environment configuration: ${envErr.message}`);
  }

  // Derive a hostname from the container name (sanitise to valid hostname chars)
  const hostname = cName.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 63);

  const record = {
    id,
    name:      cName,
    hostname,
    image:     imageRef,
    imageId:   imageRecord.id,
    status:    'created',
    pid:       null,
    ip:        null,
    created:   new Date().toISOString(),
    startedAt: null,
    exitedAt:  null,
    exitCode:  null,
    rootfs,
    logFile,
    cmd:       cmd.length ? cmd : (imageRecord.config?.cmd || []),
    user:      user || imageRecord.config?.user || '',
    env:       Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`),
    volume,
    volumeSpecs: volumeSpecs.map(s => ({ ...s })), // serialise for store
    port,
    autoRemove,
  };

  // ── Validate resource limits early so bad values fail before spawn ───────
  let cgroupLimits = {};
  if (memory || cpus || pidsLimit || blkio) {
    try {
      if (memory)    parseMemory(memory);            // throws on bad value
      if (cpus)      cpusToCfsQuota(cpus);           // throws on bad value
      if (pidsLimit && (pidsLimit < 1 || pidsLimit > 65536))
        throw new Error(`--pids-limit must be 1–65536, got ${pidsLimit}`);
      if (blkio && (blkio < 10 || blkio > 1000))
        throw new Error(`--blkio must be 10–1000, got ${blkio}`);
    } catch (limitErr) {
      throw new Error(`Resource limit error: ${limitErr.message}`);
    }
    cgroupLimits = { memory, cpus, pidsLimit, blkio };
  }

  record.cgroupLimits = cgroupLimits;
  store.saveContainer(record);

  // Build the command to execute
  const execArgs = buildExecArgs(record, imageRecord, volume);

  // Open log file stream
  await fs.ensureFile(logFile);
  const logStream = require('fs').createWriteStream(logFile, { flags: 'a' });

  // ── Create cgroup BEFORE spawn so limits are in place from PID 1 ─────────
  // On Linux: creates the cgroup directory and writes limit files.
  // On Windows: prepares a Job Object (attached after spawn).
  // NullCgroup used when no limits given or on unsupported platforms.
  const cgroup = await createCgroup(id, cgroupLimits);

  // spawnOpts from buildExecArgs may contain cwd — spread it first so that
  // stdio / detached / env set here take precedence.
  const child = spawn(execArgs.cmd, execArgs.args, {
    ...execArgs.spawnOpts,
    stdio:    detach ? ['ignore', logStream, logStream] : 'inherit',
    detached: detach,
    env:      buildRuntimeEnv(runtimeEnv, imageRecord.config?.env || []),
  });

  // A missing / misspelled executable causes spawn() to emit 'error' and
  // leaves child.pid undefined.  Attach the handler BEFORE reading child.pid.
  await new Promise((resolve, reject) => {
    // Give Node one microtick to fire a synchronous 'error' event.
    child.once('error', reject);
    // If no error fires in the same tick, we're good.
    setImmediate(resolve);
  }).catch(err => {
    record.status   = 'exited';
    record.exitCode = 1;
    record.exitedAt = new Date().toISOString();
    store.saveContainer(record);
    logStream.end();
    throw new Error(
      `Failed to start container process.\n` +
      `  Command : ${execArgs.cmd} ${execArgs.args.join(' ')}\n` +
      `  Reason  : ${err.message}\n` +
      (IS_WINDOWS
        ? `  Hint    : On Windows, make sure the image command is a .exe/.cmd or\n` +
          `            use 'minicontainer run <image> cmd /C <command>'`
        : `  Hint    : On Linux, ensure 'unshare' and 'chroot' are in PATH and\n` +
          `            that the rootfs was unpacked correctly.`)
    );
  });

  record.pid       = child.pid;
  record.status    = 'running';
  record.startedAt = new Date().toISOString();

  // ── Attach PID to cgroup immediately ─────────────────────────────────────
  // Must happen before the process does any significant work.
  await cgroup.attach(child.pid).catch(err => {
    console.warn(chalk.yellow(`  cgroup attach warning: ${err.message}`));
    console.warn(chalk.yellow('  Container will run without resource limits.'));
  });

  // Log active limits in a single summary line
  if (Object.keys(cgroupLimits).length > 0) {
    const parts = [];
    if (cgroupLimits.memory)    parts.push(`mem=${cgroupLimits.memory}`);
    if (cgroupLimits.cpus)      parts.push(`cpus=${cgroupLimits.cpus}`);
    if (cgroupLimits.pidsLimit) parts.push(`pids=${cgroupLimits.pidsLimit}`);
    if (cgroupLimits.blkio)     parts.push(`blkio=${cgroupLimits.blkio}`);
    console.log(chalk.gray(`  Limits: ${parts.join('  ')}`));
  }

  // ── Network setup ──────────────────────────────────────────────────────
  // Parse and validate port specs up front so bad specs fail before the
  // container is started — not silently after it is already running.
  let portRules = [];
  if (port.length > 0) {
    try {
      // containerIp is not known yet; fill it in after network connects
      portRules = portmap.parsePortSpecs(port, '0.0.0.0');
    } catch (parseErr) {
      logStream.end();
      throw new Error(`Invalid -p spec: ${parseErr.message}`);
    }
  }

  if (IS_LINUX) {
    try {
      const containerIp = await network.connectContainer(id, child.pid);
      if (containerIp) {
        record.ip = containerIp;
        await dns.configureResolvConf(rootfs);
        await dns.configureHosts(rootfs, containerIp, hostname, network.BRIDGE_IP);
        await dns.configureHostname(rootfs, hostname);
        if (portRules.length > 0) {
          // Fill in the real container IP now that we have it
          portRules.forEach(r => { r.containerIp = containerIp; });
          await portmap.installRules(id, portRules);
          record.ports = portmap.getRules(id);
        }
      }
    } catch (netErr) {
      console.warn(chalk.yellow(`  Network setup warning: ${netErr.message}`));
      console.warn(chalk.yellow('  Container will run with host networking as fallback.'));
    }
  } else {
    // Windows: containers share the host network stack.
    // Port forwarding is done via netsh portproxy using 127.0.0.1 as the
    // "container IP" because the process runs on the host.
    await dns.configureWindowsDns(rootfs).catch(() => {});
    await dns.configureHostname(rootfs, hostname).catch(() => {});
    if (portRules.length > 0) {
      portRules.forEach(r => { r.containerIp = '127.0.0.1'; });
      await portmap.installRules(id, portRules).catch(err => {
        console.warn(chalk.yellow(`  Port forward warning: ${err.message}`));
      });
      record.ports = portmap.getRules(id);
    }
  }

  store.saveContainer(record);

  console.log(detach
    ? chalk.green(`Container started: ${id} (detached, pid ${child.pid})`)
    : chalk.cyan(`Container ${id} running (pid ${child.pid})${record.ip ? `  ip=${record.ip}` : ''}...`)
  );

  if (detach) {
    child.unref();
    return record;
  }

  // Foreground: wait for exit
  await new Promise(resolve => {
    child.on('close', async code => {
      record.status   = 'exited';
      record.exitCode = code;
      record.exitedAt = new Date().toISOString();
      record.pid      = null;
      store.saveContainer(record);
      logStream.end();
      // Tear down order: cgroup → port forwards → network → user volumes → rootfs
      await cgroup.destroy().catch(() => {});
      await portmap.removeRules(id).catch(() => {});
      await network.disconnectContainer(id).catch(() => {});
      await volumes.unmountVolumes(volumeSpecs, rootfs).catch(() => {});
      await cleanupRootfs(rootfs);
      if (overlayMounted) await overlay.unmountOverlay(rootfs);
      if (autoRemove) {
        try { store.deleteContainer(id); } catch {}
        try { fs.removeSync(cDir); } catch {}
      }
      resolve();
    });
  });

  return record;
}

// ------------------------------------------------------------------ stop

async function stopContainer(idOrName, timeout = 10) {
  const record = store.getContainer(idOrName);
  if (!record) throw new Error(`No such container: ${idOrName}`);
  if (record.status !== 'running') {
    console.log(chalk.yellow(`Container ${record.id} is not running`));
    return;
  }

  const pid = record.pid;
  if (pid) {
    if (IS_WINDOWS) {
      const { run } = require('../utils/exec');
      await run('taskkill', ['/PID', String(pid), '/F']);
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      // wait up to `timeout` s then SIGKILL
      await new Promise(resolve => setTimeout(resolve, timeout * 1000));
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }

  record.status   = 'exited';
  record.exitCode = 137;
  record.exitedAt = new Date().toISOString();
  record.pid      = null;
  store.saveContainer(record);
  // Tear down: cgroup → port forwards → network → user volumes
  const cg = await createCgroup(record.id, record.cgroupLimits || {});
  await cg.destroy().catch(() => {});
  await portmap.removeRules(record.id).catch(() => {});
  await network.disconnectContainer(record.id).catch(() => {});
  await volumes.unmountVolumes(record.volumeSpecs || [], record.rootfs).catch(() => {});
  await overlay.unmountOverlay(record.rootfs);
  console.log(chalk.green(`Stopped ${record.id}`));
}

// ------------------------------------------------------------------ exec inside running container

async function execInContainer(idOrName, cmd) {
  const record = store.getContainer(idOrName);
  if (!record) throw new Error(`No such container: ${idOrName}`);
  if (record.status !== 'running') throw new Error(`Container ${record.id} is not running`);

  const { runInteractive } = require('../utils/exec');

  if (IS_LINUX) {
    // nsenter into the container's PID namespace then chroot
    await runInteractive('nsenter', [
      `--target`, String(record.pid),
      '--pid', '--mount', '--uts', '--ipc', '--net',
      '--',
      'chroot', record.rootfs, ...cmd,
    ]);
  } else {
    // Windows: run in the rootfs directory
    await runInteractive(cmd[0], cmd.slice(1), { cwd: record.rootfs });
  }
}

// ------------------------------------------------------------------ pre-start hooks

/**
 * On Linux: mount /proc, /sys, /dev inside the rootfs so the JVM (and any
 * other process that needs them) can start correctly.
 * Also write a minimal /etc/resolv.conf so DNS works inside the container.
 */
async function prepareRootfs(rootfs) {
  if (!IS_LINUX) return;
  const { run } = require('../utils/exec');

  // Ensure the mount targets exist
  for (const d of ['proc', 'sys', 'dev', 'dev/pts', 'etc']) {
    await fs.ensureDir(path.join(rootfs, d));
  }

  // Bind-mount host pseudo-filesystems
  const mounts = [
    ['proc',     path.join(rootfs, 'proc'),    ['--rbind']],
    ['sysfs',    path.join(rootfs, 'sys'),     ['--rbind']],
    ['/dev',     path.join(rootfs, 'dev'),     ['--rbind', '--make-rslave']],
  ];
  for (const [src, dst, flags] of mounts) {
    await run('mount', [...flags, src, dst]).catch(() => {});
  }

  // Inject resolv.conf if the rootfs doesn't have one that looks useful
  const resolvPath = path.join(rootfs, 'etc', 'resolv.conf');
  const hostResolv = '/etc/resolv.conf';
  if (!fs.existsSync(resolvPath) || (await fs.readFile(resolvPath, 'utf8').catch(() => '')).trim() === '') {
    const content = fs.existsSync(hostResolv)
      ? await fs.readFile(hostResolv, 'utf8')
      : 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n';
    await fs.writeFile(resolvPath, content).catch(() => {});
  }
}

/**
 * On Linux: unmount the pseudo-filesystems after the container exits.
 */
async function cleanupRootfs(rootfs) {
  if (!IS_LINUX) return;
  const { run } = require('../utils/exec');
  for (const sub of ['dev/pts', 'dev', 'sys', 'proc']) {
    await run('umount', ['-lf', path.join(rootfs, sub)]).catch(() => {});
  }
}

// ------------------------------------------------------------------ helpers

function buildExecArgs(record, imageRecord, volumes) {
  const userCmd    = record.cmd;
  const entrypoint = imageRecord.config?.entrypoint || [];
  const fullCmd    = [...entrypoint, ...userCmd];

  if (IS_LINUX) {
    // unshare: create PID + NET + MNT + UTS + IPC namespaces.
    // --net creates an isolated network namespace; connectContainer() then
    // wires in the veth interface after the process has started.
    const unshareArgs = [
      '--pid', '--fork',
      '--net',
      '--mount', '--uts', '--ipc',
      'chroot', record.rootfs,
    ];
    const command = fullCmd.length ? fullCmd : ['/bin/sh'];

    // Start as root so namespace and filesystem initialization can complete,
    // then replace PID 1 with the configured unprivileged user. The image must
    // provide `su` (BusyBox and standard Linux images do); root remains the
    // default when no USER/--user is configured.
    if (record.user && record.user !== 'root' && record.user !== '0') {
      const dropScript = 'user=$1; shift; exec su -s /bin/sh "$user" -c \'exec "$@"\' -- "$@"';
      return {
        cmd: 'unshare',
        args: [...unshareArgs, '/bin/sh', '-c', dropScript, '--', record.user, ...command],
        spawnOpts: {},
      };
    }

    return {
      cmd: 'unshare',
      args: [...unshareArgs, ...command],
      spawnOpts: {},
    };
  } else {
    // Windows: map Unix commands to Windows equivalents and run via cmd.exe
    const isUnixPath  = fullCmd[0] && fullCmd[0].startsWith('/');
    const isShell     = fullCmd[0] && (fullCmd[0] === 'sh' || fullCmd[0] === 'bash' || fullCmd[0] === 'ash');
    const isScript    = fullCmd[0] && (
      fullCmd[0].endsWith('.cmd') ||
      fullCmd[0].endsWith('.bat') ||
      fullCmd[0] === 'cmd' ||
      fullCmd[0] === 'cmd.exe'
    );
    const noCmd = !fullCmd[0];

    if (noCmd || isUnixPath || isShell) {
      // Unix-style commands or no command → drop into an interactive cmd.exe shell
      return {
        cmd: 'cmd.exe',
        args: [],
        spawnOpts: { cwd: record.rootfs },
      };
    }

    if (isScript) {
      return {
        cmd: 'cmd.exe',
        args: ['/C', ...fullCmd],
        spawnOpts: { cwd: record.rootfs },
      };
    }

    // Windows-native executable (e.g. node.exe, python.exe)
    return {
      cmd: fullCmd[0],
      args: fullCmd.slice(1),
      spawnOpts: { cwd: record.rootfs },
    };
  }
}

function buildEnv(extraEnv, imageRecord) {
  return buildRuntimeEnv(extraEnv, imageRecord.config?.env || []);
}

module.exports = { runContainer, stopContainer, execInContainer, buildExecArgs };
