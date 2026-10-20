'use strict';
/**
 * Interactive log-tail utility.
 *
 * Provides two interfaces over the same fs.watch engine:
 *
 *   1. EventEmitter — emit('line', lineStr) for every new line appended to the file.
 *      Also emits 'close' when the watcher is torn down.
 *
 *   2. Readable stream — pipe-able, pushes raw Buffer chunks (legacy interface kept
 *      for any caller that still uses .pipe()).
 *
 * Constructor options:
 *   lastN   {number}  Print the last N lines of existing content on start (default 100)
 *   sinceMs {number}  Skip lines whose embedded ISO timestamp is before this epoch-ms.
 *                     If a line has no timestamp, it is always included.
 *   untilMs {number}  Stop tailing when the system clock exceeds this epoch-ms.
 *
 * Usage (EventEmitter / interactive):
 *   const tail = new Tail(logFile, { lastN: 50, sinceMs: Date.now() - 60_000 });
 *   tail.on('line', line => process.stdout.write(line + '\n'));
 *   tail.on('close', () => console.log('(stream ended)'));
 *   // later:
 *   tail.destroy();
 *
 * Usage (Readable / pipe):
 *   const tail = new Tail(logFile, { lastN: 100 });
 *   tail.pipe(process.stdout);
 */

const fs              = require('fs');
const { Readable }    = require('stream');
const { EventEmitter} = require('events');

class Tail extends Readable {
  /**
   * @param {string}         filePath
   * @param {number|object}  optsOrLastN  Legacy: number → { lastN }; new: options object
   */
  constructor(filePath, optsOrLastN = {}) {
    super();

    // Backward-compat: if second arg is a plain number, treat it as lastN
    const opts = typeof optsOrLastN === 'number'
      ? { lastN: optsOrLastN }
      : (optsOrLastN || {});

    this._path    = filePath;
    this._pos     = 0;
    this._lastN   = opts.lastN   != null ? opts.lastN   : 100;
    this._sinceMs = opts.sinceMs != null ? opts.sinceMs : null;
    this._untilMs = opts.untilMs != null ? opts.untilMs : null;
    this._closed  = false;
    this._watcher = null;

    // EventEmitter mixin — we inherit Readable but also expose .on('line')
    // by delegating through an internal emitter.
    this._emitter = new EventEmitter();

    // Defer _init so callers can attach on('line') listeners before initial
    // content is pushed.  setImmediate puts it after the current call-stack
    // but before any I/O callbacks, giving the constructor's caller time to
    // write  tail.on('line', cb)  before the first lines fire.
    setImmediate(() => {
      if (!this._closed) this._init();
    });

    // Auto-stop when untilMs is reached
    if (this._untilMs != null) {
      const ms = Math.max(0, this._untilMs - Date.now());
      this._untilTimer = setTimeout(() => this.destroy(), ms);
    }
  }

  // ── EventEmitter delegation ─────────────────────────────────────────────────
  on(event, listener) {
    if (event === 'line' || event === 'close') {
      this._emitter.on(event, listener);
      return this;
    }
    return super.on(event, listener);
  }

  once(event, listener) {
    if (event === 'line' || event === 'close') {
      this._emitter.once(event, listener);
      return this;
    }
    return super.once(event, listener);
  }

  off(event, listener) {
    if (event === 'line' || event === 'close') {
      this._emitter.off(event, listener);
      return this;
    }
    return super.off(event, listener);
  }

  // ── Initialisation ──────────────────────────────────────────────────────────
  _init() {
    if (!fs.existsSync(this._path)) {
      // File doesn't exist yet — watch the directory for creation
      this._watchForCreation();
      return;
    }

    const content = fs.readFileSync(this._path, 'utf8');
    const allLines = splitLines(content);
    const tailLines = this._lastN > 0 ? allLines.slice(-this._lastN) : allLines;

    for (const line of tailLines) {
      if (this._passesSinceFilter(line)) {
        this._emitter.emit('line', line);
        this.push(line + '\n');
      }
    }

    this._pos = Buffer.byteLength(content, 'utf8');
    this._startWatcher();
  }

  _watchForCreation() {
    const dir = require('path').dirname(this._path);
    const base = require('path').basename(this._path);
    try {
      this._watcher = fs.watch(dir, (event, filename) => {
        if (filename === base && fs.existsSync(this._path)) {
          this._watcher.close();
          this._watcher = null;
          this._init();
        }
      });
    } catch {
      // Directory doesn't exist either — nothing to watch
    }
  }

