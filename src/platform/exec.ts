/**
 * Platform-aware exec/spawn for mcpx.
 *
 * Provides cross-platform process execution with full stdio transparency.
 * On Unix, uses `spawnSync` with `stdio: 'inherit'` to achieve transparent
 * passthrough (true `exec` replacement isn't directly available in Node.js).
 * On Windows, uses `spawnSync` with `{ stdio: 'inherit', shell: true }`.
 *
 * Key invariants:
 * - mcpx NEVER writes to stdout (reserved for MCP protocol)
 * - mcpx NEVER reads from or buffers stdin
 * - The child process inherits stdin, stdout, stderr unmodified
 * - The child's exit code is propagated to the parent process
 * - Exec failures produce descriptive errors to stderr
 *
 * @module platform/exec
 * @see Requirement 4.1 — Use exec/platform equivalent for direct stdio passthrough
 * @see Requirement 4.2 — All diagnostic output exclusively to stderr
 * @see Requirement 4.3 — Never write to stdout
 * @see Requirement 4.4 — Never read from or buffer stdin
 * @see Requirement 4.5 — Inherit stdio file descriptors, propagate exit code
 * @see Requirement 4.6 — Report descriptive error to stderr on exec failure
 * @see Requirement 4.7 — No intermediate process between MCP client and module
 * @see Requirement 13.4 — Windows uses spawn with { stdio: 'inherit', shell: true }
 * @see Requirement 18.5 — Capture stderr on early exit within 2 seconds
 */

import { spawnSync } from 'node:child_process';
import type { ExecDescriptor } from '../runtimes/plugin.js';
import { RuntimeError } from '../core/errors.js';
import { Logger } from '../core/logger.js';
import {
  EARLY_EXIT_STDERR_MAX_BYTES,
  EARLY_EXIT_THRESHOLD_MS,
  displayEarlyExitMessage,
} from '../core/degradation.js';

/**
 * Whether the current platform is Windows.
 */
const isWindows = process.platform === 'win32';

/**
 * Execute a module process with full stdio transparency.
 *
 * Replaces the current process behavior by spawning the target command
 * synchronously with inherited stdio, then exiting with the child's
 * exit code. This ensures:
 * - No buffering or modification of stdin/stdout/stderr
 * - The MCP client sees the module's stdio directly
 * - The exit code is faithfully propagated
 *
 * On failure (command not found, permission denied, etc.), throws a
 * `RuntimeError` with a descriptive message and suggestion.
 *
 * @param descriptor - The execution descriptor from a runtime plugin,
 *                     containing command, args, cwd, and env.
 * @throws {RuntimeError} If the exec fails (ENOENT, EACCES, etc.)
 *
 * @example
 * ```typescript
 * import { execModule } from './platform/exec.js';
 *
 * const descriptor: ExecDescriptor = {
 *   command: 'node',
 *   args: ['server.js', '--port', '3000'],
 *   cwd: '/path/to/module',
 *   env: { NODE_ENV: 'production', API_KEY: 'sk-...' },
 * };
 *
 * execModule(descriptor); // never returns on success — process.exit is called
 * ```
 */
export function execModule(descriptor: ExecDescriptor): never {
  const { command, args, cwd, env } = descriptor;

  // Merge descriptor env with current process env.
  // Descriptor env takes precedence for module-specific variables,
  // but we preserve the full inherited environment.
  const mergedEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
  };

  const result = spawnSync(command, args, {
    cwd,
    env: mergedEnv,
    stdio: 'inherit',
    // On Windows, use shell to resolve commands via PATH and handle
    // extensions (.cmd, .bat, .exe) transparently.
    shell: isWindows,
    // On Windows, hide the subprocess window.
    windowsHide: true,
  });

  // Handle spawn errors (command not found, permission denied, etc.)
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    throw createExecError(command, cwd, err);
  }

  // If the child was terminated by a signal, map to a non-zero exit code.
  // Convention: 128 + signal number (matching bash behavior).
  if (result.signal) {
    const signalCode = signalToCode(result.signal);
    process.exit(128 + signalCode);
  }

  // Propagate the child's exit code.
  const exitCode = result.status ?? 1;
  process.exit(exitCode);
}

/**
 * Create a descriptive RuntimeError from a spawn failure.
 *
 * Maps common errno codes to human-readable messages with actionable
 * suggestions for the user.
 *
 * @param command - The command that failed to execute
 * @param cwd - The working directory where execution was attempted
 * @param err - The underlying Node.js error
 * @returns A RuntimeError with descriptive message and suggestion
 */
