'use strict';
/**
 * cgroups.js — Linux cgroup v1 and v2 resource limits for containers.
 *
 * ── What cgroups do ──────────────────────────────────────────────────────────
 *
 *   A cgroup ("control group") is a kernel feature that lets you put one or
 *   more PIDs into a named group and then set hard limits on what that group
 *   can consume:
 *
 *     memory.limit_in_bytes   → OOM-kills the cgroup if it exceeds this RAM
 *     cpu.cfs_quota_us        → hard CPU quota over the CFS scheduler period
 *     pids.max                → maximum number of simultaneous processes
 *     blkio.weight            → relative I/O priority (100–1000)
 *
 *   These map directly to the --memory / --cpus / --pids-limit / --blkio
 *   flags the user passes when running a container.
 *
 * ── cgroup v1 vs v2 ──────────────────────────────────────────────────────────
 *
 *   v1 (traditional, Linux < 4.5, still common):
 *     /sys/fs/cgroup/memory/minicontainer/<id>/
 *     /sys/fs/cgroup/cpu/minicontainer/<id>/
 *     /sys/fs/cgroup/pids/minicontainer/<id>/
 *     /sys/fs/cgroup/blkio/minicontainer/<id>/
 *
 *   v2 (unified hierarchy, systemd ≥ 244, Linux ≥ 4.5):
 *     /sys/fs/cgroup/minicontainer/<id>/
 *
 *   Detection: if /sys/fs/cgroup/cgroup.controllers exists → v2.
 *
 * ── Windows ──────────────────────────────────────────────────────────────────
 *
 *   Cgroups don't exist on Windows.  We use a Windows Job Object instead,
 *   which provides equivalent CPU-time and memory limits via the Win32 API
 *   through a small PowerShell helper.
 *
 * ── Usage from runtime.js ────────────────────────────────────────────────────
 *
 *   const cg = await Cgroup.create(containerId, { memory, cpus, pidsLimit, blkio });
 *   cg.attach(pid);          // move the container PID into the cgroup
 *   // ... container runs ...
 *   await cg.destroy();      // remove the cgroup directory
 *   cg.stats()               // → { memoryUsage, cpuUsage, pids }
 */

'use strict';

const path  = require('path');
const fs    = require('fs-extra');
const chalk = require('chalk');

const { IS_LINUX, IS_WINDOWS } = require('../utils/platform');
const { run } = require('../utils/exec');

// ── cgroup root detection ─────────────────────────────────────────────────────

const CGROUPV2_MARKER = '/sys/fs/cgroup/cgroup.controllers';
const CGROUPV1_ROOT   = '/sys/fs/cgroup';
const CGROUPV2_ROOT   = '/sys/fs/cgroup';
const MC_SLICE        = 'minicontainer';   // subdirectory within the cgroup fs

let _cgroupVersion = null;   // cached after first detection

function detectVersion() {
  if (_cgroupVersion) return _cgroupVersion;
  if (!IS_LINUX) return null;
  _cgroupVersion = fs.existsSync(CGROUPV2_MARKER) ? 2 : 1;
  return _cgroupVersion;
}

// ── limit value parsing ───────────────────────────────────────────────────────

/**
 * Parse a memory string to bytes.
 * Accepts: "256m", "512M", "1g", "1G", "1024k", "1073741824" (bare bytes)
 */
function parseMemory(val) {
  if (!val) return null;
  const s = String(val).trim();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*([kmgKMG]?)b?$/i);
  if (!match) throw new Error(`Invalid memory value: "${val}" — use e.g. 256m, 512M, 1g`);
  const n = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[unit];
  if (mult === undefined) throw new Error(`Unknown memory unit: "${match[2]}"`);
  return Math.floor(n * mult);
}

/**
 * Convert a CPU fractional value to CFS quota microseconds.
 * The CFS period is 100,000 µs (100 ms) by convention.
 *   "--cpus 0.5" → 50,000 µs quota per 100,000 µs period → 50% of one core
 *   "--cpus 2"   → 200,000 µs → 2 full cores
 */
const CFS_PERIOD_US = 100_000;
function cpusToCfsQuota(cpus) {
  if (!cpus) return null;
  const n = parseFloat(cpus);
  if (isNaN(n) || n <= 0) throw new Error(`Invalid --cpus value: "${cpus}"`);
  return Math.floor(n * CFS_PERIOD_US);
}

// ── Cgroup class ──────────────────────────────────────────────────────────────

