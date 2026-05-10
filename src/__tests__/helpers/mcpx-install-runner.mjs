#!/usr/bin/env node
/**
 * Integration test runner for `mcpx install` command.
 *
 * This script performs the FULL mcpx install flow by importing the compiled
 * install command and invoking it with proper arguments. It reads
 * MCPX_REGISTRY_URL from the environment to point at a local mock registry.
 *
 * Usage: node mcpx-install-runner.mjs install <module_name>
 *
 * Environment:
 *   MCPX_ROOT         - Module root directory (required)
 *   MCPX_REGISTRY_URL - Registry base URL (required, e.g. http://localhost:PORT)
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import compiled modules from dist/
const distRoot = resolve(__dirname, '../../../dist');

const { installCommand } = await import(join(distRoot, 'cli/commands/install.js'));
const { HttpRegistryClient } = await import(join(distRoot, 'registry/client.js'));
const { Logger } = await import(join(distRoot, 'core/logger.js'));
const { resolveRoot } = await import(join(distRoot, 'core/resolver.js'));

/**
 * Main CLI logic — parses args and invokes installCommand.
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0] !== 'install') {
    process.stderr.write('[mcpx] ERROR: Usage: mcpx-install-runner.mjs install <module_name>\n');
    process.exit(1);
  }

  const moduleId = args[1];
  const registryUrl = process.env.MCPX_REGISTRY_URL;

  if (!registryUrl) {
    process.stderr.write('[mcpx] ERROR: MCPX_REGISTRY_URL environment variable is required\n');
    process.exit(1);
  }

  const verbose = process.env.MCPX_DEBUG === '1';
  const logger = new Logger(verbose);

  let root;
  try {
    root = resolveRoot();
  } catch (err) {
    process.stderr.write(`[mcpx] ERROR: ${err.message}\n`);
    process.exit(1);
  }

  const registryClient = new HttpRegistryClient(registryUrl);

  const parsedArgs = {
    command: 'install',
    moduleId,
    extraArgs: [],
    flags: { verbose, json: false },
  };

  const exitCode = await installCommand({
    root,
    args: parsedArgs,
    logger,
    registryClient,
  });

  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`[mcpx] ERROR: ${err.message || err}\n`);
  process.exit(1);
});
