#!/usr/bin/env node
/**
 * Minimal stdio transparency test runner.
 *
 * Exercises the real mcpx exec path by resolving a shell module
 * and executing it with full stdio transparency. Used by the
 * stdio-transparency integration test.
 *
 * Usage: node stdio-runner.mjs <module_id>
 *
 * Environment:
 *   MCPX_ROOT - Module root directory (required)
 *
 * This script:
 * 1. Resolves the module root from MCPX_ROOT
 * 2. Discovers the module by ID
 * 3. Validates the manifest
 * 4. Builds the exec descriptor using the shell runtime plugin
 * 5. Calls execModule() which replaces the process with the module
 *
 * stdin/stdout flow directly through to the module process.
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import from TypeScript source via tsx loader
const srcRoot = resolve(__dirname, '../../');

const { McpxError, RuntimeError } = await import(join(srcRoot, 'core/errors.ts'));
const { resolveRoot, resolveModuleById } = await import(join(srcRoot, 'core/resolver.ts'));
const { validateManifest } = await import(join(srcRoot, 'core/manifest.ts'));
const { execModule } = await import(join(srcRoot, 'platform/exec.ts'));

function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    process.stderr.write('[mcpx] ERROR: Usage: stdio-runner.mjs <module_id>\n');
    process.exit(1);
  }

  const moduleId = args[0];

  try {
    // Step 1: Resolve root
    const root = resolveRoot();

    // Step 2: Discover module
    const modulesDir = join(root, 'modules');
    const exactDir = join(modulesDir, moduleId);
    const exactManifestPath = join(exactDir, 'module.json');

    if (!existsSync(exactManifestPath)) {
      process.stderr.write(`[mcpx] ERROR: Module '${moduleId}' not found\n`);
      process.exit(1);
    }

    // Step 3: Parse and validate manifest
    const rawContent = readFileSync(exactManifestPath, 'utf-8');
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(rawContent);
    } catch (parseErr) {
      process.stderr.write(`[mcpx] ERROR: Invalid JSON in ${exactManifestPath}\n`);
      process.exit(2);
    }

    const validation = validateManifest(parsedManifest);
    if (!validation.valid) {
      process.stderr.write(`[mcpx] ERROR: Manifest validation failed\n`);
      process.exit(2);
    }

    const manifest = validation.manifest;

    // Step 4: Build exec descriptor for shell runtime
    // Shell runtime: /bin/sh <entry> <args>
    const entryPath = resolve(exactDir, manifest.entry);
    if (!existsSync(entryPath)) {
      process.stderr.write(`[mcpx] ERROR: Entry file not found: ${entryPath}\n`);
      process.exit(3);
    }

    const descriptor = {
      command: '/bin/sh',
      args: [manifest.entry, ...(manifest.args || [])],
      cwd: exactDir,
      env: {},
    };

    // Step 5: exec into the module — this replaces the process
    // stdin/stdout are inherited directly (stdio: 'inherit' in spawnSync)
    execModule(descriptor);

  } catch (err) {
    if (err instanceof McpxError) {
      process.stderr.write(`[mcpx] ERROR: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`[mcpx] ERROR: ${err.message || err}\n`);
    process.exit(1);
  }
}

main();
