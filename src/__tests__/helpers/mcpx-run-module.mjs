#!/usr/bin/env node
/**
 * Integration test runner for mcpx module execution.
 *
 * This script wires up the full mcpx pipeline:
 * 1. Resolve root (from MCPX_ROOT)
 * 2. Discover module by ID
 * 3. Load environment variables (.env files + manifest defaults)
 * 4. Build runtime command via the appropriate plugin
 * 5. Execute the module process (spawn with inherited stdio)
 *
 * Unlike mcpx-runner.mjs (which only validates), this script actually
 * launches the module process — used by integration tests.
 *
 * Usage: node mcpx-run-module.mjs <module_id>
 *
 * Environment:
 *   MCPX_ROOT - Module root directory (required)
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
const { PythonPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/python.ts')));
const { NodejsPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/nodejs.ts')));
const { ShellPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/shell.ts')));
const { GoPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/go.ts')));
const { RustPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/rust.ts')));
const { DockerPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/docker.ts')));

/**
 * Runtime plugin instances keyed by runtime name.
 */
const plugins = {
  nodejs: new NodejsPlugin(),
  python: new PythonPlugin(),
  shell: new ShellPlugin(),
  go: new GoPlugin(),
  rust: new RustPlugin(),
  docker: new DockerPlugin(),
};

/**
 * Main CLI logic — resolves module, loads env, builds command, executes.
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    process.stderr.write('[mcpx] ERROR: Usage: mcpx-run-module <module_id>\n');
    process.exit(1);
  }

  const moduleId = args[0];
  const logger = new Logger(process.env.MCPX_DEBUG === '1');

  try {
    // Step 1: Resolve root
    const root = resolveRoot();
    logger.debug('resolver', `Root resolved: ${root}`);

    // Step 2: Discover module
    const modulesDir = join(root, 'modules');
    const exactDir = join(modulesDir, moduleId);
    const exactManifestPath = join(exactDir, 'module.json');

    let moduleDir;
    let manifest;

    if (existsSync(exactManifestPath)) {
      moduleDir = exactDir;
      const rawContent = readFileSync(exactManifestPath, 'utf-8');
      let parsed;
      try {
        parsed = JSON.parse(rawContent);
      } catch (parseErr) {
        process.stderr.write(`[mcpx] ERROR: Invalid JSON in ${exactManifestPath}: ${parseErr.message}\n`);
        process.exit(2);
      }

      const validation = validateManifest(parsed);
      if (!validation.valid) {
        const msgs = validation.errors.map(e => `  - ${e.field}: ${e.message}`).join('\n');
        process.stderr.write(`[mcpx] ERROR: Manifest validation failed:\n${msgs}\n`);
        process.exit(2);
      }
      manifest = validation.manifest;
    } else {
      // Try the standard resolver
      const resolved = resolveModuleById(moduleId, root);
      moduleDir = resolved.dir;
      manifest = resolved.manifest;
    }

    logger.debug('resolver', `Module found: ${moduleDir}`);

    // Step 3: Verify entry file exists
    const entryPath = resolve(moduleDir, manifest.entry);
    if (!existsSync(entryPath)) {
      process.stderr.write(`[mcpx] ERROR: Entry file not found: ${entryPath}\n`);
      process.exit(3);
    }

    // Step 4: Load environment
    const envResult = loadEnvironment({
      rootDir: root,
      moduleDir,
      manifestEnv: manifest.env,
      logger,
    });

    if (envResult.errors && envResult.errors.length > 0) {
      process.stderr.write(`[mcpx] ERROR: Environment loading failed:\n  ${envResult.errors.join('\n  ')}\n`);
      process.exit(4);
    }

    // Step 5: Get runtime plugin and build command
    const plugin = plugins[manifest.runtime];
    if (!plugin) {
      process.stderr.write(`[mcpx] ERROR: Unsupported runtime: ${manifest.runtime}\n`);
      process.exit(3);
    }

    const resolvedModule = {
      manifest,
      dir: moduleDir,
      manifestPath: join(moduleDir, 'module.json'),
    };

    const descriptor = plugin.buildCommand(resolvedModule);
    logger.debug('runtime', `Command: ${descriptor.command} ${descriptor.args.join(' ')}`);

    // Step 6: Execute the module process
    // Merge env: process.env + loaded env + descriptor env
    const mergedEnv = {
      ...process.env,
      ...envResult.env,
      ...descriptor.env,
    };

    const result = spawnSync(descriptor.command, descriptor.args, {
      cwd: descriptor.cwd,
      env: mergedEnv,
      // stdin must flow through so E2E tests can speak JSON-RPC to the server.
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (result.error) {
      process.stderr.write(`[mcpx] ERROR: Failed to execute: ${result.error.message}\n`);
      process.exit(3);
    }

    if (result.signal) {
      process.exit(128 + 15);
    }

    // Proxy child stdout/stderr so E2E tests can observe real protocol output.
    if (result.stdout && result.stdout.length) process.stdout.write(result.stdout);
    if (result.stderr && result.stderr.length) process.stderr.write(result.stderr);

    process.exit(result.status ?? 1);
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
