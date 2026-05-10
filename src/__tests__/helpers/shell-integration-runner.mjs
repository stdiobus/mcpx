#!/usr/bin/env node
/**
 * Integration runner for shell module tests.
 *
 * This script performs the FULL mcpx flow:
 *   1. Parse CLI args (run <module_id> [-- extra args])
 *   2. Resolve module root (via MCPX_ROOT)
 *   3. Discover and validate the module
 *   4. Load environment variables (root .env + module .env + manifest defaults)
 *   5. Build the runtime command (shell: /bin/sh <entry>)
 *   6. Execute the module process with merged env and args
 *
 * Unlike mcpx-runner.mjs (which only validates), this runner actually
 * executes the module process to verify real runtime behavior.
 *
 * Usage: node shell-integration-runner.mjs run <module_id> [-- <extra_args>]
 *
 * Environment:
 *   MCPX_ROOT - Module root directory (required)
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import from TypeScript source via tsx loader
const srcRoot = resolve(__dirname, '../../');

const { McpxError, ManifestError, RuntimeError, EnvironmentError } = await import(
  join(srcRoot, 'core/errors.ts')
);
const { resolveRoot, resolveModuleById } = await import(join(srcRoot, 'core/resolver.ts'));
const { validateManifest } = await import(join(srcRoot, 'core/manifest.ts'));
const { loadEnvironment } = await import(join(srcRoot, 'core/env-loader.ts'));
const { Logger } = await import(join(srcRoot, 'core/logger.ts'));

/**
 * Parse CLI arguments, extracting module ID and extra args after --.
 */
function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.length < 2 || args[0] !== 'run') {
    process.stderr.write('[mcpx] ERROR: Usage: shell-integration-runner.mjs run <module_id> [-- <extra_args>]\n');
    process.exit(1);
  }

  const moduleId = args[1];
  let extraArgs = [];

  // Find -- separator and collect extra args
  const separatorIdx = args.indexOf('--');
  if (separatorIdx !== -1) {
    extraArgs = args.slice(separatorIdx + 1);
  }

  return { moduleId, extraArgs };
}

/**
 * Main integration runner logic.
 */
function main() {
  const { moduleId, extraArgs } = parseArgs(process.argv);
  const logger = new Logger(process.env.MCPX_DEBUG === '1');

  try {
    // Step 1: Resolve root
    const root = resolveRoot();
    logger.debug('runner', `Root resolved: ${root}`);

    // Step 2: Resolve module
    const resolved = resolveModuleById(moduleId, root);
    logger.debug('runner', `Module resolved: ${resolved.dir}`);

    // Step 3: Validate manifest
    const manifestContent = readFileSync(resolved.manifestPath, 'utf-8');
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(manifestContent);
    } catch (parseErr) {
      process.stderr.write(`[mcpx] ERROR: Invalid JSON in ${resolved.manifestPath}: ${parseErr.message}\n`);
      process.exit(2);
    }

    const validation = validateManifest(parsedManifest);
    if (!validation.valid) {
      const errorMessages = validation.errors.map(e => `  - ${e.field}: ${e.message}`).join('\n');
      process.stderr.write(`[mcpx] ERROR: Manifest validation failed:\n${errorMessages}\n`);
      process.exit(2);
    }

    const manifest = validation.manifest;

    // Step 4: Load environment variables
    const envResult = loadEnvironment({
      rootDir: root,
      moduleDir: resolved.dir,
      manifestEnv: manifest.env,
      logger,
    });

    if (envResult.errors.length > 0) {
      process.stderr.write(`[mcpx] ERROR: Environment loading failed:\n  ${envResult.errors.join('\n  ')}\n`);
      process.exit(4);
    }

    // Step 5: Build command based on runtime
    const runtime = manifest.runtime;
    if (runtime !== 'shell') {
      process.stderr.write(`[mcpx] ERROR: This runner only supports shell runtime, got: ${runtime}\n`);
      process.exit(3);
    }

    const entryPath = resolve(resolved.dir, manifest.entry);
    if (!existsSync(entryPath)) {
      process.stderr.write(`[mcpx] ERROR: Entry file not found: ${entryPath}\n`);
      process.exit(3);
    }

    // Step 6: Build args: manifest args first, then extra CLI args
    const manifestArgs = manifest.args || [];
    const allArgs = [manifest.entry, ...manifestArgs, ...extraArgs];

    // Step 7: Merge environment
    const mergedEnv = {
      ...process.env,
      ...envResult.env,
    };

    // Step 8: Execute the shell module
    logger.debug('runner', `Executing: /bin/sh ${allArgs.join(' ')}`);
    logger.debug('runner', `CWD: ${resolved.dir}`);

    const result = spawnSync('/bin/sh', allArgs, {
      cwd: resolved.dir,
      env: mergedEnv,
      stdio: ['inherit', 'inherit', 'pipe'],
      timeout: 30_000,
    });

    // Forward stderr from the child process
    if (result.stderr && result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }

    if (result.error) {
      process.stderr.write(`[mcpx] ERROR: Failed to execute shell module: ${result.error.message}\n`);
      process.exit(3);
    }

    const exitCode = result.status ?? 1;
    process.exit(exitCode);

  } catch (err) {
    if (err instanceof McpxError) {
      process.stderr.write(`[mcpx] ERROR: ${err.message}\n`);
      if (err.suggestion) {
        process.stderr.write(`[mcpx]   → ${err.suggestion}\n`);
      }
      process.exit(err.exitCode);
    }

    process.stderr.write(`[mcpx] ERROR: ${err.message || err}\n`);
    process.exit(1);
  }
}

main();