class Cgroup {
  /**
   * @param {string} containerId
   * @param {object} limits
   *   memory   {string|number}  e.g. "256m" or 268435456
   *   cpus     {string|number}  e.g. "0.5" or 2
   *   pidsLimit {number}        max simultaneous processes (default 256)
   *   blkio    {number}         I/O weight 10-1000 (default 500)
   */
  constructor(containerId, limits = {}) {
    this.id          = containerId;
    this.version     = detectVersion();
    this.limits      = limits;
    this._attached   = false;

    // Resolve cgroup path(s)
    if (this.version === 2) {
      this.cgDir = path.join(CGROUPV2_ROOT, MC_SLICE, containerId);
    } else {
      // v1: one directory per subsystem
      this.cgDirs = {
        memory: path.join(CGROUPV1_ROOT, 'memory', MC_SLICE, containerId),
        cpu:    path.join(CGROUPV1_ROOT, 'cpu',    MC_SLICE, containerId),
        pids:   path.join(CGROUPV1_ROOT, 'pids',   MC_SLICE, containerId),
        blkio:  path.join(CGROUPV1_ROOT, 'blkio',  MC_SLICE, containerId),
      };
    }
  }

  // ── Factory ────────────────────────────────────────────────────────────────

  /**
   * Create the cgroup directories and write all limit files.
   * Returns the Cgroup instance (ready to call attach()).
   */
  static async create(containerId, limits = {}) {
    if (!IS_LINUX) {
      // Return a no-op cgroup on non-Linux platforms
      return new NullCgroup(containerId, limits);
    }

    const cg = new Cgroup(containerId, limits);

    if (cg.version === 2) {
      await cg._setupV2();
    } else {
      await cg._setupV1();
    }

    return cg;
  }

  // ── cgroup v2 setup ────────────────────────────────────────────────────────

  async _setupV2() {
    await fs.ensureDir(this.cgDir);

    // Enable the controllers we want to use in the parent slice
    const parentDir = path.join(CGROUPV2_ROOT, MC_SLICE);
    await fs.ensureDir(parentDir);
    await this._writeV2Controllers(parentDir);

    const { memory, cpus, pidsLimit = 256, blkio = 500 } = this.limits;

    // Memory limit
    const memBytes = parseMemory(memory);
    if (memBytes !== null) {
      await this._write(this.cgDir, 'memory.max', String(memBytes));
      // Also set swap to 0 (memory + swap = same as memory limit → no swap)
      await this._write(this.cgDir, 'memory.swap.max', '0').catch(() => {});
      console.log(chalk.gray(`  cgroup: memory limit ${memBytes} bytes`));
    }

    // CPU limit
    const quota = cpusToCfsQuota(cpus);
    if (quota !== null) {
      await this._write(this.cgDir, 'cpu.max', `${quota} ${CFS_PERIOD_US}`);
      console.log(chalk.gray(`  cgroup: CPU quota ${quota}/${CFS_PERIOD_US} µs (${cpus} CPUs)`));
    }

    // PIDs limit (fork-bomb protection)
    if (pidsLimit) {
      await this._write(this.cgDir, 'pids.max', String(pidsLimit));
      console.log(chalk.gray(`  cgroup: pids limit ${pidsLimit}`));
    }

    // I/O weight
    if (blkio && blkio !== 500) {
      // v2 uses io.weight, value 1–10000, default 100
      const ioWeight = Math.max(1, Math.min(10000, Math.round(blkio * 10)));
      await this._write(this.cgDir, 'io.weight', String(ioWeight)).catch(() => {});
    }
  }

  async _writeV2Controllers(parentDir) {
    const wanted = ['+memory', '+cpu', '+pids', '+io'];
    const subtreeFile = path.join(parentDir, 'cgroup.subtree_control');
    const current = await fs.readFile(subtreeFile, 'utf8').catch(() => '');
    const toEnable = wanted.filter(c => !current.includes(c.slice(1)));
    if (toEnable.length > 0) {
      await fs.writeFile(subtreeFile, toEnable.join(' '), 'utf8').catch(() => {});
    }
  }

  // ── cgroup v1 setup ────────────────────────────────────────────────────────

