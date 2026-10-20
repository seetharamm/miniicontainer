'use strict';
/**
 * Volume management — parse, create, mount, and unmount container volumes.
 *
 * ── Volume spec syntax ────────────────────────────────────────────────────────
 *
 *   [source:]target[:options]
 *
 *   source   = host absolute path    → bind mount
 *            = relative path         → bind mount (resolved relative to cwd)
 *            = volume name           → named volume (managed by minicontainer)
 *            = (omitted)             → anonymous volume (tmpfs on Linux)
 *
 *   target   = absolute path inside the container
 *
 *   options  = comma-separated list of:
 *                ro / readonly       → mount read-only
 *                rw                  → mount read-write (default)
 *                z / Z               → SELinux relabelling (noted; not enforced)
 *                shared / slave /
 *                private / rprivate  → mount propagation
 *                nocopy              → don't copy image content into the volume
 *
 *   Examples:
 *     /host/data:/app/data           bind-mount, read-write
 *     /host/config:/etc/app:ro       bind-mount, read-only
 *     myvolume:/app/data             named volume
 *     myvolume:/app/data:ro          named volume, read-only
 *     /app/logs                      anonymous volume (target only)
 *     ./local:/app:rw                relative bind mount
 *
 * ── Named volumes ─────────────────────────────────────────────────────────────
 *
 *   Stored in:  ~/.minicontainer/volumes/<name>/
 *   Persisted across container restarts.
 *   Created on first use.
 *
 * ── Linux mount mechanism ─────────────────────────────────────────────────────
 *
 *   bind mounts:   mount --bind <src> <rootfs/dst>
 *   read-only:     mount --bind <src> <rootfs/dst> && mount -o remount,ro,bind <rootfs/dst>
 *   anonymous:     mount -t tmpfs tmpfs <rootfs/dst>
 *
 *   The container is started with `unshare --mount` so the bind mounts are in
 *   the container's own mount namespace and do not affect the host.
 *
 * ── Windows mount mechanism ───────────────────────────────────────────────────
 *
 *   Directory bind mounts → NTFS directory junctions (fs.ensureSymlink 'junction')
 *   File bind mounts      → hard links (same volume) or fs.copy (cross-volume)
 *   Read-only             → strip write ACL after creating the link
 *   Named volumes         → junction to the managed volume directory
 */

'use strict';

const path   = require('path');
const os     = require('os');
const fs     = require('fs-extra');
const chalk  = require('chalk');

const { IS_LINUX, IS_WINDOWS } = require('../utils/platform');
const { run }      = require('../utils/exec');
const eventlog     = require('../state/eventlog');

// ── Volume store paths ────────────────────────────────────────────────────────

const VOLUMES_ROOT = path.join(os.homedir(), '.minicontainer', 'volumes');
const VOLUMES_DB   = path.join(os.homedir(), '.minicontainer', 'volumes.json');
fs.ensureDirSync(VOLUMES_ROOT);

// ── Spec parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a -v / --volume flag value into a normalised VolumeSpec object.
 *
 * @param {string} spec   e.g. "/host/data:/app/data:ro"
 * @returns {VolumeSpec}
 *
 * @typedef {object} VolumeSpec
 * @property {string|null} source       Host path or named-volume name (null = anonymous)
 * @property {string}      target       Absolute path inside the container
 * @property {boolean}     readOnly
 * @property {boolean}     named        true if source is a managed named volume
 * @property {boolean}     anonymous    true if no source was given
 * @property {string}      propagation  "private"|"shared"|"slave"|"rprivate" (Linux only)
 * @property {boolean}     nocopy       don't seed from image
 * @property {string}      raw          original spec string
 */
function parseVolumeSpec(spec) {
  if (!spec || !spec.trim()) throw new Error('Empty volume spec');

  // Split into at most 3 parts on ':'
  // Edge case: Windows absolute paths start with C:\, which contains a colon.
  // We handle that by detecting drive-letter prefixes.
  const parts = splitVolumeSpec(spec);

  let source, target, optStr;

  if (parts.length === 1) {
    // Only a target path — anonymous volume
    source = null;
    target = parts[0];
    optStr = '';
  } else if (parts.length === 2) {
    // Could be source:target or target:options (if first part looks like options)
    if (looksLikeOptions(parts[1])) {
      source = null;
      target = parts[0];
      optStr = parts[1];
    } else {
      source = parts[0];
      target = parts[1];
      optStr = '';
    }
  } else {
    source = parts[0];
    target = parts[1];
    optStr = parts[2];
  }

  // Validate target is absolute inside the container
  if (!target.startsWith('/') && !target.startsWith('\\')) {
    throw new Error(
      `Volume target must be an absolute path, got: "${target}"\n` +
      `  Spec: "${spec}"`
    );
  }

  // Parse options
  const opts     = optStr.toLowerCase().split(',').map(o => o.trim()).filter(Boolean);
  const readOnly = opts.includes('ro') || opts.includes('readonly');
  const nocopy   = opts.includes('nocopy');
  const propOpts = ['shared', 'slave', 'private', 'rprivate', 'rshared', 'rslave'];
  const propagation = opts.find(o => propOpts.includes(o)) || 'rprivate';

  // Determine source type
  let named     = false;
  let anonymous = false;
  let resolvedSource = source;

  if (source === null) {
    anonymous = true;
  } else if (isNamedVolume(source)) {
    named          = true;
    resolvedSource = ensureNamedVolume(source);
  } else {
    // Host path — resolve relative paths against cwd
    resolvedSource = path.resolve(source);
    if (!fs.existsSync(resolvedSource)) {
      // Auto-create host directories (matches Docker behaviour)
      fs.ensureDirSync(resolvedSource);
    }
  }

  return {
    source:      resolvedSource,
    target,
    readOnly,
    named,
    anonymous,
    propagation,
    nocopy,
    volumeName:  named ? source : null,
    raw:         spec,
  };
}

