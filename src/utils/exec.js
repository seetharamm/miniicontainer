'use strict';
/**
 * Tiny async helper that wraps child_process.spawn so callers can await it.
 */

const { spawn } = require('child_process');

/**
 * Run a process and return { code, stdout, stderr }.
 * @param {string}   cmd
 * @param {string[]} args
 * @param {object}   opts  — same options as child_process.spawn
 */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'pipe', ...opts });
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', d => { stdout += d; });
    if (child.stderr) child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

/**
 * Like run() but inherits stdio so the child's output goes straight to the
 * terminal — useful for interactive commands.
 */
function runInteractive(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', code => resolve({ code }));
  });
}

module.exports = { run, runInteractive };
