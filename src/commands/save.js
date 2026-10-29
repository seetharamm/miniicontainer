'use strict';
/**
 * minicontainer save <image> [-o output.tar]
 *
 * Exports a local image to a Docker-compatible tarball with the layout:
 *
 *   manifest.json                    ← image manifest index
 *   <configDigest>.json              ← OCI image config
 *   <layerDigest>/
 *     layer.tar                      ← each layer tarball
 *   repositories                     ← legacy Docker tag map
 *
 * The output can be loaded by:
 *   docker load -i output.tar
 *   minicontainer load -i output.tar
 */

const path  = require('path');
const fs    = require('fs-extra');
const tar   = require('tar');
const chalk = require('chalk');

const store = require('../state/store');

module.exports = async function save(imageRef, opts) {
  const record = store.getImage(imageRef);
  if (!record) {
    console.error(chalk.red(`No such image: ${imageRef}`));
    console.error(chalk.gray('  Run: minicontainer images  to list available images'));
    process.exit(1);
  }

  const outPath = opts.output || `${record.repo.replace(/\//g, '_')}_${record.tag}.tar`;
  const absOut  = path.resolve(outPath);

  console.log(chalk.cyan(`Saving ${record.ref} → ${absOut}`));

  // Build the Docker-compatible tarball in a temp directory
  const tmpDir = path.join(require('os').tmpdir(), `mc_save_${Date.now()}`);
  await fs.ensureDir(tmpDir);

  try {
    // ── 1. Copy layer tarballs ───────────────────────────────────────────
    const layerPaths = [];  // relative paths inside the tarball
    const diffIds    = [];

    const layers = record.layers || [];
    if (layers.length === 0) {
      // Older image record: fall back to reading the layerDir
      const files = (await fs.readdir(record.layerDir))
        .filter(f => f.endsWith('.tar'))
        .sort();
      for (const f of files) {
        layers.push({ file: path.join(record.layerDir, f), digest: f.replace('.tar', '') });
      }
    }

    for (let i = 0; i < layers.length; i++) {
      const layer    = layers[i];
      const digest   = (layer.digest || '').replace('sha256:', '') || String(i);
      const shortHex = digest.slice(0, 64).padEnd(64, '0');
      const layerDir = path.join(tmpDir, shortHex);
      await fs.ensureDir(layerDir);
      await fs.copy(layer.file, path.join(layerDir, 'layer.tar'));
      layerPaths.push(`${shortHex}/layer.tar`);
      diffIds.push('sha256:' + require('crypto').createHash('sha256')
        .update(await fs.readFile(layer.file)).digest('hex'));
    }

    // ── 2. Write image config JSON ───────────────────────────────────────
    const cfg = record.config || {};
    const ociConfig = {
      architecture: 'amd64',
      os:           'linux',
      config: {
        Env:         cfg.env        || [],
        WorkingDir:  cfg.workdir    || '/',
        Cmd:         cfg.cmd        || [],
        Entrypoint:  cfg.entrypoint || [],
        ExposedPorts: Object.fromEntries((cfg.expose || []).map(p => [`${p}/tcp`, {}])),
        Labels:      cfg.labels     || {},
        User:        cfg.user       || '',
      },
      rootfs: {
        type:    'layers',
        diff_ids: diffIds,
      },
      history: [],
    };

    const configFile = `${record.id}.json`;
    await fs.writeJson(path.join(tmpDir, configFile), ociConfig, { spaces: 2 });

    // ── 3. Write manifest.json ───────────────────────────────────────────
    const manifestJson = [
      {
        Config:   configFile,
        RepoTags: [`${record.repo.replace(/^library\//, '')}:${record.tag}`],
        Layers:   layerPaths,
      },
    ];
    await fs.writeJson(path.join(tmpDir, 'manifest.json'), manifestJson, { spaces: 2 });

    // ── 4. Write repositories (legacy Docker format) ─────────────────────
    const repoName = record.repo.replace(/^library\//, '');
    const repositories = { [repoName]: { [record.tag]: record.id } };
    await fs.writeJson(path.join(tmpDir, 'repositories'), repositories, { spaces: 2 });

    // ── 5. Pack everything into the output tarball ───────────────────────
    await fs.ensureDir(path.dirname(absOut));
    await tar.create({ file: absOut, cwd: tmpDir, gzip: false }, ['.']);

    const sizeMB = (fs.statSync(absOut).size / 1024 / 1024).toFixed(1);
    console.log(chalk.green(`\nSaved ${record.ref}  (${sizeMB} MB)  →  ${absOut}`));

  } finally {
    await fs.remove(tmpDir);
  }
};
