'use strict';
/**
 * mydocker logs — interactive log viewer.
 *
 * Features:
 *   --follow / -f          Live-stream new lines as they arrive (fs.watch-based)
 *   --tail  <n>            Show last N lines of existing log (default: all when following,
 *                          100 when not)
 *   --since <time>         Only show lines whose embedded timestamp is ≥ this value.
 *                          Accepts: ISO-8601 | epoch-s | epoch-ms | 5m | 2h | 1d | 30s
 *   --until <time>         Stop showing / stop tailing once this time is reached.
 *   --timestamps / -t      Prepend a formatted UTC timestamp to every output line.
 *
 * Output format (with --timestamps):
 *   2024-06-01T12:00:00.000Z  <line content>
 *
 * Multi-container prefix (when piping multiple containers' logs together):
 *   [web-1]  <line content>
 *
 * Graceful exit:
 *   When following (-f) and the container stops, the tail stream automatically
 *   closes and the process exits cleanly.
 *
 * ANSI colours (only when TTY is attached):
 *   Container name prefix  → cyan
 *   Timestamp prefix       → gray
 *   Error lines (stderr-   → yellow  (lines containing ERROR/WARN/Exception)
 *   marker not available)
 */

'use strict';

const fs    = require('fs');
const chalk = require('chalk');
const store = require('../state/store');
const { Tail, extractTimestamp } = require('../utils/tail');
const { parseTimeArg } = require('./events'); // reuse the shared time-parser

// ── Colour helpers ────────────────────────────────────────────────────────────

const IS_TTY = Boolean(process.stdout.isTTY);

/** Colour-code one output line based on its content. */
function colourLine(line) {
  if (!IS_TTY) return line;
  if (/\b(ERROR|FATAL|Exception|Traceback)\b/i.test(line)) return chalk.red(line);
  if (/\b(WARN(ING)?)\b/i.test(line))                       return chalk.yellow(line);
  if (/\b(DEBUG)\b/i.test(line))                             return chalk.gray(line);
  return line;
}

/** Format a prefix for the output line. */
function formatPrefix(line, containerName, showTimestamps) {
  const parts = [];

  if (showTimestamps) {
    // Use embedded timestamp if present, otherwise use current time
    const embedded = extractTimestamp(line);
    const ts = embedded != null
      ? new Date(embedded).toISOString()
      : new Date().toISOString();
    parts.push(IS_TTY ? chalk.gray(ts) : ts);
  }

  if (containerName) {
    const nameTag = `[${containerName}]`;
    parts.push(IS_TTY ? chalk.cyan(nameTag) : nameTag);
  }

  return parts.length ? parts.join(' ') + '  ' : '';
}

// ── Core tail function for a single container ─────────────────────────────────

/**
 * Stream logs for one container to a writable (default: process.stdout).
 *
 * @param {string}   idOrName      Container ID or name
 * @param {object}   opts          CLI options
 * @param {Writable} [out]         Destination stream (default: process.stdout)
 * @param {boolean}  [showName]    Prefix lines with container name (multi-container mode)
 * @returns {Promise<void>}        Resolves when tailing completes (--follow only)
 *                                 or synchronously in static mode.
 */
function tailContainer(idOrName, opts, out = process.stdout, showName = false) {
  const record = store.getContainer(idOrName);
  if (!record) {
    console.error(chalk.red(`No such container: ${idOrName}`));
    process.exitCode = 1;
    return Promise.resolve();
  }

  const logFile = record.logFile;
  if (!logFile || !fs.existsSync(logFile)) {
    const prefix = showName ? chalk.cyan(`[${record.name}]`) + '  ' : '';
    out.write(prefix + chalk.gray('(no logs yet)\n'));
    return Promise.resolve();
  }

  // ── Parse time filters ───────────────────────────────────────────────────
  let sinceMs = null;
  let untilMs = null;
  try {
    sinceMs = opts.since ? parseTimeArg(opts.since) : null;
    untilMs = opts.until ? parseTimeArg(opts.until) : null;
  } catch (err) {
    console.error(chalk.red(`Invalid time argument: ${err.message}`));
    process.exitCode = 1;
    return Promise.resolve();
  }

  const follow     = !!opts.follow;
  const showTimestamps = !!(opts.timestamps || opts.t);
  const containerName  = showName ? record.name : null;

  // ── Static (non-follow) mode ─────────────────────────────────────────────
  if (!follow) {
    const tailN = parseInt(opts.tail, 10);
    const n     = isNaN(tailN) ? 100 : tailN;

    const raw   = fs.readFileSync(logFile, 'utf8');
    let lines   = raw.split('\n').filter(Boolean);

    // Apply --since filter
    if (sinceMs != null) {
      lines = lines.filter(l => {
        const ts = extractTimestamp(l);
        return ts == null || ts >= sinceMs;
      });
    }

    // Apply --until filter
    if (untilMs != null) {
      lines = lines.filter(l => {
        const ts = extractTimestamp(l);
        return ts == null || ts <= untilMs;
      });
    }

    // Apply --tail  (last N)
    if (n > 0) lines = lines.slice(-n);

    for (const line of lines) {
      const prefix = formatPrefix(line, containerName, showTimestamps);
      out.write(prefix + colourLine(line) + '\n');
    }

    return Promise.resolve();
  }

  // ── Follow mode ──────────────────────────────────────────────────────────
  const tailN = parseInt(opts.tail, 10);
  const lastN = isNaN(tailN) ? 0 : tailN;   // 0 = all history

  const tail = new Tail(logFile, { lastN, sinceMs, untilMs });

  tail.on('line', line => {
    const prefix = formatPrefix(line, containerName, showTimestamps);
    out.write(prefix + colourLine(line) + '\n');
  });

  // Automatically stop following when the container exits
  if (record.status === 'running') {
    tail.watchContainer(() => store.getContainer(record.id));
  }

  return new Promise(resolve => {
    tail.on('close', () => resolve());
    // SIGINT / SIGTERM: tear down gracefully
    const onSignal = () => { tail.destroy(); };
    process.once('SIGINT',  onSignal);
    process.once('SIGTERM', onSignal);
    tail.on('close', () => {
      process.off('SIGINT',  onSignal);
      process.off('SIGTERM', onSignal);
    });
  });
}

// ── Command entry point ───────────────────────────────────────────────────────

module.exports = async function logs(containerId, opts) {
  await tailContainer(containerId, opts, process.stdout, false);
};

// Exported for compose.js and tests
module.exports.tailContainer  = tailContainer;
module.exports.formatPrefix   = formatPrefix;
module.exports.colourLine     = colourLine;
