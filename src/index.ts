/**
 * @stdiobus/mcpx — Universal modular launcher for MCP servers
 *
 * CLI entry point. This module is imported by `bin/mcpx` and immediately
 * invokes `main()` to parse arguments, register runtime plugins, and
 * dispatch to the appropriate command handler.
 *
 * @module index
 * @see Requirement 10.1 — v2 commands: run, list, doctor, env
 * @see Requirement 10.7 — Published as npm package @stdiobus/mcpx
 * @see Requirement 14.1 — Invocable from mcp.json
 * @see Requirement 14.2 — Implicit run shorthand
 * @see Requirement 14.4 — No interactive input required
 * @see Requirement 4.2 — All diagnostic output exclusively to stderr
 * @see Requirement 4.3 — Never write to stdout before/during/after launch
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from './cli/parser.js';
import { registerAllPlugins, getPlugin } from './runtimes/registry.js';
import { resolveRoot, resolveModule } from './core/resolver.js';
import { validateManifest, type Runtime } from './core/manifest.js';
import { loadEnvironment } from './core/env-loader.js';
import { Logger } from './core/logger.js';
import { McpxError } from './core/errors.js';
import { listCommand } from './cli/commands/list.js';
import { doctorCommand } from './cli/commands/doctor.js';
import { envCommand } from './cli/commands/env.js';
import { installCommand } from './cli/commands/install.js';
import { publishCommand } from './cli/commands/publish.js';
import { upgradeCommand } from './cli/commands/upgrade.js';
import { searchCommand } from './cli/commands/search.js';
import { execModuleWithEarlyExitDetection } from './platform/exec.js';

/**
 * Usage text displayed when `--help` is passed or no arguments are provided.
 */
const USAGE = `Usage: mcpx <command> [options]

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
`;

/**
 * Display usage information to stderr and exit with code 0.
 */
function showHelp(): never {
  process.stderr.write(USAGE);
  process.exit(0);
}

/**
 * Main CLI entry point.
 *
 * Parses process.argv, registers all runtime plugins, and dispatches
 * to the appropriate command handler. Catches McpxError instances and
 * exits with the correct error code.
 */
export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Handle --help / -h / no-args → print usage to stderr
  if (rawArgs.includes('--help') || rawArgs.includes('-h') || rawArgs.length === 0) {
    showHelp();
  }

  // Register all runtime plugins before dispatching
  await registerAllPlugins();

  const parsed = parseArgs(rawArgs);
  const logger = new Logger(parsed.flags.verbose);

  try {
    switch (parsed.command) {
      case 'run': {
        if (!parsed.moduleId) {
          showHelp();
        }
        await handleRun(parsed.moduleId!, parsed.extraArgs, parsed.flags, logger);
        break;
      }

      case 'list': {
        const root = resolveRoot();
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
        const exitCode = await doctorCommand(parsed, root, logger);
        process.exit(exitCode);
        break;
      }

      case 'env': {
        envCommand(parsed);
        process.exit(0);
        break;
      }

      case 'install': {
        const root = resolveRoot();
        const exitCode = await installCommand({ root, args: parsed, logger });
        process.exit(exitCode);
        break;
      }

      case 'publish': {
        const exitCode = await publishCommand({
          json: parsed.flags.json,
          verbose: parsed.flags.verbose,
        });
        process.exit(exitCode);
        break;
      }

      case 'upgrade': {
        const root = resolveRoot();
        const exitCode = await upgradeCommand({ root, args: parsed, logger });
        process.exit(exitCode);
        break;
      }

      case 'search': {
        const exitCode = await searchCommand({
          query: parsed.moduleId ?? '',
          json: parsed.flags.json,
          verbose: parsed.flags.verbose,
        });
        process.exit(exitCode);
        break;
      }

      default: {
        logger.error(`Unknown command: ${parsed.command}`, 'Run mcpx --help for usage');
        process.exit(1);
      }
    }
  } catch (err) {
    if (err instanceof McpxError) {
      logger.error(err.message, err.suggestion);
      process.exit(err.exitCode);
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(message);
    process.exit(1);
  }
}

/**
 * Handle the `run` command: resolve module, load env, build command, exec.
 *
 * @param moduleId - The module ID or path to run
 * @param extraArgs - Extra arguments passed after `--`
 * @param flags - CLI flags (verbose, json)
 * @param logger - Logger instance
 */
async function handleRun(
  moduleId: string,
  extraArgs: string[],
  _flags: { verbose: boolean; json: boolean },
  logger: Logger,
): Promise<void> {
  logger.debug('cli', `Running module: ${moduleId}`);

  // Resolve root
  const root = resolveRoot();
  logger.debug('resolver', `Module root: ${root}`);

  // Resolve module by ID or path
  const resolved = resolveModule(moduleId, root);
  logger.debug('resolver', `Module found: ${resolved.manifest.name} at ${resolved.dir}`);

  // Re-validate manifest (belt and suspenders)
  const validation = validateManifest(resolved.manifest);
  if (!validation.valid) {
    const errors = validation.errors.map(e => e.message).join(', ');
    throw new McpxError('manifest', `Manifest validation failed: ${errors}`);
  }
  const manifest = validation.manifest!;

  // Verify entry file exists
  const entryPath = resolve(resolved.dir, manifest.entry);
  if (!existsSync(entryPath)) {
    throw new McpxError(
      'runtime',
      `Entry file not found: ${entryPath}`,
      `Ensure the entry file "${manifest.entry}" exists in ${resolved.dir}`,
    );
  }

  // Load environment variables
  const envResult = loadEnvironment({
    rootDir: root,
    moduleDir: resolved.dir,
    manifestEnv: manifest.env,
    logger,
  });

  // Report env warnings
  for (const warning of envResult.errors) {
    logger.warn(warning);
  }

  // Get the runtime plugin and build the exec descriptor
  const plugin = getPlugin(manifest.runtime as Runtime);
  const descriptor = plugin.buildCommand(resolved);

  // Merge extra args (manifest args are already in descriptor.args from the plugin)
  if (extraArgs.length > 0) {
    descriptor.args.push(...extraArgs);
  }

  // Merge loaded env into the descriptor env (loaded env takes precedence over plugin env)
  descriptor.env = { ...descriptor.env, ...envResult.env };

  logger.debug('runtime', `Executing: ${descriptor.command} ${descriptor.args.join(' ')}`);

  // Execute with early exit detection for better diagnostics
  execModuleWithEarlyExitDetection(
    descriptor,
    { id: manifest.id, runtime: manifest.runtime, entry: manifest.entry },
    logger,
  );
}

// Top-level invocation: when this module is imported (by bin/mcpx), main() runs immediately.
main();
