'use strict';
/**
 * Script pipeline runner — executes a compiled pipeline plan against the
 * container runtime.
 *
 * Each step type maps to one or more runtime operations:
 *
 *   build   → buildImage()         (src/image/builder.js)
 *   pull    → pullImage()          (src/image/puller.js)
 *   run     → runContainer()       (src/core/runtime.js)
 *   stop    → stopContainer()      (src/core/runtime.js)
 *   rm      → removeContainer()    (src/commands/rm.js)
 *   exec    → execInContainer()    (src/core/runtime.js)
 *   shell   → child_process.exec   (host shell command)
 *   sleep   → setTimeout
 *   echo    → console.log
 *   tag     → store tag alias      (src/commands/tag.js)
 *   push    → pushImage()          (src/commands/push.js)
 *   wait    → wait for containers  (src/commands/wait.js)
 *
 * RunResult:
 * {
 *   pipeline:    string    pipeline name
 *   steps:       StepResult[]
 *   success:     boolean
 *   durationMs:  number
 * }
 *
 * StepResult:
 * {
 *   index:       number
 *   type:        string
 *   success:     boolean
 *   durationMs:  number
 *   error:       string|null
 *   output:      string|null  (for shell steps)
 * }
 */

'use strict';

const path   = require('path');
const chalk  = require('chalk');
const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ── Lazy-loaded runtime modules ───────────────────────────────────────────────
// Lazy requires avoid circular dependency issues and keep startup fast.

function rt() { return require('../core/runtime'); }
function builder() { return require('../image/builder'); }
function puller()  { return require('../image/puller'); }

// ── Step executor map ─────────────────────────────────────────────────────────

const EXECUTORS = {

  async build(step, ctx) {
    const contextDir = path.resolve(ctx.scriptDir, step.context || '.');
    ctx.log(chalk.cyan(`  Building image from ${contextDir}${step.tag ? ` → ${step.tag}` : ''}`));
    const record = await builder().buildImage(contextDir, step.tag);
    // Store built tag in context so subsequent steps can reference it
    if (step.tag) ctx.outputs.lastBuiltImage = step.tag;
    return { output: record.ref };
  },

  async pull(step, ctx) {
    ctx.log(chalk.cyan(`  Pulling ${step.image}`));
    const { pullImage } = puller();
    const record = await pullImage(step.image, {
      platform: step.platform,
      username: process.env.DOCKER_USERNAME,
      password: process.env.DOCKER_PASSWORD,
    });
    ctx.outputs.lastPulledImage = step.image;
    return { output: record.ref };
  },

  async run(step, ctx) {
    const image = step.image || ctx.outputs.lastBuiltImage;
    if (!image) throw new Error('run step: no image specified and no previous build result');
    ctx.log(chalk.cyan(`  Running ${image}${step.name ? ` as ${step.name}` : ''}`));
    const record = await rt().runContainer({
      image,
      name:      step.name,
      cmd:       step.cmd       || [],
      env:       step.env       || [],
      port:      step.port      || [],
      volume:    step.volume    || [],
      detach:    step.detach    != null ? step.detach  : true,
      rm:        !!step.rm,
      memory:    step.memory,
      cpus:      step.cpus,
      pidsLimit: step.pidsLimit,
    });
    ctx.outputs.lastContainer = record.id;
    ctx.outputs.lastContainerName = record.name;
    return { output: record.id };
  },

  async stop(step, ctx) {
    const containers = (step.container?.length ? step.container : [ctx.outputs.lastContainer]).filter(Boolean);
    if (!containers.length) throw new Error('stop step: no container specified');
    for (const c of containers) {
      ctx.log(chalk.yellow(`  Stopping ${c}`));
      await rt().stopContainer(c, step.timeout || 10);
    }
    return { output: containers.join(', ') };
  },

  async rm(step, ctx) {
    const containers = (step.container?.length ? step.container : [ctx.outputs.lastContainer]).filter(Boolean);
    if (!containers.length) throw new Error('rm step: no container specified');
    const rmCmd = require('../commands/rm');
    for (const c of containers) {
      ctx.log(chalk.yellow(`  Removing container ${c}`));
      await rmCmd([c], { force: step.force || false });
    }
    return { output: containers.join(', ') };
  },

  async exec(step, ctx) {
    const container = step.container || ctx.outputs.lastContainer;
    if (!container) throw new Error('exec step: no container specified');
    ctx.log(chalk.cyan(`  Exec in ${container}: ${step.cmd.join(' ')}`));
    await rt().execInContainer(container, step.cmd);
    return { output: null };
  },

  async shell(step, _ctx) {
    const command = step.command;
    if (!command) throw new Error('shell step: no command specified');
    const { stdout, stderr } = await execAsync(command, { timeout: 120_000 });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    return { output: stdout.trim() };
  },

  async sleep(step, ctx) {
    const ms = (step.seconds || 1) * 1000;
    ctx.log(chalk.gray(`  Sleeping ${step.seconds}s...`));
    await new Promise(r => setTimeout(r, ms));
    return { output: null };
  },

  async echo(step, ctx) {
    ctx.log(step.message || '');
    return { output: step.message };
  },

  async tag(step, ctx) {
    const source = step.source || ctx.outputs.lastBuiltImage;
    if (!source) throw new Error('tag step: no source image');
    if (!step.target) throw new Error('tag step: no target tag');
    const tagCmd = require('../commands/tag');
    tagCmd(source, step.target);
    return { output: `${source} → ${step.target}` };
  },

  async push(step, ctx) {
    const image = step.image || ctx.outputs.lastBuiltImage;
    if (!image) throw new Error('push step: no image specified');
    ctx.log(chalk.cyan(`  Pushing ${image}`));
    const pushCmd = require('../commands/push');
    await pushCmd(image, {});
    return { output: image };
  },

  async wait(step, ctx) {
    const containers = (step.container?.length ? step.container : [ctx.outputs.lastContainer]).filter(Boolean);
    if (!containers.length) throw new Error('wait step: no container specified');
    const waitCmd = require('../commands/wait');
    await waitCmd(containers);
    return { output: containers.join(', ') };
  },
};

