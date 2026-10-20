'use strict';
/**
 * minicontainer cp — copy files between host and container rootfs
 *
 * Syntax (matches docker cp):
 *   minicontainer cp <container>:<srcPath>  <hostDest>   (container → host)
 *   minicontainer cp <hostSrc>  <container>:<destPath>   (host → container)
 *
 * If <hostDest> is "-" the tar stream is written to STDOUT (like docker cp).
 * On Windows the container rootfs is accessed directly via the stored rootfsDir.
 * On Linux the same applies — we don't need to nsenter for filesystem access.
 */

const path    = require('path');
const fs      = require('fs-extra');
const tar     = require('tar');
const store   = require('../state/store');

/**
 * Parse a cp argument into { containerId, filePath } or { filePath } (host).
 * A colon that is NOT part of a Windows drive letter (C:) distinguishes container paths.
 */
function parseCpArg(arg) {
  // Windows drive letter: exactly one uppercase/lowercase letter followed by :\
  // e.g. C:\foo or C:/foo — do NOT treat as container:path
  const winDrive = /^[A-Za-z]:[/\\]/;
  if (winDrive.test(arg)) return { filePath: arg };

  const colonIdx = arg.indexOf(':');
  if (colonIdx === -1) return { filePath: arg };

  return {
    containerId: arg.slice(0, colonIdx),
    filePath:    arg.slice(colonIdx + 1) || '/',
  };
}

/**
 * Resolve the absolute path inside the container's rootfs directory.
 */
function rootfsPath(rootfsDir, containerPath) {
  // Strip leading slash so path.join doesn't treat it as absolute
  const rel = containerPath.replace(/^[/\\]+/, '');
  return path.join(rootfsDir, rel);
}

async function cpCommand(src, dest) {
  const srcParsed  = parseCpArg(src);
  const destParsed = parseCpArg(dest);

  const fromContainer = !!srcParsed.containerId;
  const toContainer   = !!destParsed.containerId;

  if (fromContainer && toContainer) {
    throw new Error('Cannot copy between two containers — specify a host path on one side');
  }
  if (!fromContainer && !toContainer) {
    throw new Error('One argument must be a container path (<container>:<path>)');
  }

  const containerId = fromContainer ? srcParsed.containerId : destParsed.containerId;
  const container   = store.getContainer(containerId);
  if (!container) throw new Error(`No such container: ${containerId}`);

  const rootfsDir = container.rootfsDir;
  if (!rootfsDir || !fs.existsSync(rootfsDir)) {
    throw new Error(`Container rootfs not found at: ${rootfsDir}`);
  }

  if (fromContainer) {
    // ── Container → Host ──────────────────────────────────────────────────────
    const srcAbsolute = rootfsPath(rootfsDir, srcParsed.filePath);
    if (!fs.existsSync(srcAbsolute)) {
      throw new Error(`No such file or directory in container: ${srcParsed.filePath}`);
    }

    if (destParsed.filePath === '-') {
      // Stream tar to stdout
      const base = path.basename(srcAbsolute);
      const cwd  = path.dirname(srcAbsolute);
      await tar.create({ gzip: false, cwd }, [base]).pipe(process.stdout);
    } else {
      const destHost = path.resolve(destParsed.filePath);
      const stat = fs.statSync(srcAbsolute);

      if (stat.isDirectory()) {
        // Copy directory contents into destination
        await fs.ensureDir(destHost);
        await fs.copy(srcAbsolute, destHost, { overwrite: true });
        console.log(`Copied directory ${srcParsed.filePath} → ${destHost}`);
      } else {
        // Copy single file — if dest is an existing dir, copy into it
        let finalDest = destHost;
        if (fs.existsSync(destHost) && fs.statSync(destHost).isDirectory()) {
          finalDest = path.join(destHost, path.basename(srcAbsolute));
        }
        await fs.ensureDir(path.dirname(finalDest));
        await fs.copy(srcAbsolute, finalDest, { overwrite: true });
        console.log(`Copied ${srcParsed.filePath} → ${finalDest}`);
      }
    }
  } else {
    // ── Host → Container ──────────────────────────────────────────────────────
    const srcHost    = path.resolve(srcParsed.filePath);
    if (!fs.existsSync(srcHost)) {
      throw new Error(`No such file or directory on host: ${srcParsed.filePath}`);
    }

    const destAbsolute = rootfsPath(rootfsDir, destParsed.filePath);
    const srcStat = fs.statSync(srcHost);

    if (srcStat.isDirectory()) {
      await fs.ensureDir(destAbsolute);
      await fs.copy(srcHost, destAbsolute, { overwrite: true });
      console.log(`Copied ${srcHost} → container:${destParsed.filePath}`);
    } else {
      let finalDest = destAbsolute;
      // If destination path looks like a directory (ends with /) or IS an existing dir
      if (destParsed.filePath.endsWith('/') ||
          (fs.existsSync(destAbsolute) && fs.statSync(destAbsolute).isDirectory())) {
        finalDest = path.join(destAbsolute, path.basename(srcHost));
      }
      await fs.ensureDir(path.dirname(finalDest));
      await fs.copy(srcHost, finalDest, { overwrite: true });
      console.log(`Copied ${srcHost} → container:${destParsed.filePath}`);
    }
  }
}

module.exports = cpCommand;
module.exports.parseCpArg = parseCpArg;
