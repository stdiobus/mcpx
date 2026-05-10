#!/usr/bin/env node
/**
 * Search command integration test runner for mcpx.
 *
 * This script invokes the REAL compiled searchCommand with support for
 * overriding the registry URL via MCPX_REGISTRY_URL environment variable.
 *
 * Usage: node search-runner.mjs search [--json] <query>
 *
 * Environment:
 *   MCPX_REGISTRY_URL - Override the registry base URL (required for testing)
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import compiled modules from dist/
const distRoot = resolve(__dirname, '../../../dist');

const { searchCommand } = await import(join(distRoot, 'cli/commands/search.js'));
const { HttpRegistryClient } = await import(join(distRoot, 'registry/client.js'));

/**
 * Main runner logic — parses args and invokes searchCommand.
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1 || args[0] !== 'search') {
    process.stderr.write('[mcpx] ERROR: Usage: search-runner.mjs search [--json] <query>\n');
    process.exit(1);
  }

  // Parse flags and query from remaining args
  const remaining = args.slice(1);
  let json = false;
  let verbose = false;
  let query = '';

  for (const arg of remaining) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else {
      query = arg;
    }
  }

  // Override the registry URL if MCPX_REGISTRY_URL is set
  const registryUrl = process.env.MCPX_REGISTRY_URL;
  if (registryUrl) {
    // Monkey-patch the HttpRegistryClient to use the test URL
    const originalConstructor = HttpRegistryClient;
    const OriginalPrototype = originalConstructor.prototype;

    // Override the search method to use the custom URL
    const originalSearch = OriginalPrototype.search;
    OriginalPrototype.search = async function (q) {
      const url = `${registryUrl}/modules?q=${encodeURIComponent(q)}&limit=50`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Registry search failed: ${res.status} ${res.statusText}`);
      }
      return res.json();
    };
  }

  const exitCode = await searchCommand({ query, json, verbose });
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`[mcpx] ERROR: ${err.message || err}\n`);
  process.exit(1);
});
