'use strict';
/**
 * minicontainer compose — minimal docker-compose-compatible orchestrator
 *
 * Supported compose.yaml keys:
 *   services:
 *     <name>:
 *       image: <ref>            # required (or build:)
 *       build:
 *         context: <dir>
 *         dockerfile: <file>   # default: Containerfile or Dockerfile
 *       command: <str|array>
 *       environment: <obj|array>  # KEY=VALUE or { KEY: VALUE }
 *       ports: <array>           # "host:container[/proto]"
 *       volumes: <array>         # "src:dst[:opts]"
 *       depends_on: <array>      # service names
 *       restart: "no"|"always"   # stored in metadata; not enforced
 *       labels: <obj>
 *       working_dir: <path>
 *       user: <string>
 *       mem_limit: <string>      # e.g. "256m"
 *       cpus: <number|string>
 *
 * Subcommands:
 *   up   [-d] [--build] [service...]   Start services
 *   down [--volumes]   [-t secs]       Stop and remove containers
 *   ps                                 List project containers
 *   logs [--follow] [service...]       Show/follow logs
 *
 * Project name defaults to the directory name of the compose file.
 * Container names: <project>_<service>_1
 */

const path    = require('path');
const fs      = require('fs-extra');
const chalk   = require('chalk');
const yaml    = require('js-yaml');
const store   = require('../state/store');
const runtime = require('../core/runtime');
const { shortId } = require('../utils/ids');

// ── Compose file discovery ────────────────────────────────────────────────────

const COMPOSE_FILENAMES = [
  'compose.yaml', 'compose.yml',
  'docker-compose.yaml', 'docker-compose.yml',
];

/**
 * Find the compose file starting from `dir` (default: cwd).
 */
function findComposeFile(dir = process.cwd()) {
  for (const name of COMPOSE_FILENAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `No compose file found in ${dir}\n` +
    `Expected one of: ${COMPOSE_FILENAMES.join(', ')}`
  );
}

// ── Parse & validate ──────────────────────────────────────────────────────────

/**
 * Load and parse a compose file. Returns a normalised ComposeConfig.
 */
function loadCompose(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const doc = yaml.load(raw);

  if (!doc || typeof doc !== 'object') {
    throw new Error(`Invalid compose file: ${filePath}`);
  }

  const services = doc.services || {};
  const volumes  = doc.volumes  || {};  // named top-level volumes
  const networks = doc.networks || {};  // custom networks (informational)

  const parsed = {};
  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;

    // Normalise environment
    let env = [];
    if (Array.isArray(svc.environment)) {
      env = svc.environment.map(String);
    } else if (svc.environment && typeof svc.environment === 'object') {
      env = Object.entries(svc.environment).map(([k, v]) => `${k}=${v ?? ''}`);
    }

    // Normalise command
    let command = [];
    if (typeof svc.command === 'string') command = svc.command.split(/\s+/).filter(Boolean);
    else if (Array.isArray(svc.command)) command = svc.command.map(String);

    // Normalise ports / volumes
    const ports   = (svc.ports   || []).map(String);
    const vols    = (svc.volumes || []).map(String);

    // depends_on: can be array or object
    let deps = [];
    if (Array.isArray(svc.depends_on)) {
      deps = svc.depends_on;
    } else if (svc.depends_on && typeof svc.depends_on === 'object') {
      deps = Object.keys(svc.depends_on);
    }

    parsed[name] = {
      name,
      image:       svc.image         || null,
      build:       svc.build         || null,
      command,
      env,
      ports,
      volumes:     vols,
      dependsOn:   deps,
      restart:     svc.restart       || 'no',
      labels:      svc.labels        || {},
      workingDir:  svc.working_dir   || null,
      user:        svc.user          || null,
      memory:      svc.mem_limit     || null,
      cpus:        svc.cpus != null ? String(svc.cpus) : null,
    };
  }

  return { services: parsed, volumes, networks };
}

// ── Topological sort ──────────────────────────────────────────────────────────

/**
 * Return service names in dependency-safe start order.
 * Throws on circular dependency.
 */