  _startWatcher() {
    try {
      this._watcher = fs.watch(this._path, { persistent: false }, () => {
        this._onFileChange();
      });
      this._watcher.on('error', () => {}); // swallow watcher errors
    } catch {
      // Watch failed (file removed mid-run) — emit close
      this.destroy();
    }
  }

  // ── File change handler ─────────────────────────────────────────────────────
  _onFileChange() {
    if (this._closed) return;

    let stat;
    try { stat = fs.statSync(this._path); } catch { return; }

    if (stat.size < this._pos) {
      // File was truncated (rotated) — re-read from the beginning
      this._pos = 0;
    }

    if (stat.size === this._pos) return;

    let buf;
    let fd;
    try {
      fd  = fs.openSync(this._path, 'r');
      buf = Buffer.alloc(stat.size - this._pos);
      fs.readSync(fd, buf, 0, buf.length, this._pos);
    } catch {
      return;
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch {}
    }
    this._pos = stat.size;

    const chunk = buf.toString('utf8');
    const lines = splitLines(chunk);

    for (const line of lines) {
      if (!line) continue;
      if (!this._passesSinceFilter(line)) continue;
      if (!this._passesUntilFilter()) { this.destroy(); return; }

      this._emitter.emit('line', line);
      // Push into the Readable side only if someone is piping
      if (!this._closed) this.push(buf);
    }
  }

  // ── Filters ─────────────────────────────────────────────────────────────────

  /**
   * Return true if the line should be shown given the --since filter.
   * Tries to extract an ISO timestamp from the line prefix.
   * If no timestamp is found, the line passes.
   */
  _passesSinceFilter(line) {
    if (this._sinceMs == null) return true;
    const ts = extractTimestamp(line);
    if (ts == null) return true;
    return ts >= this._sinceMs;
  }

  _passesUntilFilter() {
    if (this._untilMs == null) return true;
    return Date.now() <= this._untilMs;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  _read() {} // required by Readable; data is pushed proactively

  destroy(err) {
    if (this._closed) return this;
    this._closed = true;
    if (this._watcher)   { try { this._watcher.close(); }   catch {} }
    if (this._untilTimer){ clearTimeout(this._untilTimer); }
    this._emitter.emit('close');
    this.push(null);              // signal end of Readable stream
    return super.destroy(err);
  }

  /**
   * Watch a container record and auto-close when it exits.
   * @param {function} getContainer  () → containerRecord (re-read from store)
   * @param {number}   pollMs        Polling interval (default 1000ms)
   */
  watchContainer(getContainer, pollMs = 1000) {
    const interval = setInterval(() => {
      if (this._closed) { clearInterval(interval); return; }
      const c = getContainer();
      if (!c || c.status !== 'running') {
        clearInterval(interval);
        // Give the log one more tick to flush then close
        setTimeout(() => this.destroy(), 200);
      }
    }, pollMs);
    this.on('close', () => clearInterval(interval));
    return this;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Split a string into lines, keeping Windows (\r\n) and Unix (\n) endings.
 * Does NOT include a trailing empty string if content ends with \n.
 */
function splitLines(str) {
  const lines = str.split('\n');
  // Remove trailing empty element caused by a final newline
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Try to extract an epoch-ms timestamp from the start of a log line.
 * Recognised formats:
 *   2024-06-01T12:00:00.000Z ...          (ISO-8601, written by runtime)
 *   [2024-06-01T12:00:00.000Z] ...        (bracketed ISO)
 *   2024-06-01 12:00:00.000 ...           (space-separated date+time)
 *
 * Returns null if no timestamp is found.
 */
function extractTimestamp(line) {
  // ISO-8601 with optional brackets
  const isoMatch = line.match(/^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]?/);
  if (isoMatch) {
    const ms = Date.parse(isoMatch[1]);
    return isNaN(ms) ? null : ms;
  }
  // Space-separated
  const spaceMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  if (spaceMatch) {
    const ms = Date.parse(spaceMatch[1].replace(' ', 'T') + 'Z');
    return isNaN(ms) ? null : ms;
  }
  return null;
}

module.exports = { Tail, splitLines, extractTimestamp };
