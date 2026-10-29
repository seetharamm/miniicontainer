'use strict';
/**
 * Containerfile / Dockerfile parser and builder.
 *
 * Supports:
 *   FROM [image] [AS <name>]     — including multi-stage builds
 *   RUN                          — chroot on Linux, host cmd.exe on Windows
 *   COPY [--from=<stage>] src dst
 *   ADD src dst
 *   WORKDIR, ENV, EXPOSE, CMD, ENTRYPOINT, LABEL, USER, ARG, SHELL
 */

const path  = require('path');
const fs    = require('fs-extra');
const tar   = require('tar');
const chalk = require('chalk');

const store        = require('../state/store');
const { shortId }  = require('../utils/ids');
const { pullImage } = require('./puller');
const { IS_LINUX, IS_MAC }  = require('../utils/platform');
const { run }       = require('../utils/exec');

// ------------------------------------------------------------------ build

async function buildImage(contextDir, tag) {
  const containerfilePath =
    findFile(contextDir, 'Containerfile') ||
    findFile(contextDir, 'Dockerfile');

  if (!containerfilePath) {
    throw new Error(`No Containerfile or Dockerfile found in ${contextDir}`);
  }

  console.log(chalk.cyan(`Building image from ${containerfilePath}\n`));

  const instructions = parseContainerfile(
    fs.readFileSync(containerfilePath, 'utf8')
  );

  // stages[name] = rootfs path  — for multi-stage COPY --from=<name>
  // stages['0'], stages['1'] etc. for index-based references
  const stages = {};
  let stageIndex = -1;

  // Current build state
  let rootfs   = null;
  let buildDir = null;
  let layerDir = null;
  let imageId  = null;
  let meta     = newMeta();

  // Build-time ARG values (defaults overridable at build time)
  const buildArgs = {};

  let stepNum = 0;
  for (const instr of instructions) {
    stepNum++;
    const { op, args: rawArgs } = instr;
    // Substitute ARG/ENV variables in args
    const args = substituteVars(rawArgs, buildArgs, meta.env);

    console.log(chalk.bold.white(`Step ${stepNum}/${instructions.length} :`) +
      chalk.gray(` ${op} ${args}`));

    switch (op.toUpperCase()) {

      // ── FROM ──────────────────────────────────────────────────────────────
      case 'FROM': {
        // Syntax: FROM <image> [AS <name>]
        const { baseRef, alias } = parseFrom(args);

        // Allocate a fresh rootfs for this stage
        imageId  = shortId();
        buildDir = store.imageDir(imageId);
        rootfs   = path.join(buildDir, 'rootfs');
        layerDir = path.join(buildDir, 'layers');
        await fs.ensureDir(rootfs);
        await fs.ensureDir(layerDir);
        meta = newMeta();

        stageIndex++;
        stages[String(stageIndex)] = rootfs;
        if (alias) stages[alias.toLowerCase()] = rootfs;

        // Special case: "FROM scratch" — empty rootfs, no pull
        if (baseRef.toLowerCase() === 'scratch') {
          console.log(chalk.gray('  (scratch — empty rootfs)'));
          break;
        }

        let base = store.getImage(baseRef);
        if (!base) {
          process.stdout.write(chalk.yellow(`  Base image '${baseRef}' not found locally. Pulling...\n`));
          base = await pullImage(baseRef);
        }

        const { unpackImage } = require('./puller');
        await unpackImage(base, rootfs);
        // Inherit base image metadata as defaults
        if (base.config) {
          if (base.config.env)        meta.env        = [...(base.config.env || [])];
          if (base.config.workdir)    meta.workdir    = base.config.workdir;
          if (base.config.cmd)        meta.cmd        = [...(base.config.cmd || [])];
          if (base.config.entrypoint) meta.entrypoint = [...(base.config.entrypoint || [])];
        }
        break;
      }

      // ── RUN ───────────────────────────────────────────────────────────────
      case 'RUN': {
        if (!rootfs) throw new Error('RUN before FROM');
        let result;
        if (IS_LINUX) {
          // chroot into the rootfs so the command runs against the image's filesystem
          result = await run('chroot', [rootfs, '/bin/sh', '-c', args],
            { stdio: 'inherit' });
        } else if (IS_MAC) {
          // macOS cannot chroot into a Linux rootfs; run via the host shell with
          // the rootfs as cwd so relative paths land inside the image.
          console.log(chalk.yellow('  (non-Linux host: running on the host shell in the image rootfs, not chrooted)'));
          const cwd = path.join(rootfs, meta.workdir || '/');
          await fs.ensureDir(cwd);
          const env = { ...process.env };
          for (const kv of meta.env) {
            const [k, ...rest] = kv.split('=');
            env[k] = rest.join('=');
          }
          result = await run('/bin/sh', ['-c', args], { cwd, env, stdio: 'inherit' });
        } else {
          // Windows: run on host in contextDir (Linux binaries can't run on Windows)
          result = await run('cmd', ['/C', args], { cwd: contextDir, stdio: 'inherit' });
        }
        if (result.code !== 0) {
          throw new Error(`RUN failed (exit ${result.code}): ${result.stderr || ''}`);
        }
        break;
      }

      // ── COPY / ADD ────────────────────────────────────────────────────────
      case 'COPY':
      case 'ADD': {
        if (!rootfs) throw new Error(`${op} before FROM`);

        // Check for --from=<stage>
        const { fromStage, srcArgs } = parseCopyFrom(args);
        const parts = srcArgs.trim().split(/\s+/);
        const dst   = parts.pop();
        const srcs  = parts;

        for (const src of srcs) {
          let srcPath;
          if (fromStage !== null) {
            // Copy from another stage's rootfs
            const stageRootfs = stages[fromStage.toLowerCase()] || stages[fromStage];
            if (!stageRootfs) {
              throw new Error(`COPY --from=${fromStage}: unknown stage. Known stages: ${Object.keys(stages).join(', ')}`);
            }
            srcPath = path.join(stageRootfs, src);
          } else {
            srcPath = path.join(contextDir, src);
          }

          const dstPath = path.join(rootfs, dst);
          await fs.ensureDir(path.dirname(dstPath.endsWith('/') ? dstPath : path.dirname(dstPath) ));

          if (!fs.existsSync(srcPath)) {
            throw new Error(`COPY: source not found: ${srcPath}`);
          }

          const stat = await fs.stat(srcPath);
          if (stat.isDirectory()) {
            // Copy directory contents into dst
            await fs.copy(srcPath, dstPath, { overwrite: true });
          } else {
            // If dst ends with '/', treat as directory
            const finalDst = dst.endsWith('/') ? path.join(rootfs, dst, path.basename(src)) : dstPath;
            await fs.ensureDir(path.dirname(finalDst));
            await fs.copy(srcPath, finalDst, { overwrite: true });
          }
        }
        break;
      }

      // ── WORKDIR ───────────────────────────────────────────────────────────
      case 'WORKDIR':
        if (!rootfs) throw new Error('WORKDIR before FROM');
        meta.workdir = args.trim();
        await fs.ensureDir(path.join(rootfs, meta.workdir));
        break;

      // ── ENV ───────────────────────────────────────────────────────────────
      case 'ENV': {
        // Support both "ENV KEY=VALUE KEY2=VALUE2" and legacy "ENV KEY VALUE"
        const kv = args.trim();
        const pairs = kv.includes('=')
          ? kv.match(/\S+=(?:"[^"]*"|'[^']*'|\S+)/g) || [kv]
          : [kv.replace(/\s+/, '=')];
        for (const pair of pairs) {
          const clean = pair.replace(/^(['"])|(['"])$/g, '');
          meta.env.push(clean);
          // Also expose to buildArgs for subsequent ARG substitution
          const [k, ...rest] = clean.split('=');
          buildArgs[k] = rest.join('=');
        }
        break;
      }

      // ── ARG ───────────────────────────────────────────────────────────────
      case 'ARG': {
        // Syntax: ARG NAME[=default]
        const [argName, ...defParts] = args.trim().split('=');
        if (!(argName in buildArgs) && defParts.length) {
          buildArgs[argName.trim()] = defParts.join('=');
        }
        break;
      }

      // ── EXPOSE ────────────────────────────────────────────────────────────
      case 'EXPOSE':
        meta.expose.push(args.trim());
        break;

      // ── CMD ───────────────────────────────────────────────────────────────
      case 'CMD':
        meta.cmd = parseJsonOrShell(args);
        break;

      // ── ENTRYPOINT ────────────────────────────────────────────────────────
      case 'ENTRYPOINT':
        meta.entrypoint = parseJsonOrShell(args);
        break;

      // ── SHELL ─────────────────────────────────────────────────────────────
      case 'SHELL':
        // Noted but RUN still uses /bin/sh; reserved for future use
        break;

      // ── LABEL ─────────────────────────────────────────────────────────────
      case 'LABEL': {
        const m = args.match(/(\S+)=(".*?"|'.*?'|\S+)/g) || [];
        m.forEach(pair => {
          const eqIdx = pair.indexOf('=');
          const k = pair.slice(0, eqIdx);
          const v = pair.slice(eqIdx + 1).replace(/^['"]|['"]$/g, '');
          meta.labels[k] = v;
        });
        break;
      }

      // ── USER ──────────────────────────────────────────────────────────────
      case 'USER':
        meta.user = args.trim();
        break;

      // ── STOPSIGNAL / HEALTHCHECK / ONBUILD / VOLUME ───────────────────────
      case 'STOPSIGNAL':
      case 'HEALTHCHECK':
      case 'ONBUILD':
      case 'VOLUME':
        console.log(chalk.gray(`  (noted, not enforced: ${op})`));
        break;

      default:
        console.log(chalk.yellow(`  WARNING: unknown instruction '${op}' — skipped`));
    }
  }

  if (!rootfs) throw new Error('Containerfile has no FROM instruction');

  // Pack the final rootfs into a single layer tarball
  const layerPath = path.join(layerDir, '1.tar');
  process.stdout.write(chalk.gray('\nPacking final layer...'));
  await tar.create({ gzip: false, file: layerPath, cwd: rootfs }, ['.']);
  process.stdout.write(chalk.green(' done\n'));

  // Normalise tag → repo:tag
  const { normRepo, normTag, normRef } = normaliseTag(tag, imageId);

  const record = {
    id:           imageId,
    ref:          normRef,
    repo:         normRepo,
    tag:          normTag,
    created:      new Date().toISOString(),
    layerDir,
    layerCount:   1,
    config:       meta,
    builtLocally: true,
  };

  store.saveImage(record);
  console.log(chalk.green(`\nSuccessfully built ${normRef}`));
  console.log(chalk.cyan(`Image ID: ${imageId}`));
  return record;
}

// ------------------------------------------------------------------ helpers

function newMeta() {
  return { env: [], workdir: '/', cmd: [], entrypoint: [], expose: [], labels: {}, user: '' };
}

function findFile(dir, name) {
  const p = path.join(dir, name);
  return fs.existsSync(p) ? p : null;
}

/**
 * Parse "FROM <image> [AS <alias>]"
 * Handles: FROM ubuntu, FROM ubuntu:22.04, FROM eclipse-temurin:21 AS builder
 */
function parseFrom(args) {
  const parts = args.trim().split(/\s+/);
  const baseRef = parts[0];
  let alias = null;
  // parts[1] would be "AS", parts[2] would be the alias name
  if (parts.length >= 3 && parts[1].toUpperCase() === 'AS') {
    alias = parts[2];
  }
  return { baseRef, alias };
}

/**
 * Parse COPY [--from=<stage>] <srcs...> <dst>
 * Returns { fromStage: string|null, srcArgs: string }
 */
function parseCopyFrom(args) {
  const fromMatch = args.match(/^--from=(\S+)\s+/i);
  if (fromMatch) {
    return { fromStage: fromMatch[1], srcArgs: args.slice(fromMatch[0].length) };
  }
  return { fromStage: null, srcArgs: args };
}

function parseContainerfile(text) {
  const lines = text.split('\n');
  const instructions = [];
  let current = '';

  for (const raw of lines) {
    const line = raw.trimEnd();
    // Line continuation
    if (line.endsWith('\\')) {
      current += line.slice(0, -1) + ' ';
      continue;
    }
    current += line;
    const trimmed = current.trim();
    current = '';
    if (!trimmed || trimmed.startsWith('#')) continue;
    const spaceIdx = trimmed.search(/\s/);
    if (spaceIdx === -1) continue;
    const op   = trimmed.slice(0, spaceIdx);
    const args = trimmed.slice(spaceIdx + 1).trim();
    instructions.push({ op, args });
  }
  return instructions;
}

function parseJsonOrShell(args) {
  const trimmed = args.trim();
  if (trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch {}
  }
  return ['/bin/sh', '-c', trimmed];
}

/**
 * Substitute ${VAR} and $VAR patterns from buildArgs and env.
 */
function substituteVars(str, buildArgs, envArr) {
  const envMap = {};
  for (const kv of envArr) {
    const [k, ...rest] = kv.split('=');
    envMap[k] = rest.join('=');
  }
  const vars = { ...buildArgs, ...envMap };
  return str
    .replace(/\$\{([^}]+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `\${${k}}`)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => vars[k] !== undefined ? vars[k] : `$${k}`);
}

/**
 * Normalise a tag string like "myapp:1.0" or "org/myapp:latest"
 * into { normRepo, normTag, normRef }.
 */
function normaliseTag(tag, imageId) {
  if (!tag) {
    const short = imageId.slice(0, 8);
    return { normRepo: 'minicontainer-build', normTag: short, normRef: `minicontainer-build:${short}` };
  }
  const lastColon = tag.lastIndexOf(':');
  if (lastColon === -1 || lastColon === 0) {
    return { normRepo: tag, normTag: 'latest', normRef: `${tag}:latest` };
  }
  const normRepo = tag.slice(0, lastColon);
  const normTag  = tag.slice(lastColon + 1) || 'latest';
  return { normRepo, normTag, normRef: `${normRepo}:${normTag}` };
}

module.exports = { buildImage };
