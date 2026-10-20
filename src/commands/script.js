'use strict';
/**
 * mydocker script — automated script compiler + runner
 *
 * Subcommands:
 *   run      <file> [pipeline]   Compile and execute a pipeline
 *   compile  <file>              Parse + compile only (prints result)
 *   validate <file>              Check the script for errors
 *   watch    <file> [pipeline]   Compile + run on every file change
 *   list     <file>              List all pipelines in a script
 *   emit     <file>              Print the generated Containerfile to stdout
 *
 * Options:
 *   --dry-run            Compile + print steps, do not execute
 *   --var KEY=VALUE      Override a script variable (repeatable)
 *   --format json        Output validation/compile result as JSON
 *   --debounce <ms>      Watch debounce delay (default: 300)
 */

'use strict';

const path    = require('path');
const fs      = require('fs-extra');
const chalk   = require('chalk');
const { compile, validateScript, loadScriptFile } = require('../script/compiler');
const { runPipeline } = require('../script/runner');
const { ScriptWatcher } = require('../script/watcher');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse --var KEY=VALUE flags into an object.
 */
function parseVarFlags(varArr) {
  const out = {};
  for (const v of (Array.isArray(varArr) ? varArr : [])) {
    const eq = v.indexOf('=');
    if (eq === -1) throw new Error(`Invalid --var format: "${v}" (expected KEY=VALUE)`);
    out[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return out;
}

/**
 * Resolve the script file path — accepts explicit path or searches for
 * mdc.yaml / mdc.yml / mdc.json in the current directory.
 */
function resolveScriptFile(filePath) {
  if (filePath) return path.resolve(filePath);

  for (const name of ['mdc.yaml', 'mdc.yml', 'mdc.json', 'minicontainer.yaml', 'minicontainer.yml']) {
    const p = path.join(process.cwd(), name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'No script file specified and none found in current directory.\n' +
    'Create mdc.yaml or pass a path: mydocker script run <file>'
  );
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function scriptRun(filePath, pipelineArg, opts) {
  const overrideVars = parseVarFlags(opts.var);
  const file         = resolveScriptFile(filePath);

  let compiled;
  try {
    compiled = compile(file, overrideVars);
  } catch (err) {
    console.error(chalk.red(`Compile error: ${err.message}`));
    process.exit(1);
  }

  const pipelines = Object.keys(compiled.pipelines);
  if (!pipelines.length) {
    console.error(chalk.yellow('Script has no pipelines defined.'));
    process.exit(0);
  }

  // If no pipeline specified and there's only one, use it
  const pipelineName = pipelineArg
    || (pipelines.length === 1 ? pipelines[0] : null);

  if (!pipelineName) {
    console.error(chalk.red('Multiple pipelines defined — specify one:'));
    pipelines.forEach(p => console.error(`  ${p}`));
    process.exit(1);
  }

  const result = await runPipeline(pipelineName, compiled, {
    dryRun:   !!opts.dryRun,
    failFast: true,
  });

  process.exit(result.success ? 0 : 1);
}

function scriptCompile(filePath, opts) {
  const overrideVars = parseVarFlags(opts.var);
  const file         = resolveScriptFile(filePath);

  let compiled;
  try {
    compiled = compile(file, overrideVars);
  } catch (err) {
    console.error(chalk.red(`Compile error: ${err.message}`));
    process.exit(1);
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(compiled, null, 2));
    return;
  }

  console.log(chalk.bold(`Script: ${compiled.name}  v${compiled.version}`));
  console.log(chalk.gray(`Source: ${compiled.sourceFile}`));
  console.log(chalk.gray(`Compiled at: ${new Date(compiled.compiledAt).toISOString()}`));
  console.log();

  if (compiled.containerfile) {
    console.log(chalk.cyan('── Generated Containerfile ──────────────────────────────────'));
    console.log(compiled.containerfile);
  }

  const pipelineNames = Object.keys(compiled.pipelines);
  if (pipelineNames.length) {
    console.log(chalk.cyan('── Pipelines ────────────────────────────────────────────────'));
    for (const name of pipelineNames) {
      const steps = compiled.pipelines[name];
      console.log(chalk.bold(`  ${name}`) + chalk.gray(` (${steps.length} step${steps.length !== 1 ? 's' : ''})`));
      steps.forEach((s, i) => {
        const { describeStep } = require('../script/runner');
        console.log(chalk.gray(`    ${i + 1}. ${s.type.padEnd(8)} ${describeStep(s)}`));
      });
    }
  }

  if (Object.keys(compiled.vars).length) {
    console.log(chalk.cyan('\n── Variables ────────────────────────────────────────────────'));
    for (const [k, v] of Object.entries(compiled.vars)) {
      // Don't print built-in SCRIPT_DIR etc. unless explicitly set
      if (k.startsWith('SCRIPT_')) continue;
      console.log(chalk.gray(`  ${k} = ${v}`));
    }
  }
}

function scriptValidate(filePath, opts) {
  const file = resolveScriptFile(filePath);
  let doc;
  try {
    doc = loadScriptFile(file);
  } catch (err) {
    if (opts.format === 'json') {
      console.log(JSON.stringify({ valid: false, errors: [err.message] }, null, 2));
    } else {
      console.error(chalk.red(`Parse error: ${err.message}`));
    }
    process.exit(1);
  }

  const errors = validateScript(doc);

  if (opts.format === 'json') {
    console.log(JSON.stringify({ valid: errors.length === 0, errors }, null, 2));
    return;
  }

  if (errors.length === 0) {
    console.log(chalk.green(`✓ ${path.basename(file)} is valid`));
  } else {
    console.error(chalk.red(`✗ ${path.basename(file)} has ${errors.length} error(s):`));
    errors.forEach(e => console.error(chalk.red(`  • ${e}`)));
    process.exit(1);
  }
}

async function scriptWatch(filePath, pipelineArg, opts) {
  const overrideVars = parseVarFlags(opts.var);
  const file         = resolveScriptFile(filePath);
  const debounceMs   = parseInt(opts.debounce || '300', 10);

  const watcher = new ScriptWatcher(file, {
    pipeline:     pipelineArg  || null,
    dryRun:       !!opts.dryRun,
    debounceMs,
    overrideVars,
  });

  await watcher.start();

  // Keep alive until Ctrl+C
  process.on('SIGINT',  () => { watcher.stop(); process.exit(0); });
  process.on('SIGTERM', () => { watcher.stop(); process.exit(0); });

  // Prevent Node from exiting while we're watching
  setInterval(() => {}, 60_000);
}

function scriptList(filePath, opts) {
  const file = resolveScriptFile(filePath);
  let compiled;
  try {
    compiled = compile(file);
  } catch (err) {
    console.error(chalk.red(`Compile error: ${err.message}`));
    process.exit(1);
  }

  const pipelines = Object.keys(compiled.pipelines);

  if (opts.format === 'json') {
    console.log(JSON.stringify({ name: compiled.name, pipelines }, null, 2));
    return;
  }

  console.log(chalk.bold(`${compiled.name}`) + chalk.gray(` — ${pipelines.length} pipeline(s)`));
  for (const name of pipelines) {
    const steps = compiled.pipelines[name];
    console.log(`  ${chalk.cyan(name)}  (${steps.length} step${steps.length !== 1 ? 's' : ''})`);
  }
}

function scriptEmit(filePath) {
  const file = resolveScriptFile(filePath);
  let compiled;
  try {
    compiled = compile(file);
  } catch (err) {
    console.error(chalk.red(`Compile error: ${err.message}`));
    process.exit(1);
  }

  if (!compiled.containerfile) {
    console.error(chalk.yellow('Script has no build: block — nothing to emit.'));
    process.exit(1);
  }

  process.stdout.write(compiled.containerfile);
}

// ── Main command handler ──────────────────────────────────────────────────────

async function scriptCommand(subcommand, args, opts) {
  const [fileArg, pipelineArg] = args;

  switch (subcommand) {
    case 'run':
      await scriptRun(fileArg, pipelineArg, opts);
      break;

    case 'compile':
    case 'build':
      scriptCompile(fileArg, opts);
      break;

    case 'validate':
    case 'lint':
      scriptValidate(fileArg, opts);
      break;

    case 'watch':
      await scriptWatch(fileArg, pipelineArg, opts);
      break;

    case 'list':
    case 'ls':
      scriptList(fileArg, opts);
      break;

    case 'emit':
    case 'containerfile':
      scriptEmit(fileArg);
      break;

    default:
      console.error(`Unknown script subcommand: ${subcommand}`);
      console.error('Available: run, compile, validate, watch, list, emit');
      process.exit(1);
  }
}

module.exports = scriptCommand;
module.exports.parseVarFlags    = parseVarFlags;
module.exports.resolveScriptFile = resolveScriptFile;
module.exports.scriptCompile    = scriptCompile;
module.exports.scriptValidate   = scriptValidate;
module.exports.scriptList       = scriptList;
module.exports.scriptEmit       = scriptEmit;