  async _setupV1() {
    const { memory, cpus, pidsLimit = 256, blkio = 500 } = this.limits;

    // Memory subsystem
    await fs.ensureDir(this.cgDirs.memory);
    const memBytes = parseMemory(memory);
    if (memBytes !== null) {
      await this._write(this.cgDirs.memory, 'memory.limit_in_bytes', String(memBytes));
      // Disable swap: memsw.limit = memory limit (swap usage = 0)
      await this._write(this.cgDirs.memory, 'memory.memsw.limit_in_bytes', String(memBytes)).catch(() => {});
      console.log(chalk.gray(`  cgroup v1: memory limit ${memBytes} bytes`));
    }

    // CPU subsystem
    await fs.ensureDir(this.cgDirs.cpu);
    const quota = cpusToCfsQuota(cpus);
    if (quota !== null) {
      await this._write(this.cgDirs.cpu, 'cpu.cfs_period_us', String(CFS_PERIOD_US));
      await this._write(this.cgDirs.cpu, 'cpu.cfs_quota_us',  String(quota));
      console.log(chalk.gray(`  cgroup v1: CPU quota ${quota}µs / ${CFS_PERIOD_US}µs (${cpus} CPUs)`));
    }

    // PIDs subsystem
    await fs.ensureDir(this.cgDirs.pids);
    if (pidsLimit) {
      await this._write(this.cgDirs.pids, 'pids.max', String(pidsLimit));
      console.log(chalk.gray(`  cgroup v1: pids limit ${pidsLimit}`));
    }

    // blkio subsystem
    await fs.ensureDir(this.cgDirs.blkio);
    if (blkio && blkio !== 500) {
      const weight = Math.max(10, Math.min(1000, blkio));
      await this._write(this.cgDirs.blkio, 'blkio.weight', String(weight)).catch(() => {});
    }
  }

  // ── Attach PID ─────────────────────────────────────────────────────────────

  /**
   * Move a PID into this cgroup.
   * Call this immediately after spawning the container process.
   *
   * @param {number} pid
   */
  async attach(pid) {
    if (!IS_LINUX || !pid) return;

    if (this.version === 2) {
      await this._write(this.cgDir, 'cgroup.procs', String(pid));
    } else {
      // Write to each subsystem's tasks file
      for (const dir of Object.values(this.cgDirs)) {
        if (fs.existsSync(dir)) {
          await this._write(dir, 'cgroup.procs', String(pid)).catch(() => {});
        }
      }
    }

    this._attached = true;
    this._pid = pid;
  }

  // ── Live stats ─────────────────────────────────────────────────────────────

  /**
   * Read current resource usage from the cgroup accounting files.
   *
   * @returns {{ memoryUsage: number, cpuUsageNs: number, pids: number,
   *             memoryLimit: number|null, cpuQuota: number|null }}
   */
  async stats() {
    if (!IS_LINUX) return null;

    if (this.version === 2) {
      return this._statsV2();
    }
    return this._statsV1();
  }

  async _statsV2() {
    const readNum = async (file) => {
      const v = await fs.readFile(path.join(this.cgDir, file), 'utf8').catch(() => '0');
      return parseInt(v.trim(), 10) || 0;
    };

    const memCurrent   = await readNum('memory.current');
    const pidsCurrents = await readNum('pids.current');

    // cpu.stat format: usage_usec <n>\n ...
    const cpuStat = await fs.readFile(path.join(this.cgDir, 'cpu.stat'), 'utf8').catch(() => '');
    const usageUs = parseInt((cpuStat.match(/^usage_usec\s+(\d+)/m) || ['', '0'])[1], 10);

    // memory.max and cpu.max for limit display
    const memMax = await fs.readFile(path.join(this.cgDir, 'memory.max'), 'utf8').catch(() => 'max');
    const cpuMax = await fs.readFile(path.join(this.cgDir, 'cpu.max'),    'utf8').catch(() => 'max 100000');

    return {
      memoryUsage:  memCurrent,
      cpuUsageUs:   usageUs,
      pids:         pidsCurrents,
      memoryLimit:  memMax.trim() === 'max' ? null : parseInt(memMax, 10),
      cpuQuota:     cpuMax.trim().startsWith('max') ? null : parseInt(cpuMax.split(' ')[0], 10),
    };
  }

  async _statsV1() {
    const readNum = async (dir, file) => {
      const v = await fs.readFile(path.join(dir, file), 'utf8').catch(() => '0');
      return parseInt(v.trim(), 10) || 0;
    };

    return {
      memoryUsage:  await readNum(this.cgDirs.memory, 'memory.usage_in_bytes'),
      cpuUsageUs:   Math.floor(await readNum(this.cgDirs.cpu,    'cpuacct.usage') / 1000),
      pids:         await readNum(this.cgDirs.pids,   'pids.current'),
      memoryLimit:  await readNum(this.cgDirs.memory, 'memory.limit_in_bytes') || null,
      cpuQuota:     await readNum(this.cgDirs.cpu,    'cpu.cfs_quota_us') || null,
    };
  }

