/**
 * Runtime plugin interfaces for mcpx.
 *
 * Defines the plugin architecture where each supported runtime (Node.js,
 * Python, Go, Rust, Shell, Docker) is an independent plugin that knows
 * how to check availability and build execution commands.
 *
 * @module runtimes/plugin
 * @see Requirement 10.6 — Runtime_Plugin architecture
 */

import type { ResolvedModule } from '../core/manifest.js';

/**
 * Describes the execution command to be used for launching a module.
 *
 * Contains all information needed to `exec` into the module process,
 * including the command binary, arguments, working directory, and
 * environment variables.
 */
export interface ExecDescriptor {
  /** The command/binary to execute (e.g., "node", "npx", "python3"). */
  command: string;

  /** Ordered array of arguments to pass to the command. */
  args: string[];

  /** Working directory for the process (absolute path to module directory). */
  cwd: string;

  /** Environment variables to set for the process. */
  env: Record<string, string>;
}

/**
 * Result of checking whether a runtime's tools are available on the system.
 */
export interface RuntimeCheck {
  /** Whether the runtime tool is available and usable. */
  available: boolean;

  /** Name of the tool that was checked (e.g., "node", "python3", "go"). */
  tool: string;

  /** Detected version of the tool, if available. */
  version?: string;

  /** Platform-specific install suggestion if the tool is not available. */
  suggestion?: string;
}

/**
 * Plugin interface for runtime-specific module launching.
 *
 * Each supported runtime implements this interface to provide:
 * - Availability checking (is the runtime installed?)
 * - Command building (how to launch a module with this runtime)
 *
 * @example
 * ```typescript
 * class NodejsPlugin implements RuntimePlugin {
 *   readonly name = 'nodejs';
 *   readonly supportedExtensions = ['.ts', '.js', '.mjs'];
 *
 *   async checkAvailability(): Promise<RuntimeCheck> {
 *     // Check if node is in PATH
 *   }
 *
 *   buildCommand(module: ResolvedModule): ExecDescriptor {
 *     // Return exec descriptor for node/npx tsx
 *   }
 * }
 * ```
 */
export interface RuntimePlugin {
  /** The runtime name matching the manifest `runtime` field. */
  readonly name: string;

  /** File extensions this runtime can handle (e.g., ['.ts', '.js', '.mjs']). */
  readonly supportedExtensions?: string[];

  /**
   * Check if this runtime's tools are available on the system.
   * Returns availability status, tool name, version, and install suggestion.
   */
  checkAvailability(): Promise<RuntimeCheck>;

  /**
   * Build the execution descriptor for launching a module with this runtime.
   * The descriptor contains the command, args, cwd, and env needed for exec.
   *
   * @param module - The fully resolved module with manifest and directory path.
   * @returns The execution descriptor for process replacement.
   */
  buildCommand(module: ResolvedModule): ExecDescriptor;
}