// ── Pipeline runner ───────────────────────────────────────────────────────────

/**
 * Execute a compiled pipeline.
 *
 * @param {string}        pipelineName  Name of the pipeline to run
 * @param {CompiledScript} compiled     Output of compiler.compile()
 * @param {object}        opts
 *   dryRun      {boolean}  Print steps without executing (default: false)
 *   onStep      {function} Called before each step: onStep(stepPlan, index)
 *   onStepDone  {function} Called after each step:  onStepDone(result, stepPlan, index)
 *   failFast    {boolean}  Abort on first failure (default: true)
 * @returns {RunResult}
 */
async function runPipeline(pipelineName, compiled, opts = {}) {
  const { dryRun = false, onStep, onStepDone, failFast = true } = opts;

  const steps = compiled.pipelines[pipelineName];
  if (!steps) {
    throw new Error(
      `Pipeline '${pipelineName}' not found.\n` +
      `Available: ${Object.keys(compiled.pipelines).join(', ')}`
    );
  }

  console.log(chalk.bold.cyan(`\n▶  Pipeline: ${pipelineName}  (${steps.length} step${steps.length !== 1 ? 's' : ''})\n`));

  // Shared mutable context for the pipeline run
  const ctx = {
    scriptDir: path.dirname(compiled.sourceFile),
    outputs:   {},   // key-value bag for inter-step results
    log:       (msg) => console.log(msg),
  };

  const results = [];
  const pipelineStart = Date.now();
  let success = true;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepLabel = `[${i + 1}/${steps.length}] ${step.type.toUpperCase()}`;

    if (onStep) onStep(step, i);

    console.log(chalk.bold.white(`${stepLabel}`) + chalk.gray(` — ${describeStep(step)}`));

    if (dryRun) {
      const result = { index: i, type: step.type, success: true, durationMs: 0, error: null, output: null, dryRun: true };
      results.push(result);
      if (onStepDone) onStepDone(result, step, i);
      continue;
    }

    const stepStart = Date.now();
    let stepSuccess = true;
    let stepError   = null;
    let stepOutput  = null;

    try {
      const executor = EXECUTORS[step.type];
      if (!executor) throw new Error(`No executor for step type: ${step.type}`);
      const out = await executor(step, ctx);
      stepOutput = out?.output ?? null;
      if (stepOutput) console.log(chalk.gray(`    → ${stepOutput}`));
    } catch (err) {
      stepSuccess = false;
      stepError   = err.message;
      success     = false;
      console.error(chalk.red(`  ✗ Step failed: ${err.message}`));
      if (failFast) {
        results.push({ index: i, type: step.type, success: false, durationMs: Date.now() - stepStart, error: stepError, output: null });
        break;
      }
    }

    const result = {
      index:      i,
      type:       step.type,
      success:    stepSuccess,
      durationMs: Date.now() - stepStart,
      error:      stepError,
      output:     stepOutput,
    };
    results.push(result);
    if (onStepDone) onStepDone(result, step, i);

    const tick = stepSuccess ? chalk.green('  ✓') : chalk.red('  ✗');
    console.log(`${tick} done (${result.durationMs}ms)\n`);
  }

  const totalMs = Date.now() - pipelineStart;
  const bar = success ? chalk.green('✓') : chalk.red('✗');
  console.log(chalk.bold(`${bar} Pipeline '${pipelineName}' ${success ? 'succeeded' : 'FAILED'} in ${totalMs}ms`));

  return { pipeline: pipelineName, steps: results, success, durationMs: totalMs };
}

/**
 * One-line human-readable description of a step plan.
 */
function describeStep(step) {
  switch (step.type) {
    case 'build':  return `context=${step.context}${step.tag ? ` tag=${step.tag}` : ''}`;
    case 'pull':   return step.image;
    case 'run':    return `${step.image}${step.name ? ` name=${step.name}` : ''}${step.detach ? ' (detached)' : ''}`;
    case 'stop':   return (step.container || []).join(', ');
    case 'rm':     return (step.container || []).join(', ');
    case 'exec':   return `${step.container} ${step.cmd.join(' ')}`;
    case 'shell':  return step.command;
    case 'sleep':  return `${step.seconds}s`;
    case 'echo':   return step.message;
    case 'tag':    return `${step.source} → ${step.target}`;
    case 'push':   return step.image;
    case 'wait':   return (step.container || []).join(', ');
    default:       return JSON.stringify(step);
  }
}

module.exports = { runPipeline, describeStep, EXECUTORS };
