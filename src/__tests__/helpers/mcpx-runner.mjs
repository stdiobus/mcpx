#!/usr/bin/env node
/**
 * Minimal mcpx CLI runner for property-based testing.
 *
 * This script mimics the real mcpx CLI behavior by importing the compiled
 * TypeScript modules and producing proper exit codes based on error types.
 * It is used by property tests to spawn REAL processes and verify exit codes.
 *
 * Usage: node --import tsx/esm mcpx-runner.mjs run <module_id>
 *        (or via spawnMcpxRunner which sets up tsx loader)
 *
 * Environment:
 *   MCPX_ROOT - Module root directory (required for testing)
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import directly from TypeScript source via tsx loader
const srcRoot = resolve(__dirname, '../../');

/** Convert a file path to a URL string for cross-platform dynamic import */
function toImportPath(filePath) {
  return pathToFileURL(filePath).href;
}

const { McpxError, ManifestError, RuntimeError, EnvironmentError, EXIT_CODES } = await import(
  toImportPath(join(srcRoot, 'core/errors.ts'))
);
const { resolveRoot, resolveModuleById } = await import(toImportPath(join(srcRoot, 'core/resolver.ts')));
const { validateManifest } = await import(toImportPath(join(srcRoot, 'core/manifest.ts')));

/**
 * Main CLI logic — resolves module, validates manifest, checks runtime.
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0] !== 'run') {
    process.stderr.write('[mcpx] ERROR: Usage: mcpx run <module_id>\n');
    process.exit(1);
  }

  const moduleId = args[1];

  try {
    // Step 1: Resolve root
    const root = resolveRoot();

    // Step 2: Check if the module directory exists with a module.json
    // (handles the case where module.json exists but is invalid JSON)
    const modulesDir = join(root, 'modules');
    const exactDir = join(modulesDir, moduleId);
    const exactManifestPath = join(exactDir, 'module.json');

    if (existsSync(exactManifestPath)) {
      // The directory exists with a module.json — try to parse it
      const rawContent = readFileSync(exactManifestPath, 'utf-8');
      let parsedManifest;
      try {
        parsedManifest = JSON.parse(rawContent);
      } catch (parseErr) {
        process.stderr.write(
          `[mcpx] ERROR: Invalid JSON in ${exactManifestPath}: ${parseErr.message}\n` +
          `[mcpx]   → Fix the JSON syntax in your module.json file\n`
        );
        process.exit(2);
      }

      // Validate the manifest
      const validation = validateManifest(parsedManifest);
      if (!validation.valid) {
        const errorMessages = validation.errors.map(e => `  - ${e.field}: ${e.message}`).join('\n');
        process.stderr.write(`[mcpx] ERROR: Manifest validation failed in ${exactManifestPath}:\n${errorMessages}\n`);
        process.exit(2);
      }

      // Manifest is valid — check entry file exists (runtime error if missing)
      const entryPath = resolve(exactDir, validation.manifest.entry);
      if (!existsSync(entryPath)) {
        process.stderr.write(
          `[mcpx] ERROR: Entry file not found: ${entryPath}\n` +
          `[mcpx]   → Ensure the entry file exists in the module directory\n`
        );
        process.exit(3);
      }

      // Check runtime tool availability
      const runtime = validation.manifest.runtime;
      const knownRuntimes = ['nodejs', 'python', 'go', 'rust', 'shell', 'docker'];
      if (!knownRuntimes.includes(runtime)) {
        process.stderr.write(
          `[mcpx] ERROR: Unsupported runtime "${runtime}"\n` +
          `[mcpx]   → Supported runtimes: ${knownRuntimes.join(', ')}\n`
        );
        process.exit(3);
      }

      // Module is valid and ready
      process.stderr.write(`[mcpx] Module "${moduleId}" resolved successfully\n`);
      process.exit(0);
    }

    // Step 3: Try the standard resolver (handles id-field scan, path inputs, etc.)
    const resolved = resolveModuleById(moduleId, root);

    // Step 4: Re-validate the discovered manifest from disk
    const manifestContent = readFileSync(resolved.manifestPath, 'utf-8');
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(manifestContent);
    } catch (parseErr) {
      process.stderr.write(
        `[mcpx] ERROR: Invalid JSON in ${resolved.manifestPath}: ${parseErr.message}\n` +
        `[mcpx]   → Fix the JSON syntax in your module.json file\n`
      );
      process.exit(2);
    }

    const validation = validateManifest(parsedManifest);
    if (!validation.valid) {
      const errorMessages = validation.errors.map(e => `  - ${e.field}: ${e.message}`).join('\n');
      process.stderr.write(`[mcpx] ERROR: Manifest validation failed:\n${errorMessages}\n`);
      process.exit(2);
    }

    // Check entry file exists
    const entryPath = resolve(resolved.dir, resolved.manifest.entry);
    if (!existsSync(entryPath)) {
      process.stderr.write(
        `[mcpx] ERROR: Entry file not found: ${entryPath}\n` +
        `[mcpx]   → Ensure the entry file exists in the module directory\n`
      );
      process.exit(3);
    }

    // Check runtime
    const runtime = resolved.manifest.runtime;
    const knownRuntimes = ['nodejs', 'python', 'go', 'rust', 'shell', 'docker'];
    if (!knownRuntimes.includes(runtime)) {
      process.stderr.write(
        `[mcpx] ERROR: Unsupported runtime "${runtime}"\n` +
        `[mcpx]   → Supported runtimes: ${knownRuntimes.join(', ')}\n`
      );
      process.exit(3);
    }

    // Module is valid and ready
    process.stderr.write(`[mcpx] Module "${moduleId}" resolved successfully\n`);
    process.exit(0);
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