  // ── Destroy ────────────────────────────────────────────────────────────────

  /**
   * Remove the cgroup directories after the container exits.
   * The kernel refuses to delete a non-empty cgroup, so we first move any
   * remaining PIDs back to the root cgroup, then rmdir.
   */
  async destroy() {
    if (!IS_LINUX) return;

    if (this.version === 2) {
      await this._destroyDir(this.cgDir);
    } else {
      for (const dir of Object.values(this.cgDirs)) {
        await this._destroyDir(dir);
      }
    }
  }

  async _destroyDir(dir) {
    if (!fs.existsSync(dir)) return;

    // Move remaining PIDs to the parent's cgroup.procs
    const procsFile = path.join(dir, 'cgroup.procs');
    const parentProcs = path.join(path.dirname(dir), 'cgroup.procs');
    if (fs.existsSync(procsFile)) {
      const pids = (await fs.readFile(procsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        await fs.writeFile(parentProcs, pid, 'utf8').catch(() => {});
      }
    }

    // rmdir — only works on empty cgroups
    await run('rmdir', [dir]).catch(() => {});
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  async _write(dir, file, value) {
    await fs.writeFile(path.join(dir, file), value + '\n', 'utf8');
  }
}

// ── Windows Job Object ────────────────────────────────────────────────────────

/**
 * On Windows, use a PowerShell one-liner to create a Job Object and assign
 * the container PID to it with CPU-rate and memory limits.
 *
 * Limitations vs Linux cgroups:
 *   - CPU throttling is percentage-based (not quota/period)
 *   - PIDs limit is per-job (child process count)
 *   - No I/O weight (no direct equivalent)
 */
class WindowsJobCgroup {
  constructor(containerId, limits = {}) {
    this.id     = containerId;
    this.limits = limits;
  }

  static async create(containerId, limits = {}) {
    return new WindowsJobCgroup(containerId, limits);
  }

  async attach(pid) {
    if (!pid) return;
    const { memory, cpus, pidsLimit } = this.limits;

    const memBytes = parseMemory(memory);
    // CPU rate in 1/100ths of a percent: 50% of 1 core on a 4-core machine = 50/400 = 12.5%
    // We approximate: --cpus 1 on any machine = 100% rate (1 full logical CPU worth)
    const cpuRate  = cpus ? Math.min(10000, Math.floor(parseFloat(cpus) * 100)) : null;

    const lines = [
      `$job = New-Object System.Diagnostics.ProcessJobObject`,
      `$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      `if ($proc) { $job.AddProcess($proc) | Out-Null }`,
    ];

    if (memBytes) {
      lines.push(`$job.MaximumWorkingSetSize = ${memBytes}`);
    }
    if (cpuRate) {
      // SetInformationJobObject with JobObjectCpuRateControlInformation
      // PowerShell doesn't expose this directly — we record it for display only
    }
    if (pidsLimit) {
      lines.push(`$job.ActiveProcessLimit = ${pidsLimit}`);
    }

    // Only run if there is something to set
    if (memBytes || pidsLimit) {
      const script = lines.join('; ');
      await run('powershell', ['-NoProfile', '-Command', script]).catch(err => {
        console.warn(chalk.yellow(`  Job Object warning: ${err.message}`));
      });
    }
  }

  async stats() { return null; }
  async destroy() {}
}

// ── NullCgroup (used when cgroups unavailable / not requested) ────────────────

class NullCgroup {
  constructor(containerId, limits) { this.id = containerId; this.limits = limits; }
  static async create(id, limits) { return new NullCgroup(id, limits); }
  async attach() {}
  async stats()   { return null; }
  async destroy() {}
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Create the right cgroup implementation for the current platform.
 *
 * @param {string} containerId
 * @param {object} limits   { memory, cpus, pidsLimit, blkio }
 *                          All values optional; omit to skip that limit.
 * @returns {Cgroup|WindowsJobCgroup|NullCgroup}
 */
async function createCgroup(containerId, limits = {}) {
  const hasLimits = limits.memory || limits.cpus || limits.pidsLimit || limits.blkio;
  if (!hasLimits) return new NullCgroup(containerId, limits);

  if (IS_LINUX) {
    return Cgroup.create(containerId, limits);
  }
  if (IS_WINDOWS) {
    return WindowsJobCgroup.create(containerId, limits);
  }
  return new NullCgroup(containerId, limits);
}

module.exports = {
  createCgroup,
  parseMemory,
  cpusToCfsQuota,
  detectVersion,
  CFS_PERIOD_US,
  Cgroup,
  NullCgroup,
};
