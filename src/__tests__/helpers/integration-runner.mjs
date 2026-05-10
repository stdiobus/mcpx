#!/usr/bin/env node
/**
 * Integration test runner for mcpx.
 *
 * This script performs the FULL mcpx flow:
 * 1. Resolve the module root (via MCPX_ROOT)
 * 2. Discover and validate the module manifest
 * 3. Load environment variables from .env files
 * 4. Build the runtime command
 * 5. Execute the module process (spawn with stdio inherit)
 *
 * Unlike mcpx-runner.mjs (which only validates), this runner actually
 * launches the module process, making it suitable for integration tests
 * that need to verify real execution behavior.
 *
 * Usage: node integration-runner.mjs run <module_id>
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

// Import compiled modules from dist/
const distRoot = resolve(__dirname, '../../../dist');

const { McpxError, ManifestError, RuntimeError, EnvironmentError } = await import(
  join(distRoot, 'core/errors.js')
);
const { resolveRoot, resolveModuleById } = await import(join(distRoot, 'core/resolver.js'));
const { validateManifest } = await import(join(distRoot, 'core/manifest.js'));
const { loadEnvironment } = await import(join(distRoot, 'core/env-loader.js'));
const { Logger } = await import(join(distRoot, 'core/logger.js'));

// Import the nodejs runtime plugin
const { NodejsPlugin } = await import(join(distRoot, 'runtimes/nodejs.js'));

/**
 * Main integration runner logic.
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0] !== 'run') {
    process.stderr.write('[mcpx] ERROR: Usage: integration-runner.mjs run <module_id>\n');
    process.exit(1);
  }

  const moduleId = args[1];
  const logger = new Logger(process.env.MCPX_DEBUG === '1');

  try {
    // Step 1: Resolve root
    const root = resolveRoot();
    logger.debug('resolver', `Root resolved: ${root}`);

    // Step 2: Resolve module
    const resolved = resolveModuleById(moduleId, root);
    logger.debug('resolver', `Module resolved: ${resolved.dir}`);

    // Step 3: Validate manifest
    const manifestContent = readFileSync(resolved.manifestPath, 'utf-8');
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(manifestContent);
    } catch (parseErr) {
      process.stderr.write(
        `[mcpx] ERROR: Invalid JSON in ${resolved.manifestPath}: ${parseErr.message}\n`
      );
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
      process.stderr.write(
        `[mcpx] ERROR: Environment resolution failed:\n  ${envResult.errors.join('\n  ')}\n`
      );
      process.exit(4);
    }

    // Step 5: Build runtime command
    const plugin = new NodejsPlugin();
    const resolvedModule = {
      manifest: { ...manifest, env: envResult.env },
      dir: resolved.dir,
      manifestPath: resolved.manifestPath,
    };

    const descriptor = plugin.buildCommand(resolvedModule);

    // Step 6: Execute the module process
    // Merge the loaded env vars into the spawn environment
    const mergedEnv = {
      ...process.env,
      ...envResult.env,
      ...descriptor.env,
    };

    const result = spawnSync(descriptor.command, descriptor.args, {
      cwd: descriptor.cwd,
      env: mergedEnv,
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    // Handle spawn errors
    if (result.error) {
      process.stderr.write(`[mcpx] ERROR: Failed to execute: ${result.error.message}\n`);
      process.exit(3);
    }

    // Forward stdout/stderr
    if (result.stdout && result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr && result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }

    // Propagate exit code
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

    // Unknown error
    process.stderr.write(`[mcpx] ERROR: ${err.message || err}\n`);
    process.exit(1);
  }
}

main();