function topoSort(services, selected = null) {
  const names = selected
    ? selected.filter(s => services[s])
    : Object.keys(services);

  // Expand: include all transitive depends_on for selected services
  const included = new Set(names);
  const expand = (n) => {
    for (const dep of (services[n]?.dependsOn || [])) {
      if (!included.has(dep)) { included.add(dep); expand(dep); }
    }
  };
  for (const n of names) expand(n);

  const visited   = new Set();
  const inStack   = new Set();
  const result    = [];

  function visit(n) {
    if (inStack.has(n)) throw new Error(`Circular dependency detected: ${n}`);
    if (visited.has(n)) return;
    inStack.add(n);
    for (const dep of (services[n]?.dependsOn || [])) {
      if (included.has(dep)) visit(dep);
    }
    inStack.delete(n);
    visited.add(n);
    result.push(n);
  }

  for (const n of included) visit(n);
  return result;
}

// ── Container name helpers ────────────────────────────────────────────────────

function containerName(project, service) {
  return `${project}_${service}_1`;
}

function projectContainers(project) {
  const all = store.getContainers();
  return Object.values(all).filter(c => c.composeProject === project);
}

function serviceContainer(project, service) {
  const name = containerName(project, service);
  return store.getContainer(name);
}

// ── up ────────────────────────────────────────────────────────────────────────

async function composeUp(composeFile, opts = {}, selectedServices = []) {
  const { detach = false, build: forceBuild = false } = opts;
  const config     = loadCompose(composeFile);
  const composeDir = path.dirname(composeFile);
  const project    = path.basename(composeDir);
  const order      = topoSort(config.services, selectedServices.length ? selectedServices : null);

  console.log(chalk.cyan(`Starting project: ${project}`));

  for (const svcName of order) {
    const svc  = config.services[svcName];
    const cName = containerName(project, svcName);

    // Check if already running
    const existing = store.getContainer(cName);
    if (existing && existing.status === 'running') {
      console.log(chalk.gray(`  ${svcName}: already running`));
      continue;
    }

    let imageRef = svc.image;

    // Build if needed
    if (svc.build && (!imageRef || forceBuild)) {
      const buildCtx = path.resolve(composeDir, svc.build.context || '.');
      const dockerfile = svc.build.dockerfile || null;
      imageRef = imageRef || `${project}_${svcName}:latest`;

      console.log(chalk.blue(`  Building ${svcName} → ${imageRef}`));
      const builder = require('../image/builder');
      await builder(buildCtx, { tag: imageRef, dockerfile });
    }

    if (!imageRef) throw new Error(`Service '${svcName}' has no image or build context`);

    console.log(chalk.green(`  Starting ${svcName} (${imageRef}) as ${cName}`));

    await runtime.run(imageRef, svc.command, {
      name:       cName,
      env:        svc.env,
      ports:      svc.ports,
      volumes:    svc.volumes,
      detach:     true,          // always detach in compose (orchestrator manages lifecycle)
      memory:     svc.memory,
      cpus:       svc.cpus,
      workingDir: svc.workingDir,
      user:       svc.user,
      labels:     { ...svc.labels, 'com.minicontainer.project': project, 'com.minicontainer.service': svcName },
      // Extra metadata stored in state
      _composeProject: project,
      _composeService: svcName,
    });

    // Patch the saved container record with compose metadata
    const saved = store.getContainer(cName);
    if (saved) {
      store.saveContainer({ ...saved, composeProject: project, composeService: svcName });
    }

    if (!detach) {
      // Attach stdout to logs of the last service (foreground feel)
      // We just stream logs and let the user Ctrl+C
    }
  }

  if (!detach) {
    console.log(chalk.gray(`\nServices started. Use 'minicontainer compose logs -f' to follow logs.`));
    console.log(chalk.gray(`Use 'minicontainer compose down' to stop.`));
  }
}

// ── down ─────────────────────────────────────────────────────────────────────

