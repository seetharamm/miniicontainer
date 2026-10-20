'use strict';
/**
 * Background state metadata tracking — append-only JSON Lines event log.
 *
 * Every significant state change in the runtime (container start/stop/exit,
 * image pull/build/delete, volume create/remove) is recorded as a single-line
 * JSON object appended to:
 *
 *   ~/.minicontainer/events.jsonl
 *
 * Each line (event) has this shape:
 *
 *   {
 *     "seq":       <monotonic integer>,      // auto-incremented per line
 *     "time":      "<ISO-8601>",             // UTC timestamp
 *     "timeMs":    <epoch-ms>,               // for fast range queries
 *     "type":      "<event-type>",           // e.g. "container", "image", "volume"
 *     "action":    "<action>",               // e.g. "start", "stop", "pull", "create"
 *     "actor": {
 *       "id":      "<id>",                   // container id, image ref, volume name
 *       "name":    "<human-readable name>",
 *       "attrs":   { ... }                   // arbitrary key-value metadata
 *     }
 *   }
 *
 * The file is written with `fs.appendFileSync` — each call is O(1) and safe
 * from concurrent readers.  Rotation is triggered when the file exceeds
 * MAX_LOG_BYTES: the current file is renamed to events.jsonl.1, a new file
 * starts, and events.jsonl.2 (if any) is deleted.
 *
 * Public API:
 *   emit(type, action, actor)     — append one event
 *   read(opts)                    — read and optionally filter events from disk
 *   tail(opts, callback)          — watch the log file and call back on new lines
 *   getSeq()                      — return the current sequence counter
 *   clear()                       — truncate the log (tests / prune)
 *   EVENT_LOG                     — absolute path to the log file
 */

const fs   = require('fs-extra');
const path = require('path');
const os   = require('os');

const ROOT      = path.join(os.homedir(), '.minicontainer');
const EVENT_LOG = path.join(ROOT, 'events.jsonl');
const ROTATED   = EVENT_LOG + '.1';
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB

// Ensure data directory
fs.ensureDirSync(ROOT);

// ── Sequence counter ──────────────────────────────────────────────────────────
// We derive the initial seq by counting existing lines so that seq is stable
// across process restarts without a separate counter file.
let _seq = null;

function getSeq() {
  if (_seq !== null) return _seq;
  if (!fs.existsSync(EVENT_LOG)) { _seq = 0; return 0; }
  try {
    const content = fs.readFileSync(EVENT_LOG, 'utf8');
    _seq = content.split('\n').filter(l => l.trim()).length;
  } catch {
    _seq = 0;
  }
  return _seq;
}

// ── Rotation ──────────────────────────────────────────────────────────────────

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(EVENT_LOG)) return;
    const { size } = fs.statSync(EVENT_LOG);
    if (size < MAX_LOG_BYTES) return;
    // Remove old rotation, then rename current → .1
    try { fs.removeSync(ROTATED); } catch {}
    fs.renameSync(EVENT_LOG, ROTATED);
    _seq = 0; // reset counter for new file
  } catch {
    // Rotation failures are non-fatal
  }
}

// ── emit ──────────────────────────────────────────────────────────────────────

/**
 * Append one event to the log.
 *
 * @param {string} type    'container' | 'image' | 'volume' | 'network' | 'system'
 * @param {string} action  e.g. 'create' | 'start' | 'stop' | 'die' | 'destroy' | 'pull' | 'build'
 * @param {object} actor   { id, name, attrs? }
 */
function emit(type, action, actor = {}) {
  rotateIfNeeded();
  const seq = getSeq();
  const now = new Date();
  const event = {
    seq,
    time:   now.toISOString(),
    timeMs: now.getTime(),
    type,
    action,
    actor: {
      id:    actor.id    || '',
      name:  actor.name  || actor.id || '',
      attrs: actor.attrs || {},
    },
  };
  try {
    fs.appendFileSync(EVENT_LOG, JSON.stringify(event) + '\n', 'utf8');
    _seq = seq + 1;
  } catch {
    // Log write failure is non-fatal — never crash the runtime over it
  }
  return event;
}

// ── read ──────────────────────────────────────────────────────────────────────

/**
 * Read events from the log, optionally filtered.
 *
 * @param {object} opts
 *   sinceMs   {number}   only return events with timeMs >= sinceMs
 *   untilMs   {number}   only return events with timeMs <= untilMs
 *   type      {string}   filter by event type (exact match)
 *   action    {string}   filter by action (exact match)
 *   actorId   {string}   filter by actor.id (prefix match)
 *   limit     {number}   return at most N most-recent events (default: all)
 *   includeRotated {bool} also read events.jsonl.1 (default: false)
 *
 * @returns {object[]}  array of event objects (oldest first)
 */
function read(opts = {}) {
  const { sinceMs, untilMs, type, action, actorId, limit, includeRotated = false } = opts;

  const files = [];
  if (includeRotated && fs.existsSync(ROTATED)) files.push(ROTATED);
  if (fs.existsSync(EVENT_LOG)) files.push(EVENT_LOG);

  let events = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      if (sinceMs != null && ev.timeMs < sinceMs) continue;
      if (untilMs != null && ev.timeMs > untilMs) continue;
      if (type   && ev.type   !== type)   continue;
      if (action && ev.action !== action) continue;
      if (actorId && !ev.actor?.id?.startsWith(actorId)) continue;
      events.push(ev);
    }
  }

  if (limit != null && limit > 0) {
    events = events.slice(-limit);
  }

  return events;
}