function createExecError(
  command: string,
  cwd: string,
  err: NodeJS.ErrnoException,
): RuntimeError {
  switch (err.code) {
    case 'ENOENT':
      return new RuntimeError(
        `Command not found: "${command}" (in ${cwd})`,
        `Ensure "${command}" is installed and available in your PATH`,
      );

    case 'EACCES':
      return new RuntimeError(
        `Permission denied: "${command}" (in ${cwd})`,
        `Check file permissions: chmod +x ${command}`,
      );

    case 'EPERM':
      return new RuntimeError(
        `Operation not permitted: "${command}" (in ${cwd})`,
        `Check system permissions or run with appropriate privileges`,
      );

    default:
      return new RuntimeError(
        `Failed to execute "${command}" (in ${cwd}): ${err.message}`,
        `Verify the command exists and is executable`,
      );
  }
}

/**
 * Map a signal name to its numeric code.
 *
 * Uses Node.js `os.constants.signals` when available, with common
 * fallback values for well-known signals.
 *
 * @param signal - The signal name (e.g., "SIGTERM", "SIGKILL")
 * @returns The numeric signal code
 */
function signalToCode(signal: NodeJS.Signals): number {
  // Use os.constants for accurate mapping
  const signals: Record<string, number | undefined> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGTERM: 15,
  };

  return signals[signal] ?? 15; // Default to SIGTERM code
}

/**
 * Module metadata needed for early exit diagnostics.
 */
export interface ModuleInfo {
  /** The module's ID from its manifest. */
  id: string;
  /** The runtime used to launch the module. */
  runtime: string;
  /** The entry file path from the manifest. */
  entry: string;
}

/**
 * Execute a module process with early exit detection.
 *
 * Similar to `execModule`, but captures stderr output when the module
 * process exits with a non-zero code within 2 seconds of launch.
 * This helps users debug startup failures by showing the module's
 * error output.
 *
 * When the process exits quickly with a non-zero code, up to 4096 bytes
 * of stderr are captured and displayed along with module metadata.
 *
 * For long-running processes (those that run longer than 2 seconds),
 * this behaves identically to `execModule` — stderr is inherited directly.
 *
 * @param descriptor - The execution descriptor from a runtime plugin
 * @param moduleInfo - Module metadata for diagnostic messages
 * @param logger - Logger instance for diagnostic output
 * @throws {RuntimeError} If the exec fails (ENOENT, EACCES, etc.)
 *
 * @see Requirement 18.5 — Capture up to 4096 bytes of stderr on early exit
 */
export function execModuleWithEarlyExitDetection(
  descriptor: ExecDescriptor,
  moduleInfo: ModuleInfo,
  logger: Logger,
): never {
  const { command, args, cwd, env } = descriptor;

  const mergedEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
  };

  // Use piped stderr to capture output for early exit detection.
  // stdin is inherited (MCP protocol), stdout is inherited (MCP protocol),
  // stderr is piped so we can capture it for diagnostics.
  const startTime = Date.now();

  const result = spawnSync(command, args, {
    cwd,
    env: mergedEnv,
    stdio: ['inherit', 'inherit', 'pipe'],
    shell: isWindows,
    windowsHide: true,
    maxBuffer: EARLY_EXIT_STDERR_MAX_BYTES,
  });

  const elapsed = Date.now() - startTime;

  // Handle spawn errors (command not found, permission denied, etc.)
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    throw createExecError(command, cwd, err);
  }

  // Always forward captured stderr to the parent's stderr
  const stderrBuffer = result.stderr;
  let stderrOutput = '';
  if (stderrBuffer && stderrBuffer.length > 0) {
    stderrOutput = typeof stderrBuffer === 'string'
      ? stderrBuffer
      : stderrBuffer.slice(0, EARLY_EXIT_STDERR_MAX_BYTES).toString('utf-8');
    // Write the module's stderr to our stderr so it's visible
    process.stderr.write(stderrBuffer);
  }

  // If the child was terminated by a signal, map to a non-zero exit code.
  if (result.signal) {
    const signalCode = signalToCode(result.signal);
    process.exit(128 + signalCode);
  }

  const exitCode = result.status ?? 1;

  // Early exit detection: if the process exited within the threshold
  // with a non-zero code, display diagnostic information.
  if (exitCode !== 0 && elapsed < EARLY_EXIT_THRESHOLD_MS) {
    displayEarlyExitMessage(
      moduleInfo.id,
      moduleInfo.runtime,
      moduleInfo.entry,
      exitCode,
      stderrOutput,
      logger,
    );
  }

  process.exit(exitCode);
}
