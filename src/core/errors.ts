/**
 * Error class hierarchy for mcpx.
 *
 * Provides structured error types with exit codes that map to specific
 * failure categories, enabling consistent error reporting and process
 * exit behavior.
 *
 * Exit code mapping:
 * - 1: General/unknown errors
 * - 2: Manifest errors (missing fields, invalid JSON, bad values)
 * - 3: Runtime errors (tool not found, exec failed)
 * - 4: Environment variable errors (missing required var, .env parse error)
 *
 * @module core/errors
 * @see Requirement 16.6 — Exit code 2 for manifest errors
 * @see Requirement 16.7 — Exit code 3 for runtime errors
 * @see Requirement 16.8 — Exit code 4 for environment variable errors
 * @see Requirement 16.9 — Exit code 1 for general errors
 */

/**
 * Error category codes used to determine exit codes and error classification.
 */
export type ErrorCode = 'general' | 'manifest' | 'runtime' | 'environment';

/**
 * Maps error codes to process exit codes.
 */
export const EXIT_CODES: Record<ErrorCode, number> = {
  general: 1,
  manifest: 2,
  runtime: 3,
  environment: 4,
} as const;

/**
 * Base error class for all mcpx errors.
 *
 * Extends the native Error with an error code, exit code, and optional
 * suggestion for corrective action. All mcpx errors follow the pattern:
 *
 * ```
 * [mcpx] ERROR: <human-readable message>
 * [mcpx]   → <suggested fix>
 * ```
 */
export class McpxError extends Error {
  /** The error category code. */
  readonly code: ErrorCode;

  /** The process exit code to use when this error terminates the process. */
  readonly exitCode: number;

  /** Optional suggested corrective action for the user. */
  readonly suggestion?: string;

  constructor(code: ErrorCode, message: string, suggestion?: string) {
    super(message);
    this.name = 'McpxError';
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.suggestion = suggestion;
  }
}

/**
 * Error thrown when a module manifest is invalid or missing required fields.
 *
 * Exit code: 2
 *
 * @example
 * ```typescript
 * throw new ManifestError(
 *   'Missing required field "runtime" in /path/to/module.json',
 *   'Add a "runtime" field with one of: nodejs, python, go, rust, shell, docker'
 * );
 * ```
 */
export class ManifestError extends McpxError {
  constructor(message: string, suggestion?: string) {
    super('manifest', message, suggestion);
    this.name = 'ManifestError';
  }
}

/**
 * Error thrown when a runtime tool is unavailable or execution fails.
 *
 * Exit code: 3
 *
 * @example
 * ```typescript
 * throw new RuntimeError(
 *   'Node.js not found in PATH',
 *   'Install Node.js: https://nodejs.org or run: brew install node'
 * );
 * ```
 */
export class RuntimeError extends McpxError {
  constructor(message: string, suggestion?: string) {
    super('runtime', message, suggestion);
    this.name = 'RuntimeError';
  }
}

/**
 * Error thrown when environment variable resolution fails.
 *
 * Exit code: 4
 *
 * @example
 * ```typescript
 * throw new EnvironmentError(
 *   'Required environment variable "OPENAI_API_KEY" is not set',
 *   'Add OPENAI_API_KEY to ~/.ai/.env or the module .env file'
 * );
 * ```
 */
export class EnvironmentError extends McpxError {
  constructor(message: string, suggestion?: string) {
    super('environment', message, suggestion);
    this.name = 'EnvironmentError';
  }
}
