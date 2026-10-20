'use strict';
/**
 * Image puller — downloads OCI / Docker images from any registry.
 *
 * Features:
 *   ✓ Docker Hub (public + authenticated) and private OCI registries
 *   ✓ Manifest list / multi-arch: automatically selects correct platform
 *   ✓ Content-addressable layer cache  — shared layers downloaded once
 *   ✓ Resume interrupted downloads     — Range header on partial files
 *   ✓ Per-layer progress bar           — bytes downloaded / total
 *   ✓ Digest verification              — sha256 checked after every layer
 *   ✓ Concurrent layer downloads       — configurable parallelism
 *   ✓ gzip + zstd layers               — both handled by tar at unpack time
 *   ✓ Correct parseRef                 — handles registry:port/repo:tag
 */

const path   = require('path');
const fs     = require('fs-extra');
const tar    = require('tar');
const chalk  = require('chalk');
const cliProgress = require('cli-progress');

const store             = require('../state/store');
const { shortId }       = require('../utils/ids');
const { RegistryClient, parseRef } = require('./registry');
const cache             = require('./cache');

// Maximum concurrent layer downloads
const PULL_CONCURRENCY = 3;

// ------------------------------------------------------------------ pull image

/**
 * Pull an image from a registry.
 *
 * @param {string} ref       Image reference, e.g. "ubuntu:22.04", "ghcr.io/owner/img:tag"
 * @param {object} [authOpts]  { username, password, token } — overrides env vars
 * @returns {Promise<ImageRecord>}
 */
async function pullImage(ref, authOpts = {}) {
  const parsed   = parseRef(ref);
  const client   = new RegistryClient(ref, authOpts);
  const fullRef  = `${parsed.registry === 'registry-1.docker.io' ? '' : parsed.registry + '/'}${parsed.repo}:${parsed.tag}`;

  console.log(chalk.bold.cyan(`\nPulling ${fullRef}`));

  // ── 1. Resolve manifest ──────────────────────────────────────────────────
  const { manifest, selectedEntry } = await client.resolveManifest();

  if (selectedEntry) {
    console.log(chalk.gray(
      `  Platform: ${selectedEntry.platform?.os}/${selectedEntry.platform?.architecture}`
    ));
  }

  // ── 2. Fetch image config (ENV, CMD, ENTRYPOINT, etc.) ───────────────────
  let config = {};
  if (manifest.config?.digest) {
    try {
      config = await client.fetchConfig(manifest.config.digest);
    } catch (e) {
      console.warn(chalk.yellow(`  Warning: could not fetch image config: ${e.message}`));
    }
  }

  // Normalise config to our internal shape
  const normConfig = normaliseConfig(config);

  // ── 3. Download layers ───────────────────────────────────────────────────
  const layers = manifest.layers || manifest.fsLayers || [];
  if (layers.length === 0) {
    throw new Error(`Manifest for ${fullRef} has no layers — the image may be corrupted or the platform is unsupported.`);
  }

  const imageId  = shortId();
  const dir      = store.imageDir(imageId);
  const layerDir = path.join(dir, 'layers');
  await fs.ensureDir(layerDir);

  console.log(chalk.gray(`  ${layers.length} layer(s) to download\n`));

  // Multi-bar progress display
  const multiBar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor:      true,
      format:          '  {layerShort} [{bar}] {percentage}% {value}/{total} bytes  {status}',
    },
    cliProgress.Presets.shades_grey
  );

  // Download layers with bounded concurrency
  const queue  = layers.map((layer, idx) => ({ layer, idx }));
  const active = new Set();
  const errors = [];

  async function downloadOne({ layer, idx }) {
    const digest     = layer.digest || layer.blobSum;
    const layerShort = digest.slice(7, 19);
    const layerFile  = path.join(layerDir, `${String(idx + 1).padStart(3, '0')}.tar`);

    // Is it already in the shared cache?
    if (cache.isCached(digest)) {
      const bar = multiBar.create(1, 1, { layerShort, status: chalk.green('cached') });
      bar.update(1);
      await cache.linkTo(digest, layerFile);
      return;
    }

    // Is there a partial download in the temp location?
    const tmp   = cache.tempPath(digest);
    const start = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;

    const bar = multiBar.create(100, 0, {
      layerShort,
      status: start > 0 ? chalk.yellow('resuming') : chalk.gray('pulling'),
    });

    try {
      await client.downloadBlob(digest, tmp, (downloaded, total) => {
        if (total > 0) {
          bar.setTotal(total);
          bar.update(downloaded, { status: chalk.gray('pulling') });
        }
      });

      bar.update(bar.getTotal(), { status: chalk.green('verifying') });

      // Commit to cache (verifies sha256 digest)
      await cache.commit(tmp, digest);

      bar.update(bar.getTotal(), { status: chalk.green('done') });

      // Hard-link from cache into the image's layer directory
      await cache.linkTo(digest, layerFile);

    } catch (err) {
      bar.update(0, { status: chalk.red('failed') });
      errors.push({ digest, err });
    }
  }

  // Bounded concurrency runner
  await runConcurrent(queue, downloadOne, PULL_CONCURRENCY);

  multiBar.stop();

  if (errors.length > 0) {
    const msgs = errors.map(e => `  • ${e.digest.slice(7, 19)}: ${e.err.message}`).join('\n');
    throw new Error(`${errors.length} layer(s) failed to download:\n${msgs}`);
  }

  // ── 4. Build and save the image record ───────────────────────────────────
  const record = {
    id:         imageId,
    ref:        store.normaliseRef(
      `${parsed.isDockerHub ? parsed.repo.replace(/^library\//, '') : `${parsed.registry}/${parsed.repo}`}:${parsed.tag}`
    ),
    registry:   parsed.registry,
    repo:       parsed.repo,
    tag:        parsed.tag,
    digest:     manifest.config?.digest || null,
    created:    new Date().toISOString(),
    layerDir,
    layerCount: layers.length,
    // Store the layer digests so save/export can reference the cache
    layers:     layers.map((l, i) => ({
      digest:    l.digest || l.blobSum,
      mediaType: l.mediaType || '',
      size:      l.size    || 0,
      file:      path.join(layerDir, `${String(i + 1).padStart(3, '0')}.tar`),
    })),
    config:     normConfig,
  };

  store.saveImage(record);

  console.log(chalk.green(`\nPulled  ${record.ref}`));
  console.log(chalk.cyan(`ID      ${imageId}`));
  console.log(chalk.gray(`Layers  ${layers.length}  |  Cached ${layers.filter(l => cache.isCached(l.digest || l.blobSum)).length}`));

  return record;
}

