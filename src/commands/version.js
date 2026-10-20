'use strict';
/**
 * mydocker version — show runtime version info in Docker-compatible format.
 */
const pkg = require('../../package.json');
const { platform, IS_LINUX, IS_WINDOWS } = require('../utils/platform');
const os = require('os');

function versionInfo() {
  return {
    Client: {
      Version:       pkg.version,
      APIVersion:    '1.0',
      GoVersion:     `node/${process.version}`,
      GitCommit:     'n/a',
      Built:         'n/a',
      'OS/Arch':     `${platform()}/${process.arch}`,
      Context:       'default',
    },
    Server: {
      Engine: {
        Version:   pkg.version,
        APIVersion:'1.0',
        'OS/Arch': `${platform()}/${process.arch}`,
        KernelVersion: os.release(),
        BuildTime: 'n/a',
      },
    },
  };
}

module.exports = function version(opts = {}) {
  const info = versionInfo();
  if (opts.format === 'json') {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  const c = info.Client;
  console.log(`Client:`);
  console.log(` Version:           ${c.Version}`);
  console.log(` API version:       ${c.APIVersion}`);
  console.log(` Go version:        ${c.GoVersion}`);
  console.log(` Git commit:        ${c.GitCommit}`);
  console.log(` Built:             ${c.Built}`);
  console.log(` OS/Arch:           ${c['OS/Arch']}`);
  console.log();
  const s = info.Server.Engine;
  console.log(`Server:`);
  console.log(` Engine:`);
  console.log(`  Version:          ${s.Version}`);
  console.log(`  API version:      ${s.APIVersion}`);
  console.log(`  OS/Arch:          ${s['OS/Arch']}`);
  console.log(`  Kernel Version:   ${s.KernelVersion}`);
};

module.exports.versionInfo = versionInfo;
