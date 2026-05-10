/**
 * `mcpx env <module_id>` command
 *
 * Resolves all environment variables for a specified module and displays
 * them with masked values. Supports `--json` flag for JSON output to stdout.
 *
 * Masking rule:
 * - Values longer than 4 characters: show first 4 chars + "****"
 * - Values of 4 characters or fewer: show "****" (full mask)
 *
 * Output modes:
 * - Default (no --json): human-readable format to stderr
 * - With --json: valid JSON to stdout
 *
 * @module cli/commands/env
 * @see Requirement 10.4 — mcpx env <module_id> displays resolved env with masked values
 * @see Requirement 15.1 — Never log full unmasked values
 * @see Requirement 15.2 — Masking format
 */

import { resolveRoot } from '../../core/resolver.js';
import { resolveModule } from '../../core/resolver.js';
import { loadEnvironment, maskValue } from '../../core/env-loader.js';
import { Logger } from '../../core/logger.js';
import { McpxError } from '../../core/errors.js';
import type { ParsedArgs } from '../parser.js';

/**
 * JSON output structure for a single environment variable entry.
 */
export interface EnvJsonEntry {
  /** The variable name. */
  name: string;
  /** The masked value (never the full secret). */
  maskedValue: string;
}

/**
 * JSON output structure for the env command.
 */
export interface EnvJsonOutput {
  /** The module ID. */
  moduleId: string;
  /** Resolved and masked environment variables. */
  variables: EnvJsonEntry[];
  /** Number of variables resolved. */
  count: number;
}

/**
 * Execute the `mcpx env <module_id>` command.
 *
 * Resolves all environment variables for the specified module using the
 * full precedence chain (system > module .env > root .env > manifest defaults),
 * then displays them with masked values.
 *
 * @param args - Parsed CLI arguments (must include moduleId)
 * @throws {McpxError} If no module ID is provided
 * @throws {McpxError} If the module cannot be found
 * @throws {McpxError} If environment resolution fails critically
 */
export function envCommand(args: ParsedArgs): void {
  const logger = new Logger(args.flags.verbose);

  // Validate that a module ID was provided
  if (!args.moduleId) {
    throw new McpxError(
      'general',
      'No module ID specified for env command',
      'Usage: mcpx env <module_id> [--json]'
    );
  }

  logger.debug('env', `Resolving environment for module: ${args.moduleId}`);

  // Resolve the module root
  const root = resolveRoot();
  logger.debug('env', `Module root: ${root}`);

  // Resolve the module by ID or path
  const resolved = resolveModule(args.moduleId, root);
  logger.debug('env', `Module found: ${resolved.manifest.name} at ${resolved.dir}`);

  // Load environment variables using the full precedence chain
  const result = loadEnvironment({
    rootDir: root,
    moduleDir: resolved.dir,
    manifestEnv: resolved.manifest.env,
    logger,
  });

  // Report any resolution errors as warnings (non-fatal for display purposes)
  for (const error of result.errors) {
    logger.warn(error);
  }

  // Build masked entries
  const entries = Object.entries(result.env).map(([name, value]) => ({
    name,
    maskedValue: maskValue(value),
  }));

  // Sort entries alphabetically by name for consistent output
  entries.sort((a, b) => a.name.localeCompare(b.name));

  if (args.flags.json) {
    // JSON output to stdout
    const output: EnvJsonOutput = {
      moduleId: resolved.manifest.id,
      variables: entries,
      count: entries.length,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    // Human-readable output to stderr
    process.stderr.write(`[mcpx] Environment variables for "${resolved.manifest.id}":\n`);

    if (entries.length === 0) {
      process.stderr.write('[mcpx] (no environment variables configured)\n');
    } else {
      for (const entry of entries) {
        process.stderr.write(`[mcpx]   ${entry.name}=${entry.maskedValue}\n`);
      }
      process.stderr.write(`[mcpx] ${entries.length} variable(s) resolved\n`);
    }
  }
}
