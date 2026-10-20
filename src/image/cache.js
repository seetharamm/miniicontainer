'use strict';
/**
 * Content-addressable layer cache.
 *
 * Layers are stored once by their sha256 digest under:
 *   ~/.minicontainer/cache/blobs/sha256/<hex>
 *
 * Before downloading any layer, callers should check isCached(digest).
 * After a successful download into a temp path, call commit(tmpPath, digest)
 * to move it into the cache atomically.
 *
 * This means two images that share a layer (e.g. all ubuntu-based images
 * share the base ubuntu layers) download each layer exactly once.
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs-extra');
const crypto = require('crypto');

const CACHE_ROOT  = path.join(os.homedir(), '.minicontainer', 'cache');
const BLOB_DIR    = path.join(CACHE_ROOT, 'blobs', 'sha256');
const TEMP_DIR    = path.join(CACHE_ROOT, 'tmp');

fs.ensureDirSync(BLOB_DIR);
fs.ensureDirSync(TEMP_DIR);

/**
 * Returns the on-disk path for a cached blob.
 * @param {string} digest  e.g. "sha256:abc123..."
 */
function blobPath(digest) {
  const hex = digest.startsWith('sha256:') ? digest.slice(7) : digest;
  return path.join(BLOB_DIR, hex);
}

/**
 * Returns true if the layer for `digest` is already in the cache.
 */
function isCached(digest) {
  return fs.existsSync(blobPath(digest));
}

/**
 * Returns the size in bytes of a cached blob, or 0 if not cached.
 */
function cachedSize(digest) {
  const p = blobPath(digest);
  if (!fs.existsSync(p)) return 0;
  return fs.statSync(p).size;
}

/**
 * Allocate a temp path for a new download.
 * Call commit() once the download succeeds.
 */
function tempPath(digest) {
  const hex = digest.startsWith('sha256:') ? digest.slice(7) : digest;
  return path.join(TEMP_DIR, hex + '.part');
}

/**
 * Move a completed download from tmpPath into the cache atomically.
 * Verifies the sha256 digest of the downloaded content first.
 *
 * @param {string} tmp     Path to the completed download (from tempPath())
 * @param {string} digest  Expected digest, e.g. "sha256:abc..."
 * @throws if the digest does not match
 */
async function commit(tmp, digest) {
  // Verify digest
  const actual = await sha256File(tmp);
  const expected = digest.startsWith('sha256:') ? digest.slice(7) : digest;
  if (actual !== expected) {
    await fs.remove(tmp).catch(() => {});
    throw new Error(
      `Digest mismatch for layer ${digest.slice(7, 19)}: ` +
      `expected ${expected.slice(0, 16)}, got ${actual.slice(0, 16)}`
    );
  }

  const dest = blobPath(digest);
  // Atomic rename — works across filesystems on same drive
  try {
    await fs.move(tmp, dest, { overwrite: false });
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Another concurrent pull already committed this layer; discard ours
      await fs.remove(tmp).catch(() => {});
    } else {
      throw err;
    }
  }
}

/**
 * Return the cached blob path so callers can symlink or copy it.
 * Throws if not cached.
 */
function get(digest) {
  const p = blobPath(digest);
  if (!fs.existsSync(p)) throw new Error(`Layer not in cache: ${digest}`);
  return p;
}

/**
 * Hard-link (preferred) or copy a cached blob to destPath.
 * Hard-linking avoids duplicating bytes on the same filesystem.
 */
async function linkTo(digest, destPath) {
  const src = get(digest);
  await fs.ensureDir(path.dirname(destPath));
  try {
    await fs.link(src, destPath);          // hard-link — instant, zero disk cost
  } catch (e) {
    if (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EEXIST') {
      await fs.copy(src, destPath, { overwrite: true }); // cross-device fallback
    } else {
      throw e;
    }
  }
}

/**
 * List all cached digests.
 * @returns {string[]}  e.g. ["sha256:abc...", ...]
 */
async function listCached() {
  const files = await fs.readdir(BLOB_DIR).catch(() => []);
  return files.map(f => `sha256:${f}`);
}

/**
 * Remove a blob from the cache (gc helper).
 */
async function evict(digest) {
  await fs.remove(blobPath(digest)).catch(() => {});
}

// ── internal ─────────────────────────────────────────────────────────────────

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end',  () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

module.exports = {
  CACHE_ROOT,
  BLOB_DIR,
  blobPath,
  isCached,
  cachedSize,
  tempPath,
  commit,
  get,
  linkTo,
  listCached,
  evict,
};
