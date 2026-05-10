/**
 * Logger for mcpx diagnostic output.
 *
 * All diagnostic messages are written exclusively to stderr to maintain
 * stdio transparency (stdout is reserved for MCP protocol data).
 * Messages are prefixed with `[mcpx]` for easy filtering in mixed output.
 *
 * @module core/logger
 * @see Requirement 16.1 — Support --verbose flag for detailed diagnostic output to stderr
 * @see Requirement 16.3 — Prefix all diagnostic messages with [mcpx]
 */

/**
 * Supported log levels for diagnostic output.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured logger that writes diagnostic output to stderr.
 *
 * Supports verbose mode (enabled via `--verbose` flag or `MCPX_DEBUG=1`
 * environment variable) for detailed step-by-step resolution logging.
 *
 * All output goes to stderr only — stdout is never written to, preserving
 * stdio transparency for MCP protocol communication.
 *
 * @example
 * ```typescript
 * const logger = new Logger(true); // verbose mode
 * logger.debug('resolver', 'Module root resolved to /Users/etc/.ai');
 * logger.info('Found 3 modules');
 * logger.warn('Insecure permissions on .env file');
 * logger.error('Module not found: my-module', 'Run mcpx list to see available modules');
 * ```
 */
export class Logger {
  /** Whether verbose/debug output is enabled. */
  private verbose: boolean;

  /**
   * Create a new Logger instance.
   *
   * @param verbose - Enable verbose output. If not provided, falls back to
   *                  checking the `MCPX_DEBUG` environment variable (enabled when set to `"1"`).
   */
  constructor(verbose?: boolean) {
    this.verbose = verbose ?? process.env.MCPX_DEBUG === '1';
  }

  /**
   * Log a debug message with a step label.
   * Only outputs when verbose mode is enabled.
   *
   * @param step - The resolution step name (e.g., "resolver", "env-loader", "runtime")
   * @param msg - The debug message describing what happened
   */
  debug(step: string, msg: string): void {
    if (this.verbose) {
      this.write('debug', `[${step}] ${msg}`);
    }
  }

  /**
   * Log an informational message.
   * Always outputs regardless of verbose mode.
   *
   * @param msg - The informational message
   */
  info(msg: string): void {
    this.write('info', msg);
  }

  /**
   * Log a warning message.
   * Always outputs regardless of verbose mode.
   *
   * @param msg - The warning message
   */
  warn(msg: string): void {
    this.write('warn', msg);
  }

  /**
   * Log an error message with an optional suggested corrective action.
   * Always outputs regardless of verbose mode.
   *
   * @param msg - The error message
   * @param suggestion - Optional suggested fix for the user
   */
  error(msg: string, suggestion?: string): void {
    this.write('error', msg);
    if (suggestion) {
      this.write('error', `  → ${suggestion}`);
    }
  }

  /**
   * Write a formatted message to stderr with the [mcpx] prefix.
   *
   * @param _level - The log level (reserved for future filtering)
   * @param msg - The message to write
   */
  private write(_level: LogLevel, msg: string): void {
    process.stderr.write(`[mcpx] ${msg}\n`);
  }
}