// ------------------------------------------------------------------ unpack

/**
 * Unpack all layers of an image into a target directory (rootfs).
 * Layers are applied in order (lower → upper, like overlayfs).
 * Both gzip-compressed (.tar.gz) and uncompressed (.tar) layers are handled.
 *
 * Whiteout files (Docker layer deletions) are honoured:
 *   .wh.<name>         → delete <name>
 *   .wh..wh..opq       → opaque whiteout: clear the entire directory
 */
async function unpackImage(imageRecord, targetDir) {
  await fs.ensureDir(targetDir);

  const files = (await fs.readdir(imageRecord.layerDir))
    .filter(f => f.endsWith('.tar'))
    .sort();   // lexicographic = numeric because of zero-padded names

  for (const f of files) {
    const layerPath = path.join(imageRecord.layerDir, f);
    await applyLayer(layerPath, targetDir);
  }
}

/**
 * Apply a single layer tarball into targetDir.
 * Handles whiteout files and both gzip and non-gzip layers.
 */
async function applyLayer(layerPath, targetDir) {
  const whiteouts = [];

  // First pass: collect whiteouts and extract everything else
  await tar.extract({
    file:   layerPath,
    cwd:    targetDir,
    strict: false,
    // tar fires 'entry' for every file during extract
    onentry(entry) {
      const name = entry.path;
      const base = path.basename(name);
      const dir  = path.dirname(name);

      if (base === '.wh..wh..opq') {
        // Opaque whiteout: schedule entire parent directory for clearing
        whiteouts.push({ type: 'opaque', dir: path.join(targetDir, dir) });
        entry.resume(); // skip writing this sentinel file
      } else if (base.startsWith('.wh.')) {
        // Regular whiteout: delete the named file
        const target = path.join(targetDir, dir, base.slice(4));
        whiteouts.push({ type: 'file', target });
        entry.resume();
      }
    },
  }).catch(() => {}); // tolerate permission errors on some layers

  // Apply whiteouts
  for (const w of whiteouts) {
    if (w.type === 'file') {
      await fs.remove(w.target).catch(() => {});
    } else if (w.type === 'opaque') {
      // Clear contents of the directory (but not the directory itself)
      const entries = await fs.readdir(w.dir).catch(() => []);
      for (const e of entries) {
        await fs.remove(path.join(w.dir, e)).catch(() => {});
      }
    }
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Run `tasks` with at most `limit` concurrent executions.
 */
async function runConcurrent(tasks, fn, limit) {
  const iter = tasks[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (let item = iter.next(); !item.done; item = iter.next()) {
      await fn(item.value);
    }
  });
  await Promise.all(workers);
}

/**
 * Normalise the raw OCI image config into our internal format.
 * The raw config has ContainerConfig / config sub-objects with different
 * capitalisation across registry versions.
 */
function normaliseConfig(raw) {
  const c = raw?.config || raw?.ContainerConfig || raw || {};
  return {
    env:        c.Env        || c.env        || [],
    workdir:    c.WorkingDir || c.workingDir || c.workdir || '/',
    cmd:        c.Cmd        || c.cmd        || [],
    entrypoint: c.Entrypoint || c.entrypoint || [],
    expose:     Object.keys(c.ExposedPorts || c.exposedPorts || {}).map(p => p.split('/')[0]),
    labels:     c.Labels     || c.labels     || {},
    user:       c.User       || c.user       || '',
  };
}

module.exports = { pullImage, unpackImage, applyLayer, parseRef };
