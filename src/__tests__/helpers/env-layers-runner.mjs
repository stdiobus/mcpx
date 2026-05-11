#!/usr/bin/env node
/**
 * Environment layers integration test runner.
 *
 * This script exercises the REAL mcpx env-loading pipeline and then
 * executes a shell module with the resolved environment. It:
 *
 * 1. Resolves the module root (via MCPX_ROOT)
 * 2. Discovers the module by ID
 * 3. Loads environment from all 4 layers using the real env-loader
 * 4. Executes the shell module with the merged environment
 *
 * Usage: node env-layers-runner.mjs <module_id>
 *
 * Environment:
 *   MCPX_ROOT       - Module root directory (required)
 *   ENV_PROBE_OUTPUT - Path where the probe module writes its output
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import from TypeScript source via tsx loader
const srcRoot = resolve(__dirname, '../../');

function toImportPath(p) { return pathToFileURL(p).href; }

const { McpxError, ManifestError, RuntimeError, EnvironmentError } = await import(
  toImportPath(join(srcRoot, 'core/errors.ts'))
);
const { resolveRoot, resolveModuleById } = await import(toImportPath(join(srcRoot, 'core/resolver.ts')));
const { validateManifest } = await import(toImportPath(join(srcRoot, 'core/manifest.ts')));
const { loadEnvironment } = await import(toImportPath(join(srcRoot, 'core/env-loader.ts')));
const { Logger } = await import(toImportPath(join(srcRoot, 'core/logger.ts')));

/**
 * Main runner logic — resolves module, loads env, executes shell module.
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    process.stderr.write('[mcpx] ERROR: Usage: env-layers-runner.mjs <module_id>\n');
    process.exit(1);
  }

  const moduleId = args[0];
  const logger = new Logger(false);

  try {
    // Step 1: Resolve root
    const root = resolveRoot();

    // Step 2: Discover module
    const modulesDir = join(root, 'modules');
    const moduleDir = join(modulesDir, moduleId);
    const manifestPath = join(moduleDir, 'module.json');

    if (!existsSync(manifestPath)) {
      process.stderr.write(`[mcpx] ERROR: Module "${moduleId}" not found\n`);
      process.exit(1);
    }

    // Step 3: Parse and validate manifest
    const rawContent = readFileSync(manifestPath, 'utf-8');
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(rawContent);
    } catch (parseErr) {
      process.stderr.write(`[mcpx] ERROR: Invalid JSON in ${manifestPath}: ${parseErr.message}\n`);
      process.exit(2);
    }

    const validation = validateManifest(parsedManifest);
    if (!validation.valid) {
      const errorMessages = validation.errors.map(e => `  - ${e.field}: ${e.message}`).join('\n');
      process.stderr.write(`[mcpx] ERROR: Manifest validation failed:\n${errorMessages}\n`);
      process.exit(2);
    }

    const manifest = validation.manifest;

    // Step 4: Load environment from all 4 layers using REAL env-loader
    const envResult = loadEnvironment({
      rootDir: root,
      moduleDir,
      manifestEnv: manifest.env || {},
      logger,
    });

    if (envResult.errors.length > 0) {
      process.stderr.write(`[mcpx] ERROR: Environment loading failed:\n`);
      for (const err of envResult.errors) {
        process.stderr.write(`  - ${err}\n`);
      }
      process.exit(4);
    }

    // Step 5: Validate entry file exists
    const entryPath = resolve(moduleDir, manifest.entry);
    if (!existsSync(entryPath)) {
      process.stderr.write(`[mcpx] ERROR: Entry file not found: ${entryPath}\n`);
      process.exit(3);
    }

    // Step 6: Execute the shell module with the merged environment
    // Build the full environment: start with current process.env, overlay with loaded env
    const execEnv = {
      ...process.env,
      ...envResult.env,
    };

    // For shell runtime, execute with /bin/sh
    if (manifest.runtime !== 'shell') {
      process.stderr.write(`[mcpx] ERROR: This runner only supports shell runtime, got: ${manifest.runtime}\n`);
      process.exit(3);
    }

    const execArgs = [manifest.entry, ...(manifest.args || [])];

    const result = spawnSync('/bin/sh', execArgs, {
      cwd: moduleDir,
      env: execEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });

    if (result.error) {
      process.stderr.write(`[mcpx] ERROR: Failed to execute module: ${result.error.message}\n`);
      process.exit(3);
    }

    // Forward stderr from the module
    if (result.stderr && result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }

    // Forward stdout from the module
    if (result.stdout && result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }

    process.exit(result.status ?? 0);
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
