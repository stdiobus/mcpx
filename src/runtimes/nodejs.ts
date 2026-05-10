/**
 * Node.js runtime plugin for mcpx.
 *
 * Handles launching Node.js modules with appropriate commands:
 * - `.ts` files → `npx tsx <entry>`
 * - `.js` / `.mjs` files → `node <entry>`
 *
 * Validates entry file existence and extension, checks for
 * `node` and `npx` availability in PATH.
 *
 * @module runtimes/nodejs
 * @see Requirement 6.1 — TypeScript execution via npx tsx
 * @see Requirement 6.2 — JavaScript execution via node
 * @see Requirement 6.3 — Working directory set to module directory
 * @see Requirement 6.4 — Error if node not found
 * @see Requirement 6.5 — Error if npx not found for .ts
 * @see Requirement 6.6 — Error if entry file missing
 * @see Requirement 6.7 — Error for unsupported extensions
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import type { RuntimePlugin, RuntimeCheck, ExecDescriptor } from './plugin.js';
import type { ResolvedModule } from '../core/manifest.js';
import { RuntimeError, ManifestError } from '../core/errors.js';

/**
 * Supported file extensions for the Node.js runtime.
 */
const SUPPORTED_EXTENSIONS = ['.ts', '.js', '.mjs'] as const;

/**
 * Detect a command's version by running `<command> --version`.
 *
 * @param command - The command to check (e.g., "node", "npx")
 * @returns The version string if available, or undefined if the command is not found
 */
function detectVersion(command: string): string | undefined {
  try {
    const output = execFileSync(command, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return output.trim().replace(/^v/, '');
  } catch {
    return undefined;
  }
}

/**
 * Check if a command is available in the system PATH.
 *
 * @param command - The command to check
 * @returns true if the command is available
 */
function isCommandAvailable(command: string): boolean {
  return detectVersion(command) !== undefined;
}

/**
 * Node.js runtime plugin.
 *
 * Implements the RuntimePlugin interface for launching Node.js modules.
 * Supports TypeScript (.ts) via `npx tsx` and JavaScript (.js, .mjs) via `node`.
 */
export class NodejsPlugin implements RuntimePlugin {
  readonly name = 'nodejs';
  readonly supportedExtensions = [...SUPPORTED_EXTENSIONS];

  /**
   * Check if Node.js is available on the system.
   *
   * Detects `node` in PATH and reports its version. If not found,
   * provides a platform-appropriate install suggestion.
   */
  async checkAvailability(): Promise<RuntimeCheck> {
    const version = detectVersion('node');

    if (version) {
      return {
        available: true,
        tool: 'node',
        version,
      };
    }

    return {
      available: false,
      tool: 'node',
      suggestion: 'Install Node.js: https://nodejs.org or run: brew install node',
    };
  }

  /**
   * Build the execution descriptor for a Node.js module.
   *
   * Determines the appropriate command based on the entry file extension:
   * - `.ts` → `npx tsx <entry> <args>`
   * - `.js` / `.mjs` → `node <entry> <args>`
   *
   * Validates:
   * - Entry file extension is supported (.ts, .js, .mjs)
   * - Entry file exists at the resolved path
   * - Required tools (node, npx) are available in PATH
   *
   * @param module - The fully resolved module with manifest and directory path
   * @returns The execution descriptor for process replacement
   * @throws {ManifestError} If the entry file extension is unsupported
   * @throws {RuntimeError} If the entry file doesn't exist or required tools are missing
   */
  buildCommand(module: ResolvedModule): ExecDescriptor {
    const { manifest, dir } = module;
    const entry = manifest.entry;
    const ext = extname(entry).toLowerCase();

    // R6.7: Validate extension
    if (!SUPPORTED_EXTENSIONS.includes(ext as typeof SUPPORTED_EXTENSIONS[number])) {
      throw new ManifestError(
        `Unsupported file extension "${ext}" for Node.js runtime in entry "${entry}"`,
        `Use one of the supported extensions: ${SUPPORTED_EXTENSIONS.join(', ')}`,
      );
    }

    // R6.6: Validate entry file exists
    const entryPath = resolve(dir, entry);
    if (!existsSync(entryPath)) {
      throw new RuntimeError(
        `Entry file not found: ${entryPath}`,
        `Verify the "entry" field in module.json points to an existing file`,
      );
    }

    // R6.4: Check node availability
    if (!isCommandAvailable('node')) {
      throw new RuntimeError(
        'Node.js not found in PATH',
        'Install Node.js: https://nodejs.org or run: brew install node',
      );
    }

    // Build command based on extension
    const args = manifest.args ?? [];

    if (ext === '.ts') {
      // R6.5: Check npx availability for TypeScript
      if (!isCommandAvailable('npx')) {
        throw new RuntimeError(
          'npx not found in PATH (required for TypeScript execution)',
          'Install Node.js (includes npx): https://nodejs.org or run: brew install node',
        );
      }

      // R6.1: TypeScript → npx tsx <entry>
      return {
        command: 'npx',
        args: ['tsx', entry, ...args],
        cwd: dir, // R6.3
        env: {},
      };
    }

    // R6.2: JavaScript (.js, .mjs) → node <entry>
    return {
      command: 'node',
      args: [entry, ...args],
      cwd: dir, // R6.3
      env: {},
    };
  }
}
