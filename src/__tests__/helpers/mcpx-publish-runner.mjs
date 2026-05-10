#!/usr/bin/env node
/**
 * Integration test runner for `mcpx publish` command.
 *
 * This script performs the FULL mcpx publish flow by importing the compiled
 * publish command and invoking it with proper arguments. It reads
 * MCPX_REGISTRY_URL from the environment to point at a local mock registry.
 *
 * Usage: node mcpx-publish-runner.mjs publish [--json]
 *
 * Environment:
 *   MCPX_MODULE_DIR   - Module directory to publish (required)
 *   MCPX_REGISTRY_URL - Registry base URL (required, e.g. http://localhost:PORT)
 *   MCPX_DEBUG        - Set to "1" for verbose output
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import compiled modules from dist/
const distRoot = resolve(__dirname, '../../../dist');

const { publishCommand } = await import(join(distRoot, 'cli/commands/publish.js'));
const { HttpRegistryClient } = await import(join(distRoot, 'registry/client.js'));

/**
 * Main CLI logic — parses args and invokes publishCommand.
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1 || args[0] !== 'publish') {
    process.stderr.write('[mcpx] ERROR: Usage: mcpx-publish-runner.mjs publish [--json]\n');
    process.exit(1);
  }

  const moduleDir = process.env.MCPX_MODULE_DIR;
  const registryUrl = process.env.MCPX_REGISTRY_URL;

  if (!moduleDir) {
    process.stderr.write('[mcpx] ERROR: MCPX_MODULE_DIR environment variable is required\n');
    process.exit(1);
  }

  if (!registryUrl) {
    process.stderr.write('[mcpx] ERROR: MCPX_REGISTRY_URL environment variable is required\n');
    process.exit(1);
  }

  const verbose = process.env.MCPX_DEBUG === '1';
  const jsonFlag = args.includes('--json');

  const registryClient = new HttpRegistryClient(registryUrl);

  const exitCode = await publishCommand({
    moduleDir,
    json: jsonFlag,
    verbose,
    registryClient,
  });

  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`[mcpx] ERROR: ${err.message || err}\n`);
  process.exit(1);
});
