'use strict';

const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.minicontainer');
const DEFAULT_TENANT = 'default';

function tenantName(value = process.env.MINICONTAINER_TENANT || DEFAULT_TENANT) {
  const name = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid tenant name: ${name}`);
  }
  return name;
}

function tenantRoot(value) {
  return path.join(ROOT, 'tenants', tenantName(value));
}

function getConfig(value) {
  const tenant = tenantName(value);
  return {
    tenant,
    root: tenantRoot(tenant),
    imagesDir: path.join(tenantRoot(tenant), 'images'),
    containersDir: path.join(tenantRoot(tenant), 'containers'),
    containersDb: path.join(tenantRoot(tenant), 'containers.json'),
    imagesDb: path.join(tenantRoot(tenant), 'images.json'),
  };
}

module.exports = { ROOT, DEFAULT_TENANT, tenantName, tenantRoot, getConfig };
