'use strict';
/**
 * Unified CLI command registry.
 *
 * Every command is defined ONCE here as a plain descriptor object.
 * Both `minicontainer` and `mydocker` consume the same registry — the only
 * thing that differs between the two binaries is the program name/description
 * passed to createProgram().
 *
 * Descriptor shape:
 * {
 *   name:        string            Commander syntax, e.g. 'run <image> [cmd...]'
 *   description: string
 *   aliases:     string[]          Optional short aliases, e.g. ['container run']
 *   options:     OptionDef[]
 *   action:      function|string   Handler fn OR path to command module (lazy require)
 * }
 *
 * OptionDef shape:
 * {
 *   flags:       string            e.g. '-n, --name <name>'
 *   description: string
 *   collect?:    'kv' | 'arr'      use collectKV / collectArr as coercion
 *   default?:    any               default value
 *   required?:   boolean           use .requiredOption()
 *   parse?:      function          coerce fn (e.g. parseInt)
 * }
 */

'use strict';

const { Command } = require('commander');

// ── Coercion helpers ──────────────────────────────────────────────────────────
function collectKV(val, prev)  { prev.push(val); return prev; }
function collectArr(val, prev) { prev.push(val); return prev; }

// ── Command descriptors ───────────────────────────────────────────────────────

const COMMANDS = [
  // ── Container lifecycle ────────────────────────────────────────────────────
  {
    name:        'run <image> [cmd...]',
    description: 'Create and start a container from an image',
    aliases:     ['container run'],
    options: [
      { flags: '-n, --name <name>',      description: 'Assign a name to the container' },
      { flags: '-e, --env <key=value>',  description: 'Set environment variables', collect: 'kv', default: [] },
      { flags: '-v, --volume <src:dst>', description: 'Bind mount a volume', collect: 'arr', default: [] },
      { flags: '-p, --port <host:cont>', description: 'Publish a port mapping', collect: 'arr', default: [] },
      { flags: '-d, --detach',           description: 'Run container in background' },
      { flags: '--rm',                   description: 'Automatically remove the container on exit' },
      { flags: '-m, --memory <value>',   description: 'Memory limit (e.g. 256m, 1g)' },
      { flags: '--cpus <number>',        description: 'CPU limit — fractional cores (e.g. 0.5, 2)' },
      { flags: '--pids-limit <n>',       description: 'Max number of processes in container', parse: parseInt },
      { flags: '--blkio <weight>',       description: 'Block I/O weight 10–1000 (Linux only)', parse: parseInt },
      { flags: '-u, --user <user>',      description: 'Run as username or UID instead of root' },
    ],
    action: './commands/run',
  },

  {
    name:        'start <container...>',
    description: 'Start one or more stopped containers',
    aliases:     ['container start'],
    options: [],
    action: './commands/start',
  },

  {
    name:        'stop <container...>',
    description: 'Stop one or more running containers',
    aliases:     ['container stop'],
    options: [
      { flags: '-t, --time <seconds>', description: 'Seconds to wait before killing (default 10)', default: '10' },
    ],
    action: './commands/stop',
  },

  {
    name:        'restart <container...>',
    description: 'Restart one or more containers',
    aliases:     ['container restart'],
    options: [
      { flags: '-t, --time <seconds>', description: 'Seconds to wait before killing (default 10)', default: '10' },
    ],
    action: './commands/restart',
  },

  {
    name:        'kill <container...>',
    description: 'Kill one or more running containers',
    aliases:     ['container kill'],
    options: [
      { flags: '-s, --signal <signal>', description: 'Signal to send (default: KILL)', default: 'KILL' },
    ],
    action: './commands/kill',
  },

  {
    name:        'pause <container...>',
    description: 'Pause all processes within one or more containers',
    aliases:     ['container pause'],
    options: [],
    action: (containers) => require('./commands/pause').pause(containers),
  },

  {
    name:        'unpause <container...>',
    description: 'Unpause all processes within one or more containers',
    aliases:     ['container unpause'],
    options: [],
    action: (containers) => require('./commands/pause').unpause(containers),
  },

  {
    name:        'ps',
    description: 'List containers',
    aliases:     ['container ls', 'container list'],
    options: [
      { flags: '-a, --all',          description: 'Show all containers (default shows just running)' },
      { flags: '-q, --quiet',        description: 'Only display container IDs' },
      { flags: '--no-trunc',         description: 'Do not truncate output' },
      { flags: '-f, --filter <f>',   description: 'Filter output (e.g. status=running)', collect: 'arr', default: [] },
      { flags: '--format <fmt>',     description: 'Format output (table or json)' },
    ],
    action: './commands/ps',
  },

  {
    name:        'rm <container...>',
    description: 'Remove one or more containers',
    aliases:     ['container rm', 'container remove'],
    options: [
      { flags: '-f, --force',  description: 'Force removal of a running container' },
      { flags: '-v, --volumes',description: 'Remove anonymous volumes associated with the container' },
    ],
    action: './commands/rm',
  },

  {
    name:        'rename <container> <newName>',
    description: 'Rename a container',
    aliases:     ['container rename'],
    options: [],
    action: './commands/rename',
  },

  // ── Image management ────────────────────────────────────────────────────────
  {
    name:        'images',
    description: 'List local images',
    aliases:     ['image ls', 'image list'],
    options: [
      { flags: '-a, --all',        description: 'Show all images (default hides intermediates)' },
      { flags: '-q, --quiet',      description: 'Only show image IDs' },
      { flags: '--format <fmt>',   description: 'Format output (table or json)' },
    ],
    action: './commands/images',
  },

  {
    name:        'pull <image>',
    description: 'Pull an image from a registry',
    aliases:     ['image pull'],
    options: [
      { flags: '--platform <os/arch>', description: 'Target platform, e.g. linux/amd64 or linux/arm64' },
      { flags: '-u, --username <user>',description: 'Registry username (or set DOCKER_USERNAME)' },
      { flags: '-p, --password <pass>',description: 'Registry password (or set DOCKER_PASSWORD)' },
    ],
    action: './commands/pull',
  },

  {
    name:        'push <image>',
    description: 'Push an image to a registry',
    aliases:     ['image push'],
    options: [
      { flags: '-u, --username <user>',description: 'Registry username' },
      { flags: '-p, --password <pass>',description: 'Registry password' },
    ],
    action: './commands/push',
  },

  {
    name:        'tag <source> <target>',
    description: 'Create a tag TARGET_IMAGE that refers to SOURCE_IMAGE',
    aliases:     ['image tag'],
    options: [],
    action: './commands/tag',
  },

  {
    name:        'rmi <image...>',
    description: 'Remove one or more images',
    aliases:     ['image rm', 'image remove'],
    options: [
      { flags: '-f, --force',  description: 'Force removal' },
    ],
    action: './commands/rmi',
  },

  {
    name:        'build <contextDir>',
    description: 'Build an image from a Containerfile/Dockerfile',
    aliases:     ['image build'],
    options: [
      { flags: '-t, --tag <name:tag>',     description: 'Name and optionally a tag (name:tag)' },
      { flags: '-f, --file <dockerfile>',  description: 'Name of the Dockerfile/Containerfile' },
      { flags: '--no-cache',               description: 'Do not use cache when building' },
    ],
    action: './commands/build',
  },

  {
    name:        'save <image>',
    description: 'Save an image to a Docker-compatible tar archive',
    aliases:     ['image save'],
    options: [
      { flags: '-o, --output <file>', description: 'Write to a file, instead of STDOUT' },
    ],
    action: './commands/save',
  },

  {
    name:        'load',
    description: 'Load an image from a tar archive',
    aliases:     ['image load'],
    options: [
      { flags: '-i, --input <file>', description: 'Read from tar archive file', required: true },
    ],
    action: './commands/load',
  },

  {
    name:        'history <image>',
    description: 'Show the history of an image',
    aliases:     ['image history'],
    options: [
      { flags: '--no-trunc', description: 'Do not truncate output' },
      { flags: '-q, --quiet', description: 'Only show image IDs' },
    ],
    action: './commands/history',
  },

  {
    name:        'inspect <object...>',
    description: 'Return low-level information on containers or images',
    aliases:     ['container inspect', 'image inspect'],
    options: [
      { flags: '--format <fmt>', description: 'Format output using a template (json)' },
      { flags: '--type <type>',  description: 'Return JSON for specified type (container|image)' },
    ],
    action: './commands/inspect',
  },

  // ── Runtime interaction ─────────────────────────────────────────────────────
  {
    name:        'logs <container>',
    description: 'Fetch the logs of a container',
    aliases:     ['container logs'],
    options: [
      { flags: '-f, --follow',    description: 'Follow log output' },
      { flags: '--tail <n>',      description: 'Number of lines to show from the end', default: '100' },
      { flags: '--since <time>',  description: 'Show logs since timestamp (e.g. 2024-01-01, 5m)' },
      { flags: '--until <time>',  description: 'Show logs before timestamp' },
      { flags: '-t, --timestamps',description: 'Show timestamps' },
    ],
    action: './commands/logs',
  },

  {
    name:        'exec <container> <cmd...>',
    description: 'Run a command in a running container',
    aliases:     ['container exec'],
    options: [
      { flags: '-i, --interactive', description: 'Keep STDIN open' },
      { flags: '-t, --tty',         description: 'Allocate a pseudo-TTY' },
      { flags: '-e, --env <k=v>',   description: 'Set environment variables', collect: 'kv', default: [] },
      { flags: '-u, --user <user>', description: 'Username or UID' },
      { flags: '-w, --workdir <path>', description: 'Working directory inside the container' },
    ],
    action: './commands/exec',
  },

  {
    name:        'cp <src> <dest>',
    description: 'Copy files between host and container  (<container>:<path> or host path)',
    aliases:     ['container cp'],
    options: [],
    action: './commands/cp',
  },

  {
    name:        'attach <container>',
    description: 'Attach local standard input/output/error streams to a running container',
    aliases:     ['container attach'],
    options: [
      { flags: '--no-stdin', description: 'Do not attach STDIN' },
    ],
    action: './commands/attach',
  },

  {
    name:        'wait <container...>',
    description: 'Block until one or more containers stop, then print their exit codes',
    aliases:     ['container wait'],
    options: [],
    action: './commands/wait',
  },

  {
    name:        'diff <container>',
    description: 'Inspect changes to files or directories on a container\'s filesystem',
    aliases:     ['container diff'],
    options: [],
    action: './commands/diff',
  },

  // ── Port & stats ────────────────────────────────────────────────────────────
  {
    name:        'port <container> [containerPort]',
    description: 'List port mappings, or query a specific port',
    aliases:     ['container port'],
    options: [],
    action: './commands/port',
  },

  {
    name:        'stats [container...]',
    description: 'Display live CPU, memory and PID usage',
    aliases:     ['container stats'],
    options: [
      { flags: '--no-stream',    description: 'Print once and exit (do not stream)' },
      { flags: '--interval <s>', description: 'Refresh interval in seconds (default: 1)', default: '1' },
      { flags: '--format <fmt>', description: 'Output format (table or json)' },
    ],
    action: './commands/stats',
  },

  {
    name:        'top <container>',
    description: 'Display the running processes of a container',
    aliases:     ['container top'],
    options: [],
    action: './commands/top',
  },

  // ── Volume management ───────────────────────────────────────────────────────
  {
    name:        'volume <subcommand> [args...]',
    description: 'Manage named volumes  (ls | inspect | rm | create | prune)',
    aliases:     [],
    options: [
      { flags: '-f, --force', description: 'Force removal of volumes in use' },
    ],
    action: './commands/volume',
  },

  // ── Network management ──────────────────────────────────────────────────────
  {
    name:        'network <subcommand> [args...]',
    description: 'Manage networks  (ls | inspect | create | rm | connect | disconnect | prune)',
    aliases:     [],
    options: [
      { flags: '--driver <driver>', description: 'Network driver (default: bridge)' },
      { flags: '--subnet <cidr>',   description: 'Subnet CIDR (e.g. 192.168.10.0/24)' },
      { flags: '--gateway <ip>',    description: 'Gateway IP' },
    ],
    action: (sub, args, cmd) => require('./commands/network')(sub, args, cmd.opts()),
  },

  // ── Orchestration ────────────────────────────────────────────────────────────
  {
    name:        'orchestrator <subcommand> [args...]',
    description: 'Schedule workloads across registered host agents',
    aliases:     [],
    options: [
      { flags: '--endpoint <url>', description: 'Node agent URL' },
      { flags: '--capacity <n>', description: 'Node capacity', default: '1' },
      { flags: '--label <key=value>', description: 'Node label', collect: 'arr', default: [] },
      { flags: '--token <token>', description: 'Agent authentication token' },
      { flags: '--host <host>', description: 'Agent bind host', default: '0.0.0.0' },
      { flags: '--port <port>', description: 'Agent port', default: '8787' },
      { flags: '--interval <seconds>', description: 'Heartbeat interval', default: '5' },
      { flags: '--threshold <count>', description: 'Failed heartbeats before failover', default: '2' },
    ],
    action: (sub, args, cmd) => require('./commands/orchestrator')(sub, args, cmd.opts()),
  },

  // ── Compose ─────────────────────────────────────────────────────────────────
  {
    name:        'compose <subcommand> [args...]',
    description: 'Multi-container orchestration  (up | down | ps | logs)',
    aliases:     [],
    options: [
      { flags: '-f, --file <path>',  description: 'Specify compose file (default: compose.yaml)' },
      { flags: '-d, --detach',       description: 'Run containers in background (up only)' },
      { flags: '--build',            description: 'Build images before starting (up only)' },
      { flags: '--volumes',          description: 'Remove named volumes on down' },
      { flags: '-t, --timeout <s>',  description: 'Stop timeout in seconds (down only)', default: '10' },
      { flags: '--follow',           description: 'Follow log output (logs only)' },
      { flags: '--tail <n>',         description: 'Number of log lines to show', default: '100' },
    ],
    action: (sub, args, cmd) => require('./commands/compose')(sub, args, cmd.opts()),
  },

  // ── Events ──────────────────────────────────────────────────────────────────
  {
    name:        'events',
    description: 'Stream real-time events from the state event log',
    aliases:     [],
    options: [
      { flags: '--no-stream',        description: 'Print existing events and exit (do not follow)' },
      { flags: '--since <time>',     description: 'Show events since time (ISO-8601, epoch, or 5m/2h)' },
      { flags: '--until <time>',     description: 'Show events until time' },
      { flags: '--filter <key=val>', description: 'Filter events (type=, action=, actor=)', collect: 'arr', default: [] },
      { flags: '--format <fmt>',     description: 'Output format: pretty (default) or json', default: 'pretty' },
      { flags: '--tail <n>',         description: 'Show last N events before streaming' },
    ],
    action: (cmd) => require('./commands/events')(cmd.opts()),
  },

  // ── System ──────────────────────────────────────────────────────────────────
  {
    name:        'system <subcommand> [args...]',
    description: 'Manage the runtime  (df | info | prune | version)',
    aliases:     [],
    options: [
      { flags: '-f, --force',    description: 'Do not prompt for confirmation (prune)' },
      { flags: '-a, --all',      description: 'Remove all unused resources (prune)' },
      { flags: '--volumes',      description: 'Prune volumes too' },
    ],
    action: (sub, args, cmd) => require('./commands/system')(sub, args, cmd.opts()),
  },

  // ── Login / logout ──────────────────────────────────────────────────────────
  {
    name:        'login [registry]',
    description: 'Log in to a container registry',
    aliases:     [],
    options: [
      { flags: '-u, --username <user>', description: 'Registry username' },
      { flags: '-p, --password <pass>', description: 'Registry password' },
    ],
    action: (registry, opts) => require('./commands/login').login(registry, opts),
  },

  {
    name:        'logout [registry]',
    description: 'Log out from a container registry',
    aliases:     [],
    options: [],
    action: (registry) => require('./commands/login').logout(registry),
  },

  // ── Version ─────────────────────────────────────────────────────────────────
  {
    name:        'version',
    description: 'Show runtime version information',
    aliases:     [],
    options: [
      { flags: '--format <fmt>', description: 'Output format (text or json)' },
    ],
    action: './commands/version',
  },

  // ── Script compiler ──────────────────────────────────────────────────────────
  {
    name:        'script <subcommand> [args...]',
    description: 'Automated script compiler + runner  (run | compile | validate | watch | list | emit)',
    aliases:     [],
    options: [
      { flags: '--dry-run',           description: 'Compile and print steps without executing' },
      { flags: '--var <KEY=VALUE>',   description: 'Override a script variable', collect: 'arr', default: [] },
      { flags: '--format <fmt>',      description: 'Output format (pretty or json)' },
      { flags: '--debounce <ms>',     description: 'Watch debounce delay in milliseconds (default: 300)', default: '300' },
    ],
    action: (sub, args, cmd) => require('./commands/script')(sub, args, cmd.opts()),
  },
];

