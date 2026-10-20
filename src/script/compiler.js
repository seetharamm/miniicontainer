'use strict';
/**
 * Script compiler — parses a minicontainer script file (YAML or JSON) and
 * transpiles it into:
 *
 *   1. A Containerfile (for the `build:` block)
 *   2. An ordered pipeline plan (for `pipelines:` blocks)
 *
 * ── Script DSL (mdc.yaml) ─────────────────────────────────────────────────────
 *
 * name: myapp            # required
 * version: "1.0"         # optional
 *
 * vars:                  # variable map — substituted everywhere as ${VAR} / $VAR
 *   PORT: "8080"
 *   NODE_VERSION: "20"
 *
 * build:                 # generates a Containerfile
 *   from: node:${NODE_VERSION}
 *   args:                # ARG instructions
 *     - BUILD_ENV=production
 *   env:                 # ENV instructions (key: value map or array)
 *     NODE_ENV: production
 *   run:                 # RUN instructions (array of shell commands)
 *     - npm ci
 *     - npm run build
 *   copy:                # COPY instructions (array of {src, dst} or "src dst" string)
 *     - src: ./dist
 *       dst: /app/dist
 *     - "./config /app/config"
 *   workdir: /app        # WORKDIR
 *   expose: ["${PORT}"]  # EXPOSE ports
 *   labels:              # LABEL key: value map
 *     maintainer: "team"
 *   user: node           # USER
 *   cmd: ["node", "server.js"]       # CMD
 *   entrypoint: []       # ENTRYPOINT
 *   healthcheck:         # HEALTHCHECK (informational)
 *     cmd: curl -f http://localhost:${PORT}/health
 *     interval: 30s
 *     timeout: 5s
 *     retries: 3
 *   multi_stage:         # optional array of additional stages before the main one
 *     - name: deps
 *       from: node:${NODE_VERSION}-alpine
 *       run: ["npm ci --only=prod"]
 *       copy_from: []    # COPY --from=deps
 *
 * pipelines:             # named pipelines of steps
 *   deploy:
 *     - build: .                         # build context (. = cwd)
 *       tag: myapp:latest
 *       file: Containerfile              # optional dockerfile override
 *     - pull: nginx:latest               # pull step
 *     - run: myapp:latest                # run container
 *       name: myapp-prod
 *       port: ["${PORT}:${PORT}"]
 *       env: [APP_ENV=production]
 *       volume: []
 *       detach: true
 *       rm: false
 *       memory: 256m
 *       cpus: "0.5"
 *     - stop: myapp-old                  # stop container
 *     - rm: myapp-old                    # remove container
 *     - exec: myapp-prod                 # exec in container
 *       cmd: ["node", "-e", "console.log('ok')"]
 *     - shell: "echo done"               # run a host shell command
 *     - sleep: 2                         # pause N seconds
 *     - echo: "Deployment complete"      # print a message
 *
 * ── Output: CompiledScript ────────────────────────────────────────────────────
 *
 * {
 *   name, version, vars,
 *   containerfile: "<generated Containerfile text>",
 *   pipelines: { <name>: [ ...StepPlan ] }
 * }
 *
 * StepPlan has { type, ...params } with everything variable-substituted.
 */

'use strict';

const path = require('path');
const fs   = require('fs-extra');
const yaml = require('js-yaml');

// ── Variable substitution ─────────────────────────────────────────────────────

/**
 * Substitute `${VAR}` and `$VAR` patterns in a string.
 * @param {string} str
 * @param {object} vars  { KEY: value }
 * @returns {string}
 */
function subst(str, vars) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\$\{([^}]+)\}/g, (_, k) => k in vars ? vars[k] : `\${${k}}`)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => k in vars ? vars[k] : `$${k}`);
}

/**
 * Recursively substitute variables in any value (string, array, object).
 */
