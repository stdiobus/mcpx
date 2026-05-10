/**
 * Rust runtime plugin for mcpx.
 *
 * Handles launching Rust-based MCP modules by detecting pre-built binaries
 * in `target/release/` or falling back to `cargo run`. Sets working directory
 * to the module's directory for consistent behavior.
 *
 * @module runtimes/rust
 * @see Requirement 8.2 — Rust binary detection in target/release/ or `cargo run` fallback
 * @see Requirement 8.3 — Working directory set to module directory
 * @see Requirement 8.8 — Report error if `cargo` is not available
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RuntimePlugin, RuntimeCheck, ExecDescriptor } from './plugin.js';
import type { ResolvedModule } from '../core/manifest.js';
import { RuntimeError } from '../core/errors.js';

/**
 * Rust runtime plugin.
 *
 * Launch strategy:
 * 1. If a pre-built binary exists at `target/release/<module_id>`, execute it directly.
 * 2. Otherwise, use `cargo run` (with `--` separator before extra args).
 *
 * Availability check verifies `cargo` is in PATH.
 */
export class RustPlugin implements RuntimePlugin {
  readonly name = 'rust';
  readonly supportedExtensions = ['.rs'];

  /**
   * Check if the `cargo` tool is available on the system.
   */
  async checkAvailability(): Promise<RuntimeCheck> {
    try {
      const output = execFileSync('cargo', ['--version'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      const version = output.trim().replace(/^cargo /, '');
      return { available: true, tool: 'cargo', version };
    } catch {
      return {
        available: false,
        tool: 'cargo',
        suggestion: 'Install Rust: https://rustup.rs/ or run: curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh',
      };
    }
  }

  /**
   * Build the execution descriptor for a Rust module.
   *
   * Checks for a pre-built binary at `target/release/<module_id>`.
   * If found, executes it directly. Otherwise falls back to `cargo run`.
   *
   * @param module - The resolved module with manifest and directory path.
   * @returns The execution descriptor for process replacement.
   */
  buildCommand(module: ResolvedModule): ExecDescriptor {
    const { manifest, dir } = module;
    const args = manifest.args ?? [];

    // Check for pre-built binary in target/release/<id>
    const binaryPath = resolve(dir, 'target', 'release', manifest.id);
    if (existsSync(binaryPath)) {
      return {
        command: binaryPath,
        args: [...args],
        cwd: dir,
        env: {},
      };
    }

    // Fallback to `cargo run` with `--` separator before args
    const cargoArgs = ['run'];
    if (args.length > 0) {
      cargoArgs.push('--', ...args);
    }

    return {
      command: 'cargo',
      args: cargoArgs,
      cwd: dir,
      env: {},
    };
  }
}
