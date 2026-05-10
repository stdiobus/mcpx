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

// Import from TypeScript source via tsx loader
const srcRoot = resolve(__dirname, '../../');

const { resolveRoot } = await import(join(srcRoot, 'core/resolver.ts'));
const { Logger } = await import(join(srcRoot, 'core/logger.ts'));
const { parseArgs } = await import(join(srcRoot, 'cli/parser.ts'));
const { listCommand } = await import(join(srcRoot, 'cli/commands/list.ts'));
const { doctorCommand } = await import(join(srcRoot, 'cli/commands/doctor.ts'));
const { envCommand } = await import(join(srcRoot, 'cli/commands/env.ts'));

// Register runtime plugins so list/doctor can check availability
const { registerPlugin } = await import(join(srcRoot, 'runtimes/registry.ts'));
const { NodejsPlugin } = await import(join(srcRoot, 'runtimes/nodejs.ts'));
const { PythonPlugin } = await import(join(srcRoot, 'runtimes/python.ts'));
const { GoPlugin } = await import(join(srcRoot, 'runtimes/go.ts'));
const { RustPlugin } = await import(join(srcRoot, 'runtimes/rust.ts'));
const { ShellPlugin } = await import(join(srcRoot, 'runtimes/shell.ts'));
const { DockerPlugin } = await import(join(srcRoot, 'runtimes/docker.ts'));

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
