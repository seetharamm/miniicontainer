'use strict';
const chalk = require('chalk');
const { pullImage } = require('../image/puller');
const { RegistryClient } = require('../image/registry');

module.exports = async function pull(image, opts) {
  try {
    const authOpts = {};
    if (opts.username) authOpts.username = opts.username;
    if (opts.password) authOpts.password = opts.password;

    // --platform linux/arm64  →  override arch/os on the registry client
    let platformOverride;
    if (opts.platform) {
      const [os, arch] = opts.platform.split('/');
      platformOverride = { os, arch };
    }

    // Monkey-patch resolveManifest if a platform override was requested
    if (platformOverride) {
      const { RegistryClient } = require('../image/registry');
      const orig = RegistryClient.prototype.resolveManifest;
      RegistryClient.prototype.resolveManifest = function () {
        return orig.call(this, platformOverride.arch, platformOverride.os);
      };
    }

    await pullImage(image, authOpts);
  } catch (err) {
    console.error(chalk.red('\nPull failed:'), err.message);
    process.exit(1);
  }
};
