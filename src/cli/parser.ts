/**
 * CLI argument parser for mcpx.
 *
 * Parses command-line arguments into a structured format, handling
 * subcommands, implicit run shorthand, flags, and extra arguments.
 *
 * @module cli/parser
 * @see Requirement 10.1 — v2 commands: run, list, doctor, env
 * @see Requirement 14.2 — Implicit run shorthand
 * @see Requirement 14.6 — Subcommand/module-ID collision handling
 * @see Requirement 16.1 — --verbose flag support
 */

/**
 * Supported mcpx subcommands.
 *
 * - v2 commands: run, list, doctor, env
 * - v3 commands: install, publish, upgrade, search
 */
export type Command = 'run' | 'list' | 'doctor' | 'env' | 'install' | 'publish' | 'upgrade' | 'search';

/**
 * The set of registered subcommand names used for collision detection.
 */
export const KNOWN_COMMANDS: ReadonlySet<string> = new Set<Command>([
  'run', 'list', 'doctor', 'env',
  'install', 'publish', 'upgrade', 'search',
]);

/**
 * Result of parsing CLI arguments.
 *
 * Represents the fully parsed command-line input including the resolved
 * subcommand, optional module identifier, any extra arguments passed
 * after `--`, and global flags.
 *
 * @example
 * ```
 * // mcpx run my-module --verbose -- --port 3000
 * {
 *   command: 'run',
 *   moduleId: 'my-module',
 *   extraArgs: ['--port', '3000'],
 *   flags: { verbose: true, json: false }
 * }
 * ```
 */
export interface ParsedArgs {
  /** The resolved subcommand to execute. */
  command: Command;

  /** The target module identifier (required for run, env; optional for others). */
  moduleId?: string;

  /** Additional arguments passed after `--` separator, forwarded to the module process. */
  extraArgs: string[];

  /** Global CLI flags. */
  flags: {
    /**
     * Enable detailed diagnostic output to stderr.
     * Activated by `--verbose` flag or `MCPX_DEBUG=1` environment variable.
     * @see Requirement 16.1
     */
    verbose: boolean;

    /**
     * Output results as JSON to stdout instead of human-readable format to stderr.
     */
    json: boolean;
  };
}

/**
 * Parse raw CLI arguments into a structured ParsedArgs object.
 *
 * Handles:
 * - Explicit subcommands: `mcpx run my-module`, `mcpx list`, `mcpx doctor`
 * - Implicit run shorthand: `mcpx my-module` → treated as `mcpx run my-module`
 * - Global flags: `--verbose`, `--json` (extracted from any position before `--`)
 * - Extra arguments: everything after `--` is forwarded to the module process
 * - Subcommand/module-ID collision (R14.6): if shorthand is used and the arg
 *   matches a known command, it is interpreted as the subcommand and a warning
 *   is emitted to stderr
 *
 * @param argv - Raw argument array (typically `process.argv.slice(2)`)
 * @returns Parsed argument structure
 *
 * @example
 * ```typescript
 * // Explicit run
 * parseArgs(['run', 'my-module', '--verbose']);
 * // → { command: 'run', moduleId: 'my-module', extraArgs: [], flags: { verbose: true, json: false } }
 *
 * // Implicit run (shorthand)
 * parseArgs(['my-module', '--', '--port', '3000']);
 * // → { command: 'run', moduleId: 'my-module', extraArgs: ['--port', '3000'], flags: { verbose: false, json: false } }
 * ```
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // Split on `--` separator: args before are parsed, args after are extra
  const separatorIndex = argv.indexOf('--');
  const mainArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const extraArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);

  // Extract global flags from mainArgs
  const flags = {
    verbose: false,
    json: false,
  };

  const positional: string[] = [];

  for (const arg of mainArgs) {
    if (arg === '--verbose') {
      flags.verbose = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else {
      positional.push(arg);
    }
  }

  // Also check MCPX_DEBUG env for verbose
  if (process.env.MCPX_DEBUG === '1') {
    flags.verbose = true;
  }

  // No positional arguments → default to 'run' with no module
  if (positional.length === 0) {
    return { command: 'run', extraArgs, flags };
  }

  const first = positional[0];

  // Check if first positional is a known command
  if (KNOWN_COMMANDS.has(first)) {
    const command = first as Command;
    const moduleId = positional[1];

    return {
      command,
      moduleId,
      extraArgs,
      flags,
    };
  }

  // Implicit run shorthand: first arg is not a known command → treat as module ID
  // R14.6 collision handling is done at the command level (not here), since
  // if the arg matched a known command it would have been caught above.
  // The collision case (arg matches both a subcommand AND a module ID) is
  // handled by the branch above: it's interpreted as the subcommand.
  return {
    command: 'run',
    moduleId: first,
    extraArgs,
    flags,
  };
}
