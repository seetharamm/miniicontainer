'use strict';
/**
 * minicontainer load -i image.tar
 *
 * Imports a Docker-compatible image tarball (as produced by `docker save` or
 * `minicontainer save`) into the local image store.
 *
 * Expected tarball layout (Docker save format):
 *   manifest.json                  ← array of { Config, RepoTags, Layers }
 *   <configFile>.json              ← OCI image config
 *   <digest>/layer.tar             ← layer tarballs
 *
 * Also handles the legacy v1 format:
 *   repositories                   ← { repo: { tag: layerId } }
 *   <layerId>/layer.tar
 *   <layerId>/json
 */

const path  = require('path');
const os    = require('os');
const fs    = require('fs-extra');
const tar   = require('tar');
const chalk = require('chalk');

const store        = require('../state/store');
const { shortId }  = require('../utils/ids');
const cache        = require('../image/cache');

module.exports = async function load(opts) {
  const inputPath = opts.input;
  if (!inputPath) {
    console.error(chalk.red('Error: -i / --input <file.tar> is required'));
    process.exit(1);
  }

  const absInput = path.resolve(inputPath);
  if (!fs.existsSync(absInput)) {
    console.error(chalk.red(`File not found: ${absInput}`));
    process.exit(1);
  }

  console.log(chalk.cyan(`Loading image from ${absInput}...`));

  // Extract the tarball into a temp directory
  const tmpDir = path.join(os.tmpdir(), `mc_load_${Date.now()}`);
  await fs.ensureDir(tmpDir);

  try {
    await tar.extract({ file: absInput, cwd: tmpDir, strict: false });

    // ── Detect format ────────────────────────────────────────────────────
    const manifestPath = path.join(tmpDir, 'manifest.json');

    if (fs.existsSync(manifestPath)) {
      await loadDockerFormat(tmpDir, JSON.parse(await fs.readFile(manifestPath, 'utf8')));
    } else {
      // Legacy v1 format
      await loadLegacyFormat(tmpDir);
    }

  } finally {
    await fs.remove(tmpDir);
  }
};

// ── Docker save format (v2) ──────────────────────────────────────────────────

async function loadDockerFormat(tmpDir, manifest) {
  for (const entry of manifest) {
    const configFile = path.join(tmpDir, entry.Config);
    const rawConfig  = fs.existsSync(configFile)
      ? JSON.parse(await fs.readFile(configFile, 'utf8'))
      : {};

    const normConfig = normaliseConfig(rawConfig);

    // Determine repo:tag
    const repoTag  = (entry.RepoTags || [])[0] || 'loaded:latest';
    const colonIdx = repoTag.lastIndexOf(':');
    const repo     = colonIdx > 0 ? repoTag.slice(0, colonIdx) : repoTag;
    const tag      = colonIdx > 0 ? repoTag.slice(colonIdx + 1) : 'latest';

    const imageId  = shortId();
    const imageDir = store.imageDir(imageId);
    const layerDir = path.join(imageDir, 'layers');
    await fs.ensureDir(layerDir);

    // Copy layers into the image directory and cache them
    const layerRecords = [];
    for (let i = 0; i < (entry.Layers || []).length; i++) {
      const relPath  = entry.Layers[i];
      const src      = path.join(tmpDir, relPath);
      const destFile = path.join(layerDir, `${String(i + 1).padStart(3, '0')}.tar`);

      await fs.copy(src, destFile);

      // Add to content-addressable cache
      const digest = await hashFile(src);
      const fullDigest = `sha256:${digest}`;
      if (!cache.isCached(fullDigest)) {
        const tmp = cache.tempPath(fullDigest);
        await fs.copy(src, tmp);
        await cache.commit(tmp, fullDigest).catch(() => {}); // ignore if already committed
      }

      layerRecords.push({ digest: fullDigest, file: destFile, size: fs.statSync(destFile).size });
    }

    const record = {
      id:           imageId,
      ref:          store.normaliseRef(`${repo}:${tag}`),
      repo,
      tag,
      created:      new Date().toISOString(),
      layerDir,
      layerCount:   layerRecords.length,
      layers:       layerRecords,
      config:       normConfig,
      loadedFrom:   true,
    };

    store.saveImage(record);
    console.log(chalk.green(`Loaded  ${record.ref}  (id: ${imageId})`));
  }
}

// ── Legacy Docker v1 format ──────────────────────────────────────────────────

async function loadLegacyFormat(tmpDir) {
  const repoFile = path.join(tmpDir, 'repositories');
  let tagMap = {};
  if (fs.existsSync(repoFile)) {
    tagMap = JSON.parse(await fs.readFile(repoFile, 'utf8'));
  }

  // Walk layer directories (each has a `layer.tar` and a `json` metadata file)
  const dirs = (await fs.readdir(tmpDir)).filter(d => {
    return fs.statSync(path.join(tmpDir, d)).isDirectory() && d !== '.' && d !== '..';
  });

  // Build parent chain to order layers correctly
  const layerMeta = {};
  for (const d of dirs) {
    const metaFile = path.join(tmpDir, d, 'json');
    if (fs.existsSync(metaFile)) {
      layerMeta[d] = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    }
  }

  // Find top-most layer (the one referenced by repositories)
  const allTopLayers = Object.values(tagMap).flatMap(t => Object.values(t));
  for (const topId of allTopLayers) {
    const orderedLayers = [];
    let current = topId;
    while (current && layerMeta[current]) {
      orderedLayers.unshift(current);
      current = layerMeta[current].parent;
    }

    const imageId  = shortId();
    const imageDir = store.imageDir(imageId);
    const layerDir = path.join(imageDir, 'layers');
    await fs.ensureDir(layerDir);

    const layerRecords = [];
    for (let i = 0; i < orderedLayers.length; i++) {
      const lid  = orderedLayers[i];
      const src  = path.join(tmpDir, lid, 'layer.tar');
      const dest = path.join(layerDir, `${String(i + 1).padStart(3, '0')}.tar`);
      if (fs.existsSync(src)) {
        await fs.copy(src, dest);
        layerRecords.push({ digest: `sha256:${lid}`, file: dest, size: fs.statSync(dest).size });
      }
    }

    // Find tag for this layer
    let repo = 'imported', tag = 'latest';
    for (const [r, tags] of Object.entries(tagMap)) {
      for (const [t, id] of Object.entries(tags)) {
        if (id === topId) { repo = r; tag = t; }
      }
    }

    const rawConfig = layerMeta[topId]?.config || layerMeta[topId]?.container_config || {};
    const record = {
      id:          imageId,
      ref:         store.normaliseRef(`${repo}:${tag}`),
      repo, tag,
      created:     new Date().toISOString(),
      layerDir,
      layerCount:  layerRecords.length,
      layers:      layerRecords,
      config:      normaliseConfig({ config: rawConfig }),
      loadedFrom:  true,
    };

    store.saveImage(record);
    console.log(chalk.green(`Loaded  ${record.ref}  (id: ${imageId},  ${layerRecords.length} layers)`));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

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

function hashFile(filePath) {
  const crypto = require('crypto');
  const fs2    = require('fs');
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s    = fs2.createReadStream(filePath);
    s.on('data', d => hash.update(d));
    s.on('end',  () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });
}
