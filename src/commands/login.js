'use strict';
/**
 * mydocker login / logout — store/remove registry credentials.
 * Credentials are stored in ~/.minicontainer/config.json (never plain-text passwords;
 * values are base64-encoded as Docker does).
 */
const chalk = require('chalk');
const path  = require('path');
const os    = require('os');
const fs    = require('fs-extra');

const CONFIG_FILE = path.join(os.homedir(), '.minicontainer', 'config.json');

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { auths: {} };
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { auths: {} }; }
}

function writeConfig(cfg) {
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

async function login(registry = 'registry-1.docker.io', opts = {}) {
  const username = opts.username || process.env.DOCKER_USERNAME;
  const password = opts.password || process.env.DOCKER_PASSWORD;

  if (!username || !password) {
    console.error(chalk.red('Error: --username and --password are required'));
    process.exit(1);
  }

  const cfg = readConfig();
  cfg.auths = cfg.auths || {};
  cfg.auths[registry] = {
    auth: Buffer.from(`${username}:${password}`).toString('base64'),
  };
  writeConfig(cfg);
  console.log(chalk.green(`Login succeeded for ${registry}`));
}

function logout(registry = 'registry-1.docker.io') {
  const cfg = readConfig();
  if (cfg.auths?.[registry]) {
    delete cfg.auths[registry];
    writeConfig(cfg);
    console.log(chalk.green(`Removed login credentials for ${registry}`));
  } else {
    console.log(chalk.yellow(`Not logged in to ${registry}`));
  }
}

module.exports = { login, logout, CONFIG_FILE };
