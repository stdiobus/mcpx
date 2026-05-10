/**
 * Go runtime plugin for mcpx.
 *
 * Handles launching Go-based MCP modules by detecting pre-built binaries
 * or falling back to `go run`. Sets working directory to the module's
 * directory for consistent behavior.
 *
 * @module runtimes/go
 * @see Requirement 8.1 — Go binary detection or `go run` fallback
 * @see Requirement 8.3 — Working directory set to module directory
 * @see Requirement 8.8 — Report error if `go` is not available
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RuntimePlugin, RuntimeCheck, ExecDescriptor } from './plugin.js';
import type { ResolvedModule } from '../core/manifest.js';
import { RuntimeError } from '../core/errors.js';

/**
 * Go runtime plugin.
 *
 * Launch strategy:
 * 1. If a pre-built binary exists at the entry path without extension, execute it directly.
 * 2. Otherwise, use `go run <entry>` to compile and run.
 *
 * Availability check verifies `go` is in PATH.
 */
export class GoPlugin implements RuntimePlugin {
  readonly name = 'go';
  readonly supportedExtensions = ['.go'];

  /**
   * Check if the `go` tool is available on the system.
   */
  async checkAvailability(): Promise<RuntimeCheck> {
    try {
      const output = execFileSync('go', ['version'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      const version = output.trim().replace(/^go version /, '');
      return { available: true, tool: 'go', version };
    } catch {
      return {
        available: false,
        tool: 'go',
        suggestion: 'Install Go: https://go.dev/dl/ or run: brew install go',
      };
    }
  }

  /**
   * Build the execution descriptor for a Go module.
   *
   * Checks for a pre-built binary at the entry path without extension.
   * If found, executes it directly. Otherwise falls back to `go run <entry>`.
   *
   * @param module - The resolved module with manifest and directory path.
   * @returns The execution descriptor for process replacement.
   * @throws {RuntimeError} If `go` is required but not available (checked externally).
   */
  buildCommand(module: ResolvedModule): ExecDescriptor {
    const { manifest, dir } = module;
    const entryPath = resolve(dir, manifest.entry);
    const args = manifest.args ?? [];

    // Check for pre-built binary (entry path without extension)
    const binaryPath = entryPath.replace(/\.[^.]+$/, '');
    if (existsSync(binaryPath)) {
      return {
        command: binaryPath,
        args: [...args],
        cwd: dir,
        env: {},
      };
    }

    // Fallback to `go run <entry>`
    return {
      command: 'go',
      args: ['run', manifest.entry, ...args],
      cwd: dir,
      env: {},
    };
  }
}