// ── tail ─────────────────────────────────────────────────────────────────────

/**
 * Watch the log file and invoke `callback(event)` for every new line appended.
 * Returns a stopper function: call `stop()` to unwatch.
 *
 * @param {object}   opts      same filter keys as read(), except limit/includeRotated
 * @param {function} callback  called with a parsed event object
 * @returns {function}         stop() — unwatch the file
 */
function tail(opts = {}, callback) {
  const { type, action, actorId, sinceMs } = opts;

  let offset = fs.existsSync(EVENT_LOG)
    ? fs.statSync(EVENT_LOG).size
    : 0;

  let watcher;
  try {
    watcher = fs.watch(EVENT_LOG, { persistent: false }, (eventType) => {
      if (eventType !== 'change') return;
      let stat;
      try { stat = fs.statSync(EVENT_LOG); } catch { return; }
      if (stat.size <= offset) return; // rotation — reset

      const buf = Buffer.alloc(stat.size - offset);
      let fd;
      try {
        fd = fs.openSync(EVENT_LOG, 'r');
        fs.readSync(fd, buf, 0, buf.length, offset);
      } finally {
        if (fd != null) try { fs.closeSync(fd); } catch {}
      }
      offset = stat.size;

      const chunk = buf.toString('utf8');
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let ev;
        try { ev = JSON.parse(trimmed); } catch { continue; }
        if (sinceMs != null && ev.timeMs < sinceMs) continue;
        if (type   && ev.type   !== type)   continue;
        if (action && ev.action !== action) continue;
        if (actorId && !ev.actor?.id?.startsWith(actorId)) continue;
        callback(ev);
      }
    });
  } catch {
    // File doesn't exist yet — create it and then watch
    fs.ensureFileSync(EVENT_LOG);
    offset = 0;
    watcher = fs.watch(EVENT_LOG, { persistent: false }, () => {});
  }

  return () => { try { watcher.close(); } catch {} };
}

// ── clear ─────────────────────────────────────────────────────────────────────

/**
 * Truncate the event log (used by tests and `minicontainer system prune`).
 */
function clear() {
  try {
    fs.writeFileSync(EVENT_LOG, '', 'utf8');
    try { fs.removeSync(ROTATED); } catch {}
    _seq = 0;
  } catch {}
}

// ── Convenience emitters ─────────────────────────────────────────────────────
// These are the canonical calls made by store.js and the runtime.

const container = {
  create:  (id, name, image)  => emit('container', 'create',  { id, name, attrs: { image } }),
  start:   (id, name, pid)    => emit('container', 'start',   { id, name, attrs: { pid: String(pid) } }),
  stop:    (id, name)         => emit('container', 'stop',    { id, name }),
  die:     (id, name, code)   => emit('container', 'die',     { id, name, attrs: { exitCode: String(code ?? '') } }),
  destroy: (id, name)         => emit('container', 'destroy', { id, name }),
  pause:   (id, name)         => emit('container', 'pause',   { id, name }),
  unpause: (id, name)         => emit('container', 'unpause', { id, name }),
};

const image = {
  pull:    (ref, digest)      => emit('image', 'pull',    { id: ref, name: ref, attrs: { digest: digest || '' } }),
  build:   (ref, tag)         => emit('image', 'build',   { id: ref, name: tag || ref }),
  delete:  (ref)              => emit('image', 'delete',  { id: ref, name: ref }),
  load:    (ref)              => emit('image', 'load',    { id: ref, name: ref }),
  save:    (ref)              => emit('image', 'save',    { id: ref, name: ref }),
  tag:     (ref, newTag)      => emit('image', 'tag',     { id: ref, name: ref, attrs: { tag: newTag } }),
};

const volume = {
  create:  (name, volPath)    => emit('volume', 'create',  { id: name, name, attrs: { path: volPath || '' } }),
  destroy: (name)             => emit('volume', 'destroy', { id: name, name }),
  mount:   (name, target)     => emit('volume', 'mount',   { id: name, name, attrs: { target } }),
  unmount: (name, target)     => emit('volume', 'unmount', { id: name, name, attrs: { target } }),
};

const network = {
  create:     (id, name)      => emit('network', 'create',     { id, name }),
  destroy:    (name)          => emit('network', 'destroy',    { id: name, name }),
  connect:    (netName, cid)  => emit('network', 'connect',    { id: cid, name: cid, attrs: { network: netName } }),
  disconnect: (netName, cid)  => emit('network', 'disconnect', { id: cid, name: cid, attrs: { network: netName } }),
};

const system = {
  start:  ()                  => emit('system', 'start',  { id: 'minicontainer', name: 'minicontainer', attrs: { pid: String(process.pid) } }),
  prune:  (what)              => emit('system', 'prune',  { id: 'minicontainer', name: 'minicontainer', attrs: { what } }),
};

module.exports = {
  emit,
  read,
  tail,
  getSeq,
  clear,
  EVENT_LOG,
  ROTATED,
  MAX_LOG_BYTES,
  // Namespaced emitters
  container,
  image,
  volume,
  network,
  system,
};
