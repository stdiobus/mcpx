/**
 * Shell runtime plugin for mcpx.
 *
 * Handles launching shell-based MCP modules using `/bin/sh`.
 * Validates that the entry file exists before execution.
 * Sets working directory to the module's directory.
 *
 * @module runtimes/shell
 * @see Requirement 8.4 — Shell executes entry file using `/bin/sh`
 * @see Requirement 8.5 — Report error if entry file does not exist
 * @see Requirement 8.3 — Working directory set to module directory
 * @see Requirement 8.8 — Report error if `/bin/sh` is not available
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RuntimePlugin, RuntimeCheck, ExecDescriptor } from './plugin.js';
import type { ResolvedModule } from '../core/manifest.js';
import { RuntimeError } from '../core/errors.js';

/**
 * Shell runtime plugin.
 *
 * Launch strategy:
 * - Always use `/bin/sh <entry>` to execute the entry file.
 * - Validates entry file exists before building the command.
 *
 * Availability check verifies `/bin/sh` exists.
 */
export class ShellPlugin implements RuntimePlugin {
  readonly name = 'shell';
  readonly supportedExtensions = ['.sh'];

  /**
   * Check if `/bin/sh` is available on the system.
   */
  async checkAvailability(): Promise<RuntimeCheck> {
    if (existsSync('/bin/sh')) {
      try {
        const output = execFileSync('/bin/sh', ['--version'], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        });
        const version = output.trim().split('\n')[0] ?? undefined;
        return { available: true, tool: '/bin/sh', version };
      } catch {
        // /bin/sh exists but --version may not be supported (e.g., dash)
        return { available: true, tool: '/bin/sh' };
      }
    }

    return {
      available: false,
      tool: '/bin/sh',
      suggestion: '/bin/sh is not available on this system',
    };
  }

  /**
   * Build the execution descriptor for a shell module.
   *
   * Validates that the entry file exists, then builds a command
   * using `/bin/sh <entry>`.
   *
   * @param module - The resolved module with manifest and directory path.
   * @returns The execution descriptor for process replacement.
   * @throws {RuntimeError} If the entry file does not exist.
   */
  buildCommand(module: ResolvedModule): ExecDescriptor {
    const { manifest, dir } = module;
    const entryPath = resolve(dir, manifest.entry);
    const args = manifest.args ?? [];

    // Validate entry file exists
    if (!existsSync(entryPath)) {
      throw new RuntimeError(
        `Shell entry file not found: ${entryPath}`,
        `Ensure the file "${manifest.entry}" exists in the module directory: ${dir}`,
      );
    }

    return {
      command: '/bin/sh',
      args: [manifest.entry, ...args],
      cwd: dir,
      env: {},
    };
  }
}