/**
 * Parse all volume specs for a container.
 * @param {string[]} specs
 * @returns {VolumeSpec[]}
 */
function parseVolumeSpecs(specs) {
  if (!specs || specs.length === 0) return [];
  return specs.map(s => parseVolumeSpec(s));
}

// ── Mount / unmount ───────────────────────────────────────────────────────────

/**
 * Apply all volume mounts into the container rootfs.
 *
 * On Linux:  uses `mount --bind` (or tmpfs for anonymous volumes).
 *            Must be called inside the container's mount namespace, i.e.
 *            AFTER `unshare --mount` has been called but we write directly
 *            into the rootfs so chroot will see the correct mounts.
 *            We use the host-side mount so that:
 *              - The mount is visible as a chroot bind point
 *              - The mount is confined to the container's mount namespace
 *
 * On Windows: creates NTFS junctions for directories, hard-links for files.
 *
 * @param {VolumeSpec[]} specs
 * @param {string}       rootfs   Absolute path to the container rootfs
 * @param {string}       containerId
 * @returns {string[]}   List of successfully mounted target paths (for unmount)
 */
async function mountVolumes(specs, rootfs, containerId) {
  if (!specs || specs.length === 0) return [];

  const mounted = [];

  for (const spec of specs) {
    const dstAbs = path.join(rootfs, spec.target);

    try {
      if (IS_LINUX) {
        await mountLinux(spec, dstAbs);
      } else {
        await mountWindows(spec, dstAbs);
      }
      mounted.push(spec.target);
      console.log(chalk.gray(
        `  Volume: ${spec.anonymous ? '(anonymous)' : spec.source} → ` +
        `${spec.target}${spec.readOnly ? ' [ro]' : ''}`
      ));
    } catch (err) {
      console.warn(chalk.yellow(
        `  Volume mount failed: ${spec.raw}\n  Reason: ${err.message}`
      ));
    }
  }

  return mounted;
}

async function mountLinux(spec, dstAbs) {
  await fs.ensureDir(dstAbs);

  if (spec.anonymous) {
    // Anonymous: tmpfs mount — data lives only for the container's lifetime
    await run('mount', ['-t', 'tmpfs', 'tmpfs', dstAbs]);
    return;
  }

  const src = spec.source;
  const srcStat = await fs.stat(src).catch(() => null);

  if (srcStat && srcStat.isFile()) {
    // File bind-mount: the target must be a file, not a directory
    await fs.ensureFile(dstAbs);
    await run('mount', ['--bind', src, dstAbs]);
  } else {
    // Directory bind-mount
    await run('mount', ['--bind', src, dstAbs]);
  }

  // Apply read-only: a second mount call with remount,ro
  if (spec.readOnly) {
    await run('mount', ['-o', 'remount,ro,bind', dstAbs]);
  }

  // Mount propagation (only meaningful for shared subtrees)
  if (spec.propagation && spec.propagation !== 'rprivate') {
    await run('mount', ['--make-' + spec.propagation, dstAbs]).catch(() => {});
  }
}

async function mountWindows(spec, dstAbs) {
  if (spec.anonymous) {
    // Anonymous: just ensure the directory exists (no true tmpfs on Windows)
    await fs.ensureDir(dstAbs);
    return;
  }

  const src = spec.source;
  const srcStat = await fs.stat(src).catch(() => null);

  // Remove any existing path at the destination first
  await fs.remove(dstAbs).catch(() => {});

  if (srcStat && srcStat.isFile()) {
    // File: hard-link if same volume, copy otherwise
    await fs.ensureDir(path.dirname(dstAbs));
    try {
      await fs.link(src, dstAbs);
    } catch (e) {
      if (e.code === 'EXDEV') {
        await fs.copy(src, dstAbs);
      } else {
        throw e;
      }
    }
  } else {
    // Directory: NTFS junction (works without admin rights, unlike symlinks)
    await fs.ensureDir(path.dirname(dstAbs));
    await fs.ensureSymlink(src, dstAbs, 'junction');
  }

  // Read-only: strip the Write ACL using icacls
  if (spec.readOnly) {
    await run('icacls', [dstAbs, '/deny', 'Everyone:(W)']).catch(() => {});
  }
}

