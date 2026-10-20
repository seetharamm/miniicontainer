'use strict';
/**
 * Script file watcher — watches a script file (and optionally its directory)
 * for changes and recompiles + re-runs automatically.
 *
 * Usage:
 *   const watcher = new ScriptWatcher(filePath, {
 *     pipeline:     'deploy',       // pipeline to run on change
 *     dryRun:       false,          // compile + print, don't execute
 *     debounceMs:   300,            // ms to wait after last change before acting
 *     overrideVars: { PORT: '9090' },
 *     onCompile:    (compiled) => {},
 *     onRun:        (result)   => {},
 *     onError:      (err)      => {},
 *   });
 *   watcher.start();
 *   // later:
 *   watcher.stop();
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');
const { compile } = require('./compiler');

class ScriptWatcher {
  /**
   * @param {string} filePath   Path to the script file to watch
   * @param {object} opts
   *   pipeline      {string}    Pipeline to auto-run on change (null = compile only)
   *   dryRun        {boolean}   If true, compile but don't execute
   *   debounceMs    {number}    Debounce delay in milliseconds (default: 300)
   *   overrideVars  {object}    Variables that override `vars:` in the script
   *   onCompile     {function}  Called after successful compilation: (compiled) => void
   *   onRun         {function}  Called after successful pipeline run: (result) => void
   *   onError       {function}  Called on any error: (err) => void
   */
  constructor(filePath, opts = {}) {
    this._filePath     = path.resolve(filePath);
    this._pipeline     = opts.pipeline     || null;
    this._dryRun       = opts.dryRun       || false;
    this._debounceMs   = opts.debounceMs   != null ? opts.debounceMs : 300;
    this._overrideVars = opts.overrideVars || {};
    this._onCompile    = opts.onCompile    || null;
    this._onRun        = opts.onRun        || null;
    this._onError      = opts.onError      || ((err) => console.error(chalk.red(`[watch] Error: ${err.message}`)));
    this._watcher      = null;
    this._timer        = null;
    this._running      = false;
    this._changeCount  = 0;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Start watching. Runs an initial compile+run immediately.
   */
  async start() {
    if (this._watcher) return; // already watching

    console.log(chalk.cyan(`[watch] Watching ${this._filePath}`));
    if (this._pipeline) console.log(chalk.gray(`[watch] Pipeline: ${this._pipeline}`));

    // Initial compile + run
    await this._act('initial');

    // Start the file watcher
    try {
      this._watcher = fs.watch(this._filePath, { persistent: true }, (eventType) => {
        if (eventType === 'change' || eventType === 'rename') {
          this._schedule();
        }
      });
      this._watcher.on('error', (err) => {
        this._onError(err);
        this._restartWatcher();
      });
    } catch (err) {
      this._onError(new Error(`Cannot watch ${this._filePath}: ${err.message}`));
    }
  }

  /**
   * Stop watching and clean up.
   */
  stop() {
    if (this._timer)   { clearTimeout(this._timer);    this._timer   = null; }
    if (this._watcher) { try { this._watcher.close(); } catch {} this._watcher = null; }
    console.log(chalk.gray('[watch] Stopped'));
  }

  /**
   * Force a recompile + re-run cycle without waiting for a file change.
   */
  async trigger() {
    await this._act('manual');
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  _schedule() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._act('change').catch(err => this._onError(err));
    }, this._debounceMs);
  }

  async _act(reason) {
    if (this._running) {
      console.log(chalk.gray('[watch] Previous run still active — skipping'));
      return;
    }
    this._running = true;
    this._changeCount++;
    const seq = this._changeCount;

    const ts = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, -4);
    console.log(chalk.bold.cyan(`\n[watch #${seq}] ${ts}  ${reason === 'initial' ? 'Initial compile' : 'File changed — recompiling'}...`));

    try {
      // ── Compile ──────────────────────────────────────────────────────────
      let compiled;
      try {
        compiled = compile(this._filePath, this._overrideVars);
        console.log(chalk.green(`[watch] Compiled '${compiled.name}' v${compiled.version} — ${Object.keys(compiled.pipelines).length} pipeline(s)`));
        if (this._onCompile) this._onCompile(compiled);
      } catch (compileErr) {
        console.error(chalk.red(`[watch] Compile error: ${compileErr.message}`));
        this._onError(compileErr);
        return;
      }

      // ── Run ──────────────────────────────────────────────────────────────
      if (this._pipeline) {
        if (!compiled.pipelines[this._pipeline]) {
          const available = Object.keys(compiled.pipelines).join(', ');
          const err = new Error(`Pipeline '${this._pipeline}' not found. Available: ${available}`);
          console.error(chalk.red(`[watch] ${err.message}`));
          this._onError(err);
          return;
        }

        const { runPipeline } = require('./runner');
        const result = await runPipeline(this._pipeline, compiled, {
          dryRun:   this._dryRun,
          failFast: true,
        });
        if (this._onRun) this._onRun(result);
      }
    } finally {
      this._running = false;
    }
  }

  _restartWatcher() {
    if (this._watcher) {
      try { this._watcher.close(); } catch {}
      this._watcher = null;
    }
    // Brief delay before re-attaching (file may have been replaced atomically)
    setTimeout(() => {
      if (!this._watcher) {
        try {
          this._watcher = fs.watch(this._filePath, { persistent: true }, () => this._schedule());
        } catch {}
      }
    }, 500);
  }

  /** Returns the number of change cycles that have been processed. */
  get changeCount() { return this._changeCount; }

  /** True when a compile+run cycle is in progress. */
  get isRunning() { return this._running; }
}

module.exports = { ScriptWatcher };
