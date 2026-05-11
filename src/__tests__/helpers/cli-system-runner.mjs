#!/usr/bin/env node
/**
 * Full CLI system runner for system-level testing.
 *
 * This script provides the complete mcpx CLI experience including:
 * - Help output (--help or no args)
 * - Verbose mode (--verbose or MCPX_DEBUG=1)
 * - Management commands (list, doctor, env) with --json support
 * - Run command with full pipeline
 *
 * It imports from the compiled dist/ modules and dispatches to the
 * appropriate command handler, mimicking what a full bin/mcpx CLI
 * entry point would do.
 *
 * Usage:
 *   node cli-system-runner.mjs --help
 *   node cli-system-runner.mjs (no args → help)
 *   node cli-system-runner.mjs list [--json]
 *   node cli-system-runner.mjs doctor [--json]
 *   node cli-system-runner.mjs run <module_id> [--verbose]
 *   node cli-system-runner.mjs <module_id> (implicit run)
 *
 * Environment:
 *   MCPX_ROOT   - Module root directory
 *   MCPX_DEBUG  - Set to "1" for verbose output
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

const { McpxError } = await import(toImportPath(join(srcRoot, 'core/errors.ts')));
const { resolveRoot, resolveModuleById } = await import(toImportPath(join(srcRoot, 'core/resolver.ts')));
const { validateManifest } = await import(toImportPath(join(srcRoot, 'core/manifest.ts')));
const { loadEnvironment } = await import(toImportPath(join(srcRoot, 'core/env-loader.ts')));
const { Logger } = await import(toImportPath(join(srcRoot, 'core/logger.ts')));
const { parseArgs, KNOWN_COMMANDS } = await import(toImportPath(join(srcRoot, 'cli/parser.ts')));
const { listCommand } = await import(toImportPath(join(srcRoot, 'cli/commands/list.ts')));
const { doctorCommand } = await import(toImportPath(join(srcRoot, 'cli/commands/doctor.ts')));
const { envCommand } = await import(toImportPath(join(srcRoot, 'cli/commands/env.ts')));

// Register runtime plugins
const { registerPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/registry.ts')));
const { NodejsPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/nodejs.ts')));
const { PythonPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/python.ts')));
const { GoPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/go.ts')));
const { RustPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/rust.ts')));
const { ShellPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/shell.ts')));
const { DockerPlugin } = await import(toImportPath(join(srcRoot, 'runtimes/docker.ts')));

registerPlugin('nodejs', new NodejsPlugin());
registerPlugin('python', new PythonPlugin());
registerPlugin('go', new GoPlugin());
registerPlugin('rust', new RustPlugin());
registerPlugin('shell', new ShellPlugin());
registerPlugin('docker', new DockerPlugin());

/**
 * All known command names for help display.
 */
const ALL_COMMANDS = ['run', 'list', 'doctor', 'env', 'install', 'publish', 'upgrade', 'search'];

/**
 * Display usage/help information to stderr.
 */
function showHelp() {
  const helpText = `Usage: mcpx <command> [options]

Commands:
  run <module>       Run an MCP module (default if no command specified)
  list               List all installed modules
  doctor             Check module health and configuration
  env <module>       Show environment variables for a module
  install <module>   Install a module from the registry
  publish            Publish a module to the registry
  upgrade [module]   Upgrade installed modules
  search <query>     Search the module registry

Options:
  --help             Show this help message
  --verbose          Enable verbose diagnostic output
  --json             Output results as JSON (for list, doctor, env)

Environment:
  MCPX_ROOT          Override module root directory
  MCPX_DEBUG=1       Enable verbose output (same as --verbose)

Examples:
  mcpx run my-module          Launch a module explicitly
  mcpx my-module              Launch a module (shorthand)
  mcpx list --json            List modules as JSON
  mcpx doctor                 Check all modules for issues
`;
  process.stderr.write(helpText);
}

/**
 * Main CLI dispatcher.
 */
async function main() {
  const rawArgs = process.argv.slice(2);

  // Handle --help flag or no arguments → show help
  if (rawArgs.includes('--help') || rawArgs.includes('-h') || rawArgs.length === 0) {
    showHelp();
    process.exit(0);
  }

  // Parse arguments
  const parsed = parseArgs(rawArgs);
  const logger = new Logger(parsed.flags.verbose);

  try {
    switch (parsed.command) {
      case 'list': {
        const root = resolveRoot();
        logger.debug('cli', 'Executing list command');
        const exitCode = await listCommand({
          root,
          json: parsed.flags.json,
          verbose: parsed.flags.verbose,
        });
        process.exit(exitCode);
        break;
      }

      case 'doctor': {
        const root = resolveRoot();
        logger.debug('cli', 'Executing doctor command');
        const exitCode = await doctorCommand(parsed, root, logger);
        process.exit(exitCode);
        break;
      }

      case 'env': {
        logger.debug('cli', 'Executing env command');
        envCommand(parsed);
        process.exit(0);
        break;
      }

      case 'run': {
        if (!parsed.moduleId) {
          showHelp();
          process.exit(0);
          return;
        }

        const root = resolveRoot();
        logger.debug('resolver', `Root resolved: ${root}`);

        // Resolve module
        const resolved = resolveModuleById(parsed.moduleId, root);
        logger.debug('resolver', `Module resolved: ${resolved.dir}`);

        // Validate manifest
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
        logger.debug('manifest', `Manifest valid: ${manifest.id} (${manifest.runtime})`);

        // Load environment
        const envResult = loadEnvironment({
          rootDir: root,
          moduleDir: resolved.dir,
          manifestEnv: manifest.env,
          logger,
        });
        logger.debug('env-loader', `Environment loaded: ${Object.keys(envResult.env).length} vars`);

        if (envResult.errors.length > 0) {
          process.stderr.write(
            `[mcpx] ERROR: Environment resolution failed:\n  ${envResult.errors.join('\n  ')}\n`
          );
          process.exit(4);
        }

        // Build runtime command
        const { NodejsPlugin: NP } = await import(toImportPath(join(srcRoot, 'runtimes/nodejs.ts')));
        const plugin = new NP();
        const resolvedModule = {
          manifest: { ...manifest, env: envResult.env },
          dir: resolved.dir,
          manifestPath: resolved.manifestPath,
        };

        const descriptor = plugin.buildCommand(resolvedModule);
        logger.debug('runtime', `Command: ${descriptor.command} ${descriptor.args.join(' ')}`);

        // Execute
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

        if (result.error) {
          process.stderr.write(`[mcpx] ERROR: Failed to execute: ${result.error.message}\n`);
          process.exit(3);
        }

        if (result.stdout && result.stdout.length > 0) {
          process.stdout.write(result.stdout);
        }
        if (result.stderr && result.stderr.length > 0) {
          process.stderr.write(result.stderr);
        }

        process.exit(result.status ?? 1);
        break;
      }

      default:
        process.stderr.write(`[mcpx] ERROR: Unknown command: ${parsed.command}\n`);
        process.exit(1);
    }
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