// ── Unmount ───────────────────────────────────────────────────────────────────

/**
 * Unmount all user volumes from the container rootfs.
 * Called before the container directory is removed.
 *
 * On Linux: lazy unmount (`umount -l`) so it completes even if the container
 * process hasn't fully exited yet.
 * On Windows: remove the junction/hard-link (leaves the source intact).
 *
 * @param {VolumeSpec[]} specs
 * @param {string}       rootfs
 */
async function unmountVolumes(specs, rootfs) {
  if (!specs || specs.length === 0) return;
  if (!IS_LINUX) return;   // Windows junctions are removed with the rootfs dir

  // Unmount in reverse order (deepest paths first)
  const targets = specs
    .map(s => path.join(rootfs, s.target))
    .sort((a, b) => b.length - a.length);   // descending length = deepest first

  for (const t of targets) {
    await run('umount', ['-l', t]).catch(() => {});
  }
}

// ── Named volume store ────────────────────────────────────────────────────────

/**
 * Return true if the string looks like a named volume (not an absolute or
 * relative path).
 *
 * Named volumes:
 *   - contain only [a-zA-Z0-9_.-]
 *   - do NOT start with / \ . or a drive letter (C:)
 */
function isNamedVolume(s) {
  if (!s) return false;
  if (s.startsWith('/') || s.startsWith('\\') || s.startsWith('.')) return false;
  // Windows drive letter:  C:\...  or  C:/...
  if (/^[a-zA-Z]:[/\\]/.test(s)) return false;
  return /^[a-zA-Z0-9_.\-]+$/.test(s);
}

/**
 * Ensure a named volume directory exists and is registered in the DB.
 * Returns the absolute host path to the volume directory.
 */
function ensureNamedVolume(name) {
  const db  = readVolumesDb();
  if (!db[name]) {
    const volPath = path.join(VOLUMES_ROOT, name);
    fs.ensureDirSync(volPath);
    db[name] = {
      name,
      path:    volPath,
      created: new Date().toISOString(),
      labels:  {},
    };
    writeVolumesDb(db);
    eventlog.volume.create(name, volPath);
  }
  return db[name].path;
}

function readVolumesDb() {
  if (!fs.existsSync(VOLUMES_DB)) return {};
  try { return JSON.parse(fs.readFileSync(VOLUMES_DB, 'utf8')); } catch { return {}; }
}

function writeVolumesDb(db) {
  const tmp = VOLUMES_DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, VOLUMES_DB);
}

function listNamedVolumes() {
  return Object.values(readVolumesDb());
}

function getNamedVolume(name) {
  return readVolumesDb()[name] || null;
}

function removeNamedVolume(name) {
  const db = readVolumesDb();
  if (!db[name]) throw new Error(`No such volume: ${name}`);
  const volPath = db[name].path;
  fs.removeSync(volPath);
  delete db[name];
  writeVolumesDb(db);
  eventlog.volume.destroy(name);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Split a volume spec on ':' while respecting Windows drive letters.
 * "C:\data:/app" → ["C:\\data", "/app"]
 * "/a:/b:ro"     → ["/a", "/b", "ro"]
 */
function splitVolumeSpec(spec) {
  // On Windows a drive-letter path is C:\... — consume it as one token
  const winDrive = spec.match(/^([a-zA-Z]:[/\\][^:]*)/);
  if (winDrive) {
    const rest  = spec.slice(winDrive[1].length);
    const parts = rest.startsWith(':') ? rest.slice(1).split(':') : rest.split(':');
    return [winDrive[1], ...parts].filter((_, i, arr) => i === 0 || arr[i] !== '');
  }
  return spec.split(':');
}

/**
 * Return true if a string looks like a volume options segment rather than a path.
 * e.g. "ro", "rw", "ro,z", "shared"
 */
function looksLikeOptions(s) {
  const knownOpts = /^(ro|rw|readonly|z|Z|nocopy|shared|slave|private|rprivate|rshared|rslave)(,(ro|rw|readonly|z|Z|nocopy|shared|slave|private|rprivate|rshared|rslave))*$/i;
  return knownOpts.test(s.trim());
}

module.exports = {
  parseVolumeSpec,
  parseVolumeSpecs,
  mountVolumes,
  unmountVolumes,
  isNamedVolume,
  ensureNamedVolume,
  listNamedVolumes,
  getNamedVolume,
  removeNamedVolume,
  VOLUMES_ROOT,
  VOLUMES_DB,
};
