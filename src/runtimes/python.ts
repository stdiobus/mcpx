/**
 * Python runtime plugin for mcpx.
 *
 * Supports launching Python MCP modules with the following strategy:
 * - If `pyproject.toml` exists in the module directory AND `uv` is in PATH → `uv run <entry>`
 * - Otherwise, fall back to `python3 <entry>`
 * - If `python3` is not found, fall back to `python <entry>`
 * - If neither is found, throw a RuntimeError
 *
 * @module runtimes/python
 * @see Requirement 7.1 — uv run when pyproject.toml exists
 * @see Requirement 7.2 — python3/python fallback
 * @see Requirement 7.3 — Set working directory to module dir
 * @see Requirement 7.4 — Error when no Python found
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { RuntimePlugin, RuntimeCheck, ExecDescriptor } from './plugin.js';
import type { ResolvedModule } from '../core/manifest.js';
import { RuntimeError } from '../core/errors.js';

/**
 * Checks if a command is available in the system PATH.
 * Returns the version string if found, or null if not available.
 */
function getToolVersion(tool: string): string | null {
  try {
    const output = execFileSync(tool, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Python runtime plugin.
 *
 * Implements the RuntimePlugin interface for Python modules.
 * Prefers `uv run` when a `pyproject.toml` is present and `uv` is available,
 * otherwise falls back to `python3` then `python`.
 */
export class PythonPlugin implements RuntimePlugin {
  readonly name = 'python';
  readonly supportedExtensions = ['.py'];

  /**
   * Check availability of Python tooling on the system.
   *
   * Checks for `uv`, `python3`, and `python` in order.
   * Returns the first available tool's info.
   */
  async checkAvailability(): Promise<RuntimeCheck> {
    // Check uv first
    const uvVersion = getToolVersion('uv');
    if (uvVersion) {
      return { available: true, tool: 'uv', version: uvVersion };
    }

    // Check python3
    const python3Version = getToolVersion('python3');
    if (python3Version) {
      return { available: true, tool: 'python3', version: python3Version };
    }

    // Check python
    const pythonVersion = getToolVersion('python');
    if (pythonVersion) {
      return { available: true, tool: 'python', version: pythonVersion };
    }

    return {
      available: false,
      tool: 'python',
      suggestion: 'Install Python: https://www.python.org/downloads/ or run: brew install python3',
    };
  }

  /**
   * Build the execution descriptor for a Python module.
   *
   * Strategy:
   * 1. If `pyproject.toml` exists in module dir AND `uv` is available → `uv run <entry>`
   * 2. Else if `python3` is available → `python3 <entry>`
   * 3. Else if `python` is available → `python <entry>`
   * 4. Otherwise throw RuntimeError
   *
   * @param module - The resolved module with manifest and directory path.
   * @returns ExecDescriptor with command, args, cwd, and env.
   * @throws RuntimeError if no Python interpreter is found.
   */
  buildCommand(module: ResolvedModule): ExecDescriptor {
    const entry = module.manifest.entry;
    const moduleDir = module.dir;
    const manifestArgs = module.manifest.args ?? [];

    // Check if pyproject.toml exists and uv is available
    const hasPyproject = existsSync(join(moduleDir, 'pyproject.toml'));
    const uvAvailable = getToolVersion('uv') !== null;

    if (hasPyproject && uvAvailable) {
      return {
        command: 'uv',
        args: ['run', entry, ...manifestArgs],
        cwd: moduleDir,
        // In restricted environments (CI sandboxes, locked-down home dirs),
        // uv may fail when it cannot write to ~/.cache/uv. Point uv's cache/state
        // to a writable location deterministically.
        env: {
          UV_CACHE_DIR: join(tmpdir(), 'mcpx-uv-cache'),
          UV_STATE_DIR: join(tmpdir(), 'mcpx-uv-state'),
        },
      };
    }

    // Fall back to python3
    const python3Available = getToolVersion('python3') !== null;
    if (python3Available) {
      return {
        command: 'python3',
        args: [entry, ...manifestArgs],
        cwd: moduleDir,
        env: {},
      };
    }

    // Fall back to python
    const pythonAvailable = getToolVersion('python') !== null;
    if (pythonAvailable) {
      return {
        command: 'python',
        args: [entry, ...manifestArgs],
        cwd: moduleDir,
        env: {},
      };
    }

    // No Python interpreter found
    throw new RuntimeError(
      'Python not found in PATH',
      'Install Python: https://www.python.org/downloads/ or run: brew install python3',
    );
  }
}