// ── Program factory ───────────────────────────────────────────────────────────

/**
 * Build a Commander program from the registry.
 *
 * @param {object} opts
 *   name        {string}  Binary name shown in help (e.g. 'mydocker')
 *   description {string}  One-line description shown in help
 *   version     {string}  Semver string shown by --version
 *
 * @returns {Command}
 */
function createProgram({ name, description, version }) {
  const program = new Command();
  program
    .name(name)
    .description(description)
    .version(version)
    // Show help on unknown command instead of a cryptic error
    .on('command:*', (args) => {
      console.error(`\nUnknown command: ${args[0]}\nRun '${name} --help' to see available commands.\n`);
      process.exitCode = 1;
    });

  for (const def of COMMANDS) {
    attachCommand(program, def);
  }

  return program;
}

/**
 * Attach one command descriptor to a Commander program.
 * Handles lazy-require actions, option collection coercions, and required options.
 */
function attachCommand(program, def) {
  const cmd = program.command(def.name).description(def.description);

  for (const opt of (def.options || [])) {
    const coerce = opt.collect === 'kv'  ? collectKV
                 : opt.collect === 'arr' ? collectArr
                 : opt.parse             ? opt.parse
                 : undefined;

    if (opt.required) {
      cmd.requiredOption(opt.flags, opt.description, coerce, opt.default);
    } else if (coerce !== undefined) {
      // Only collector options default to []; scalar coercers (parseInt) must stay unset
      cmd.option(opt.flags, opt.description, coerce, opt.collect ? (opt.default ?? []) : opt.default);
    } else if (opt.default !== undefined) {
      cmd.option(opt.flags, opt.description, opt.default);
    } else {
      cmd.option(opt.flags, opt.description);
    }
  }

  // Resolve lazy string actions
  const action = typeof def.action === 'string'
    ? require(def.action)
    : def.action;

  cmd.action(action);
  return cmd;
}

/**
 * List of all registered command names (top-level, no alias expansion).
 * Useful for tests and shell-completion generation.
 */
function listCommandNames() {
  return COMMANDS.map(c => c.name.split(' ')[0]);
}

/**
 * Return the full descriptor for a command by its top-level name.
 */
function getCommandDef(name) {
  return COMMANDS.find(c => c.name.split(' ')[0] === name) || null;
}

module.exports = {
  COMMANDS,
  createProgram,
  attachCommand,
  listCommandNames,
  getCommandDef,
  collectKV,
  collectArr,
};