function substDeep(value, vars) {
  if (typeof value === 'string') return subst(value, vars);
  if (Array.isArray(value))      return value.map(v => substDeep(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substDeep(v, vars);
    return out;
  }
  return value;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Load and parse a script file (.yaml / .yml / .json).
 * Returns the raw parsed object — no substitution yet.
 */
function loadScriptFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Script file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  let doc;
  if (ext === '.json') {
    try { doc = JSON.parse(raw); }
    catch (err) { throw new Error(`JSON parse error in ${filePath}: ${err.message}`); }
  } else {
    try { doc = yaml.load(raw); }
    catch (err) { throw new Error(`YAML parse error in ${filePath}: ${err.message}`); }
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error(`Script file ${filePath} must be a YAML/JSON object at the top level`);
  }
  return doc;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate the structure of a parsed script doc.
 * Returns an array of error strings (empty = valid).
 */
function validateScript(doc) {
  const errors = [];

  if (!doc.name || typeof doc.name !== 'string') {
    errors.push('`name` is required and must be a string');
  }

  if (doc.vars !== undefined && typeof doc.vars !== 'object') {
    errors.push('`vars` must be an object (key-value map)');
  }

  if (doc.build !== undefined) {
    if (typeof doc.build !== 'object') {
      errors.push('`build` must be an object');
    } else {
      if (!doc.build.from && !(doc.build.multi_stage?.length)) {
        errors.push('`build.from` is required (or provide `build.multi_stage`)');
      }
      if (doc.build.run !== undefined && !Array.isArray(doc.build.run)) {
        errors.push('`build.run` must be an array');
      }
      if (doc.build.copy !== undefined && !Array.isArray(doc.build.copy)) {
        errors.push('`build.copy` must be an array');
      }
      if (doc.build.expose !== undefined && !Array.isArray(doc.build.expose)) {
        errors.push('`build.expose` must be an array');
      }
    }
  }

  if (doc.pipelines !== undefined) {
    if (typeof doc.pipelines !== 'object') {
      errors.push('`pipelines` must be an object');
    } else {
      for (const [name, steps] of Object.entries(doc.pipelines)) {
        if (!Array.isArray(steps)) {
          errors.push(`pipeline '${name}' must be an array of steps`);
          continue;
        }
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (!step || typeof step !== 'object') {
            errors.push(`pipeline '${name}' step ${i + 1} must be an object`);
            continue;
          }
          const knownTypes = ['build','pull','run','stop','rm','exec','shell','sleep','echo','tag','push','wait'];
          const type = knownTypes.find(t => t in step);
          if (!type) {
            errors.push(`pipeline '${name}' step ${i + 1}: unknown step type. Must have one of: ${knownTypes.join(', ')}`);
          }
        }
      }
    }
  }

  return errors;
}

// ── Containerfile generation ──────────────────────────────────────────────────

/**
 * Emit a COPY instruction line.
 */
function copySrcDst(c, vars) {
  if (typeof c === 'string') {
    return `COPY ${subst(c, vars)}`;
  }
  const src = subst(c.src || c.source || '', vars);
  const dst = subst(c.dst || c.dest || c.target || '', vars);
  const fromFlag = c.from ? `--from=${subst(c.from, vars)} ` : '';
  return `COPY ${fromFlag}${src} ${dst}`;
}

/**
 * Generate a Containerfile string from the `build:` block.
 * Variable substitution is applied at generation time.
 *
 * @param {object} buildBlock  The `build:` section of the script
 * @param {object} vars        Resolved variables map
 * @returns {string}           Complete Containerfile text
 */
function generateContainerfile(buildBlock, vars) {
  const lines = [];

  // ── Multi-stage preamble ───────────────────────────────────────────────────
  for (const stage of (buildBlock.multi_stage || [])) {
    lines.push(`FROM ${subst(stage.from, vars)} AS ${subst(stage.name || 'builder', vars)}`);

    for (const a of (stage.args || [])) lines.push(`ARG ${subst(a, vars)}`);

    const stageEnv = stage.env || {};
    if (Array.isArray(stageEnv)) {
      for (const e of stageEnv) lines.push(`ENV ${subst(e, vars)}`);
    } else {
      for (const [k, v] of Object.entries(stageEnv)) lines.push(`ENV ${k}=${subst(String(v), vars)}`);
    }

    if (stage.workdir) lines.push(`WORKDIR ${subst(stage.workdir, vars)}`);
    for (const r of (stage.run   || [])) lines.push(`RUN ${subst(r, vars)}`);
    for (const c of (stage.copy  || [])) lines.push(copySrcDst(c, vars));
    lines.push('');
  }

  // ── Main stage ────────────────────────────────────────────────────────────
  const fromImage = subst(buildBlock.from || 'scratch', vars);
  lines.push(`FROM ${fromImage}`);

  // ARG
  for (const a of (buildBlock.args || [])) lines.push(`ARG ${subst(a, vars)}`);

  // ENV
  const envBlock = buildBlock.env || [];
  if (Array.isArray(envBlock)) {
    for (const e of envBlock) lines.push(`ENV ${subst(e, vars)}`);
  } else {
    for (const [k, v] of Object.entries(envBlock)) lines.push(`ENV ${k}=${subst(String(v), vars)}`);
  }

  // LABEL
  const labels = buildBlock.labels || {};
  for (const [k, v] of Object.entries(labels)) {
    lines.push(`LABEL ${k}="${subst(String(v), vars)}"`);
  }

  // WORKDIR
  if (buildBlock.workdir) lines.push(`WORKDIR ${subst(buildBlock.workdir, vars)}`);

  // COPY
  for (const c of (buildBlock.copy || [])) lines.push(copySrcDst(c, vars));

  // RUN
  for (const r of (buildBlock.run || [])) lines.push(`RUN ${subst(r, vars)}`);

  // EXPOSE
  for (const p of (buildBlock.expose || [])) lines.push(`EXPOSE ${subst(String(p), vars)}`);

  // USER
  if (buildBlock.user) lines.push(`USER ${subst(buildBlock.user, vars)}`);

  // HEALTHCHECK
  if (buildBlock.healthcheck) {
    const hc = buildBlock.healthcheck;
    const parts = ['HEALTHCHECK'];
    if (hc.interval) parts.push(`--interval=${subst(hc.interval, vars)}`);
    if (hc.timeout)  parts.push(`--timeout=${subst(hc.timeout, vars)}`);
    if (hc.retries)  parts.push(`--retries=${hc.retries}`);
    if (hc.cmd)      parts.push(`CMD ${subst(hc.cmd, vars)}`);
    lines.push(parts.join(' '));
  }

  // ENTRYPOINT
  if (buildBlock.entrypoint?.length) {
    const ep = buildBlock.entrypoint.map(v => `"${subst(v, vars)}"`);
    lines.push(`ENTRYPOINT [${ep.join(', ')}]`);
  }

  // CMD
  if (buildBlock.cmd?.length) {
    const cmd = buildBlock.cmd.map(v => `"${subst(v, vars)}"`);
    lines.push(`CMD [${cmd.join(', ')}]`);
  }

  return lines.join('\n') + '\n';
}

// ── Pipeline plan compilation ─────────────────────────────────────────────────

/**
 * Compile one step object into a normalised StepPlan.
 * Variable substitution is applied to all string values.
 *
 * @param {object} step   Raw step from the script
 * @param {object} vars   Resolved variables
 * @param {number} index  Step index (for error messages)
 * @param {string} pipelineName
 * @returns {object}      StepPlan
 */
function compileStep(step, vars, index, pipelineName) {
  const s = substDeep(step, vars);
  const label = `pipeline '${pipelineName}' step ${index + 1}`;

  if ('build' in s) {
    return {
      type:    'build',
      context: s.build || '.',
      tag:     s.tag   || null,
      file:    s.file  || null,
    };
  }
  if ('pull' in s) {
    return { type: 'pull', image: s.pull, platform: s.platform || null };
  }
  if ('run' in s) {
    return {
      type:      'run',
      image:     s.run,
      name:      s.name      || null,
      cmd:       normCmd(s.cmd),
      env:       normArr(s.env),
      port:      normArr(s.port),
      volume:    normArr(s.volume),
      detach:    !!s.detach,
      rm:        !!s.rm,
      memory:    s.memory    || null,
      cpus:      s.cpus      != null ? String(s.cpus) : null,
      pidsLimit: s.pids_limit != null ? parseInt(s.pids_limit, 10) : null,
      workingDir:s.working_dir || null,
    };
  }
  if ('stop' in s) {
    return { type: 'stop', container: normArr(s.stop), timeout: s.timeout || 10 };
  }
  if ('rm' in s) {
    return { type: 'rm', container: normArr(s.rm), force: !!s.force };
  }
  if ('exec' in s) {
    return {
      type:      'exec',
      container: s.exec,
      cmd:       normCmd(s.cmd),
      tty:       !!s.tty,
      interactive: !!s.interactive,
    };
  }
  if ('shell' in s) {
    return { type: 'shell', command: s.shell };
  }
  if ('sleep' in s) {
    return { type: 'sleep', seconds: Number(s.sleep) || 1 };
  }
  if ('echo' in s) {
    return { type: 'echo', message: String(s.echo) };
  }
  if ('tag' in s) {
    return { type: 'tag', source: s.tag, target: s.as || s.target };
  }
  if ('push' in s) {
    return { type: 'push', image: s.push };
  }
  if ('wait' in s) {
    return { type: 'wait', container: normArr(s.wait) };
  }

  throw new Error(`${label}: unknown step type`);
}

function normCmd(cmd) {
  if (!cmd) return [];
  if (typeof cmd === 'string') return cmd.split(/\s+/).filter(Boolean);
  return Array.isArray(cmd) ? cmd.map(String) : [String(cmd)];
}

function normArr(v) {
  if (!v) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

// ── Main compile entry point ──────────────────────────────────────────────────

/**
 * Compile a script file into a CompiledScript.
 *
 * @param {string} filePath  Absolute or relative path to the script file
 * @param {object} overrideVars  Additional vars that override `vars:` in the file
 * @returns {CompiledScript}
 *
 * @typedef {object} CompiledScript
 * @property {string}  name
 * @property {string}  version
 * @property {object}  vars            Resolved variables map
 * @property {string|null} containerfile  Generated Containerfile text (if `build:` present)
 * @property {object}  pipelines       { <name>: StepPlan[] }
 * @property {string}  sourceFile      Absolute path to the source file
 * @property {number}  compiledAt      epoch-ms timestamp
 */
function compile(filePath, overrideVars = {}) {
  const absPath = path.resolve(filePath);
  const doc     = loadScriptFile(absPath);

  // Merge vars: built-in → file vars → override
  const vars = {
    ...{ SCRIPT_DIR: path.dirname(absPath), SCRIPT_NAME: path.basename(absPath) },
    ...flattenVars(doc.vars || {}),
    ...overrideVars,
  };

  // Validate (throws on hard errors, reports soft errors)
  const errors = validateScript(doc);
  if (errors.length) {
    throw new Error(`Script validation failed:\n  ${errors.join('\n  ')}`);
  }

  // Generate Containerfile
  const containerfile = doc.build
    ? generateContainerfile(substDeep(doc.build, vars), vars)
    : null;

  // Compile pipelines
  const pipelines = {};
  for (const [name, steps] of Object.entries(doc.pipelines || {})) {
    pipelines[name] = steps.map((step, i) => compileStep(step, vars, i, name));
  }

  return {
    name:          subst(doc.name, vars),
    version:       subst(String(doc.version || '1.0'), vars),
    vars,
    containerfile,
    pipelines,
    sourceFile:    absPath,
    compiledAt:    Date.now(),
  };
}

/**
 * Flatten a vars object: values are coerced to strings.
 */
function flattenVars(varsObj) {
  const out = {};
  for (const [k, v] of Object.entries(varsObj)) {
    out[k] = v != null ? String(v) : '';
  }
  return out;
}

module.exports = {
  compile,
  loadScriptFile,
  validateScript,
  generateContainerfile,
  compileStep,
  subst,
  substDeep,
  flattenVars,
  normCmd,
  normArr,
};
