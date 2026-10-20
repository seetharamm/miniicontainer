'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { IS_LINUX } = require('../utils/platform');
const { run } = require('../utils/exec');
const { unpackImage } = require('../image/puller');

const CACHE_ROOT = path.join(os.homedir(), '.minicontainer', 'overlay');

async function prepareLower(imageRecord) {
  const key = (imageRecord.digest || imageRecord.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const lowerDir = path.join(CACHE_ROOT, 'lower', key);
  const marker = path.join(lowerDir, '.minicontainer-ready');
  await fs.ensureDir(path.dirname(lowerDir));
  if (!fs.existsSync(marker)) {
    await fs.remove(lowerDir);
    await fs.ensureDir(lowerDir);
    await unpackImage(imageRecord, lowerDir);
    await fs.writeFile(marker, 'ready\n');
  }
  return lowerDir;
}

async function mountOverlay(lowerDir, upperDir, workDir, mergedDir) {
  if (!IS_LINUX) return false;
  await fs.ensureDir(upperDir);
  await fs.ensureDir(workDir);
  await fs.ensureDir(mergedDir);
  const options = `lowerdir=${lowerDir},upperdir=${upperDir},workdir=${workDir}`;
  const result = await run('mount', ['-t', 'overlay', 'overlay', '-o', options, mergedDir]);
  if (result.code !== 0) throw new Error(result.stderr || 'OverlayFS mount failed');
  return true;
}

async function unmountOverlay(mergedDir) {
  if (!IS_LINUX) return;
  await run('umount', ['-lf', mergedDir]).catch(() => {});
}

module.exports = { prepareLower, mountOverlay, unmountOverlay };
