'use strict';
/**
 * mydocker push — push an image to a registry.
 * Uploads all layers + config + manifest via the OCI Distribution spec.
 */
const chalk = require('chalk');
const store = require('../state/store');
const { RegistryClient } = require('../image/registry');

module.exports = async function push(imageRef, opts) {
  try {
    const record = store.getImage(imageRef);
    if (!record) throw new Error(`Image not found locally: ${imageRef}\nRun 'pull' or 'build' first.`);

    const client = new RegistryClient(imageRef, {
      username: opts.username || process.env.DOCKER_USERNAME,
      password: opts.password || process.env.DOCKER_PASSWORD,
    });

    console.log(chalk.cyan(`Pushing ${imageRef} to ${client.registry}...`));

    // Authenticate
    await client.authenticate();

    // Upload layers
    const fs = require('fs-extra');
    const path = require('path');
    const cache = require('../image/cache');
    const crypto = require('crypto');

    const layers = record.layers || [];
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const digest = layer.digest || layer;
      if (!cache.isCached(digest)) {
        console.log(chalk.yellow(`  Layer ${digest.slice(0, 19)} not in cache — skipping`));
        continue;
      }

      // Check if already exists on remote (saves bandwidth)
      const exists = await client.headBlob(digest).catch(() => false);
      if (exists) {
        console.log(chalk.gray(`  Layer ${digest.slice(0, 19)} already exists`));
        continue;
      }

      const blobPath = cache.blobPath(digest);
      const size = fs.statSync(blobPath).size;
      process.stdout.write(chalk.gray(`  Pushing layer ${i + 1}/${layers.length} (${Math.round(size / 1024)}KB)...`));
      await client.pushBlob(blobPath, digest);
      process.stdout.write(' ' + chalk.green('done') + '\n');
    }

    // Push config blob
    if (record.configDigest && cache.isCached(record.configDigest)) {
      await client.pushBlob(cache.blobPath(record.configDigest), record.configDigest).catch(() => {});
    }

    // Push manifest
    const manifest = record.manifest || buildSimpleManifest(record);
    await client.pushManifest(manifest);

    console.log(chalk.green(`Pushed ${imageRef}`));
    const eventlog = require('../state/eventlog');
    eventlog.image.save(imageRef); // closest semantic to 'push'

  } catch (err) {
    console.error(chalk.red('Error pushing image:'), err.message);
    process.exit(1);
  }
};

function buildSimpleManifest(record) {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: record.configDigest || '',
      size: 0,
    },
    layers: (record.layers || []).map(l => ({
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: typeof l === 'string' ? l : l.digest,
      size: typeof l === 'object' ? (l.size || 0) : 0,
    })),
  };
}
