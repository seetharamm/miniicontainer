'use strict';
/**
 * minicontainer events — query or stream the background state event log
 *
 * Usage:
 *   minicontainer events                         Stream live events (follow by default)
 *   minicontainer events --no-stream             Print existing events and exit
 *   minicontainer events --since 2024-01-01      Events after a date/duration
 *   minicontainer events --until 2024-12-31      Events before a date/duration
 *   minicontainer events --filter type=container Filter by type
 *   minicontainer events --filter action=start   Filter by action
 *   minicontainer events --filter actor=<id>     Filter by actor ID prefix
 *   minicontainer events --format json           Output as raw JSON (default: pretty)
 *   minicontainer events --tail 50               Show last N events then follow
 *
 * Duration shorthands for --since/--until:
 *   5m   → 5 minutes ago
 *   2h   → 2 hours ago
 *   1d   → 1 day ago
 *   30s  → 30 seconds ago
 */

const chalk    = require('chalk');
const eventlog = require('../state/eventlog');

// ── Duration / timestamp parser ───────────────────────────────────────────────

/**
 * Parse a --since / --until value into epoch milliseconds.
 * Accepts:
 *   - ISO-8601 datetime string
 *   - Unix timestamp (seconds or ms — heuristic: < 1e12 → seconds)
 *   - Duration shorthand: "5m", "2h", "1d", "30s"
 *
 * @param {string} value
 * @returns {number}  epoch milliseconds
 */
function parseTimeArg(value) {
  if (!value) return null;

  // Duration shorthand
  const dur = value.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (dur) {
    const n    = parseFloat(dur[1]);
    const unit = dur[2].toLowerCase();
    const ms   = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    return Date.now() - n * ms;
  }

  // Pure integer
  if (/^\d+$/.test(value)) {
    const n = parseInt(value, 10);
    return n < 1e12 ? n * 1000 : n;  // seconds → ms heuristic
  }

  // ISO string or any Date-parseable value
  const ts = new Date(value).getTime();
  if (isNaN(ts)) throw new Error(`Cannot parse time: "${value}"`);
  return ts;
}

// ── Filter builder ────────────────────────────────────────────────────────────

/**
 * Parse --filter flags into a filter object.
 * Each value is "key=value".  Recognised keys: type, action, actor.
 *
 * @param {string[]} filters   Array of "key=value" strings
 * @returns {object}
 */
function parseFilters(filters = []) {
  const result = {};
  for (const f of (Array.isArray(filters) ? filters : [filters])) {
    const eq = f.indexOf('=');
    if (eq === -1) throw new Error(`Invalid --filter format: "${f}" (expected key=value)`);
    const key = f.slice(0, eq).trim().toLowerCase();
    const val = f.slice(eq + 1).trim();
    if (!['type', 'action', 'actor'].includes(key)) {
      throw new Error(`Unknown filter key: "${key}". Allowed: type, action, actor`);
    }
    result[key] = val;
  }
  return result;
}

// ── Formatting ────────────────────────────────────────────────────────────────

const TYPE_COLOURS = {
  container: chalk.cyan,
  image:     chalk.blue,
  volume:    chalk.magenta,
  network:   chalk.yellow,
  system:    chalk.gray,
};

const ACTION_COLOURS = {
  create:     chalk.green,
  start:      chalk.green,
  pull:       chalk.green,
  build:      chalk.green,
  load:       chalk.green,
  connect:    chalk.green,
  stop:       chalk.yellow,
  pause:      chalk.yellow,
  die:        chalk.red,
  destroy:    chalk.red,
  disconnect: chalk.yellow,
  delete:     chalk.red,
  prune:      chalk.red,
};

function formatEvent(ev, format) {
  if (format === 'json') {
    return JSON.stringify(ev);
  }

  const typeColor   = TYPE_COLOURS[ev.type]   || chalk.white;
  const actionColor = ACTION_COLOURS[ev.action] || chalk.white;

  const time   = new Date(ev.timeMs).toISOString().replace('T', ' ').replace('Z', '');
  const seq    = String(ev.seq).padStart(6, ' ');
  const type   = typeColor(ev.type.padEnd(10));
  const action = actionColor(ev.action.padEnd(12));
  const actor  = ev.actor?.id
    ? `${ev.actor.name || ev.actor.id} (${ev.actor.id.slice(0, 12)})`
    : '';

  const attrs = ev.actor?.attrs && Object.keys(ev.actor.attrs).length
    ? '  ' + Object.entries(ev.actor.attrs)
        .map(([k, v]) => `${chalk.gray(k)}=${v}`)
        .join('  ')
    : '';

  return `${chalk.gray(seq)}  ${chalk.gray(time)}  ${type}  ${action}  ${actor}${attrs}`;
}

// ── Main command handler ──────────────────────────────────────────────────────

async function eventsCommand(opts = {}) {
  const {
    stream  = true,
    since,
    until,
    filter  = [],
    format  = 'pretty',
    tail: tailCount,
  } = opts;

  // Parse time bounds
  let sinceMs = null;
  let untilMs = null;
  try {
    sinceMs = since ? parseTimeArg(since) : null;
    untilMs = until ? parseTimeArg(until) : null;
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }

  // Parse filters
  let filters = {};
  try {
    filters = parseFilters(Array.isArray(filter) ? filter : filter ? [filter] : []);
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }

  const readOpts = {
    sinceMs,
    untilMs,
    type:    filters.type    || null,
    action:  filters.action  || null,
    actorId: filters.actor   || null,
    limit:   tailCount       ? parseInt(tailCount, 10) : null,
    includeRotated: true,
  };

  // Print existing events
  const existing = eventlog.read(readOpts);
  for (const ev of existing) {
    console.log(formatEvent(ev, format));
  }

  if (!stream) return;

  // Follow mode — tail new events
  const tailOpts = {
    sinceMs,
    type:    filters.type   || null,
    action:  filters.action || null,
    actorId: filters.actor  || null,
  };

  const stop = eventlog.tail(tailOpts, ev => {
    if (untilMs != null && ev.timeMs > untilMs) { stop(); return; }
    console.log(formatEvent(ev, format));
  });

  // Keep the process alive
  process.on('SIGINT',  () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
}

module.exports = eventsCommand;
module.exports.parseTimeArg  = parseTimeArg;
module.exports.parseFilters  = parseFilters;
module.exports.formatEvent   = formatEvent;
