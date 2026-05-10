#!/usr/bin/env node
/**
 * Management commands runner for e2e testing.
 *
 * This script exercises the REAL mcpx management commands (list, doctor, env)
 * by importing the compiled TypeScript modules and producing proper exit codes.
 *
 * Usage:
 *   node management-runner.mjs list [--json]
 *   node management-runner.mjs doctor [--json]
 *   node management-runner.mjs env <module_id> [--json]
 *
 * Environment:
 *   MCPX_ROOT - Module root directory (required)
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import compiled modules from dist/
const distRoot = resolve(__dirname, '../../../dist');

const { resolveRoot } = await import(join(distRoot, 'core/resolver.js'));
const { Logger } = await import(join(distRoot, 'core/logger.js'));
const { parseArgs } = await import(join(distRoot, 'cli/parser.js'));
const { listCommand } = await import(join(distRoot, 'cli/commands/list.js'));
const { doctorCommand } = await import(join(distRoot, 'cli/commands/doctor.js'));
const { envCommand } = await import(join(distRoot, 'cli/commands/env.js'));

// Register runtime plugins so list/doctor can check availability
const { registerPlugin } = await import(join(distRoot, 'runtimes/registry.js'));
const { NodejsPlugin } = await import(join(distRoot, 'runtimes/nodejs.js'));
const { PythonPlugin } = await import(join(distRoot, 'runtimes/python.js'));
const { GoPlugin } = await import(join(distRoot, 'runtimes/go.js'));
const { RustPlugin } = await import(join(distRoot, 'runtimes/rust.js'));
const { ShellPlugin } = await import(join(distRoot, 'runtimes/shell.js'));
const { DockerPlugin } = await import(join(distRoot, 'runtimes/docker.js'));

registerPlugin('nodejs', new NodejsPlugin());
registerPlugin('python', new PythonPlugin());
registerPlugin('go', new GoPlugin());
registerPlugin('rust', new RustPlugin());
registerPlugin('shell', new ShellPlugin());
registerPlugin('docker', new DockerPlugin());

/**
 * Main CLI logic — dispatches to the appropriate management command.
 */
async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  try {
    // Resolve root first (needed by all commands)
    const root = resolveRoot();

    switch (parsed.command) {
      case 'list': {
        const exitCode = await listCommand({
          root,
          json: parsed.flags.json,
          verbose: parsed.flags.verbose,
        });
        process.exit(exitCode);
        break;
      }

      case 'doctor': {
        const logger = new Logger(parsed.flags.verbose);
        const exitCode = await doctorCommand(parsed, root, logger);
        process.exit(exitCode);
        break;
      }

      case 'env': {
        envCommand(parsed);
        process.exit(0);
        break;
      }

      default:
        process.stderr.write(`[mcpx] ERROR: Unsupported command: ${parsed.command}\n`);
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`[mcpx] ERROR: ${err.message || err}\n`);
    if (err.suggestion) {
      process.stderr.write(`[mcpx]   → ${err.suggestion}\n`);
    }
    process.exit(err.exitCode || 1);
  }
}

main();
