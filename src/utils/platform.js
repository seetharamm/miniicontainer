'use strict';
/**
 * Platform detection helpers shared across the codebase.
 */

const os = require('os');

const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX   = process.platform === 'linux';
const IS_MAC     = process.platform === 'darwin';

/**
 * Returns the platform identifier: 'windows' | 'linux' | 'mac'
 */
function platform() {
  if (IS_WINDOWS) return 'windows';
  if (IS_LINUX)   return 'linux';
  return 'mac';
}

/**
 * Throws an error with a helpful message when a Linux-only feature is
 * invoked on Windows without WSL / a compatible shim being present.
 */
function requireLinux(featureName) {
  if (!IS_LINUX) {
    throw new Error(
      `'${featureName}' requires Linux kernel namespaces and is not directly ` +
      `supported on ${platform()}.\n` +
      `On Windows, enable WSL 2 and run minicontainer inside the WSL shell.`
    );
  }
}

module.exports = { IS_WINDOWS, IS_LINUX, IS_MAC, platform, requireLinux };