async function composeDown(composeFile, opts = {}) {
  const { removeVolumes = false, timeout = 10 } = opts;
  const config     = loadCompose(composeFile);
  const composeDir = path.dirname(composeFile);
  const project    = path.basename(composeDir);
  const order      = topoSort(config.services).reverse(); // stop in reverse order

  console.log(chalk.cyan(`Stopping project: ${project}`));

  for (const svcName of order) {
    const cName = containerName(project, svcName);
    const c     = store.getContainer(cName);
    if (!c) { console.log(chalk.gray(`  ${svcName}: not found`)); continue; }

    console.log(chalk.yellow(`  Stopping ${svcName}...`));
    try {
      await runtime.stop(c.id, { timeout });
    } catch {}

    try {
      await runtime.remove(c.id, { force: true, removeVolumes });
    } catch {}
    console.log(chalk.green(`  Removed ${svcName}`));
  }
}

// ── ps ────────────────────────────────────────────────────────────────────────

function composePs(composeFile) {
  const config     = loadCompose(composeFile);
  const composeDir = path.dirname(composeFile);
  const project    = path.basename(composeDir);
  const containers = projectContainers(project);

  const cols = [
    { label: 'NAME',       width: 30 },
    { label: 'SERVICE',    width: 18 },
    { label: 'STATUS',     width: 12 },
    { label: 'PORTS',      width: 30 },
  ];
  const header = cols.map(c => c.label.padEnd(c.width)).join('  ');
  console.log(chalk.bold(header));

  for (const svcName of Object.keys(config.services)) {
    const cName = containerName(project, svcName);
    const c = containers.find(x => x.name === cName);

    const status = c ? c.status : 'not created';
    const ports  = c?.ports ? Object.entries(c.ports || {})
      .map(([k, v]) => `${v}->${k}`).join(', ') : '';

    const row = [
      cName.padEnd(cols[0].width),
      svcName.padEnd(cols[1].width),
      status.padEnd(cols[2].width),
      ports.padEnd(cols[3].width),
    ].join('  ');
    console.log(row);
  }
}

// ── logs ─────────────────────────────────────────────────────────────────────

async function composeLogs(composeFile, opts = {}, selectedServices = []) {
  const { follow = false, tail = 100 } = opts;
  const config     = loadCompose(composeFile);
  const composeDir = path.dirname(composeFile);
  const project    = path.basename(composeDir);

  const services = selectedServices.length
    ? selectedServices.filter(s => config.services[s])
    : Object.keys(config.services);

  const { Tail } = require('../utils/tail');

  for (const svcName of services) {
    const cName = containerName(project, svcName);
    const c     = store.getContainer(cName);
    if (!c || !c.logFile || !fs.existsSync(c.logFile)) {
      console.log(chalk.gray(`[${svcName}] no logs`));
      continue;
    }

    // Print last N lines
    const lines = fs.readFileSync(c.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-tail);
    for (const l of lines) console.log(`${chalk.cyan(`[${svcName}]`)} ${l}`);

    if (follow) {
      const t = new Tail(c.logFile);
      t.on('line', line => console.log(`${chalk.cyan(`[${svcName}]`)} ${line}`));
      t.watch();
    }
  }
}

// ── main command handler ──────────────────────────────────────────────────────

async function composeCommand(subcommand, args, opts) {
  const composeFile = opts.file
    ? path.resolve(opts.file)
    : findComposeFile(process.cwd());

  switch (subcommand) {
    case 'up':
      await composeUp(composeFile, opts, args);
      break;

    case 'down':
      await composeDown(composeFile, {
        removeVolumes: opts.volumes || false,
        timeout:       parseInt(opts.timeout || '10', 10),
      });
      break;

    case 'ps':
      composePs(composeFile);
      break;

    case 'logs':
      await composeLogs(composeFile, {
        follow: opts.follow || false,
        tail:   parseInt(opts.tail || '100', 10),
      }, args);
      break;

    default:
      console.error(`Unknown compose subcommand: ${subcommand}`);
      console.error('Available: up, down, ps, logs');
      process.exit(1);
  }
}

module.exports = composeCommand;
module.exports.loadCompose   = loadCompose;
module.exports.topoSort      = topoSort;
module.exports.findComposeFile = findComposeFile;
module.exports.containerName = containerName;
module.exports.COMPOSE_FILENAMES = COMPOSE_FILENAMES;
