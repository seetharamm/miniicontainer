'use strict';

/**
 * Parse runtime configuration values supplied as KEY=VALUE pairs.
 * Runtime values are kept as strings and override image defaults.
 */
function parseEnv(values = []) {
  if (values == null) return {};

  const entries = Array.isArray(values)
    ? values
    : Object.entries(values).map(([key, value]) => `${key}=${value}`);

  const env = {};
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw new Error('Environment values must use KEY=VALUE format');
    }

    const separator = entry.indexOf('=');
    const key = separator === -1 ? entry : entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }

    env[key] = separator === -1 ? '' : entry.slice(separator + 1);
  }
  return env;
}

function buildRuntimeEnv(runtimeEnv, imageEnv = [], hostEnv = process.env) {
  return {
    ...hostEnv,
    ...parseEnv(imageEnv),
    ...parseEnv(runtimeEnv),
  };
}

module.exports = { parseEnv, buildRuntimeEnv };
