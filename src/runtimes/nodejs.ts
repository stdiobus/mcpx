/**
 * Node.js runtime plugin for mcpx.
 *
 * Handles launching Node.js modules with appropriate commands:
 * - `.ts` files → `node --import tsx/esm -e "import(<file://...>)"`
 * - `.js` / `.mjs` files → `node <entry>`
 *
 * Validates entry file existence and extension, checks for
 * `node` availability in PATH.
 *
 * @module runtimes/nodejs
 * @see Requirement 6.1 — TypeScript execution via tsx
 * @see Requirement 6.2 — JavaScript execution via node
 * @see Requirement 6.3 — Working directory set to module directory
 * @see Requirement 6.4 — Error if node not found
 * @see Requirement 6.6 — Error if entry file missing
 * @see Requirement 6.7 — Error for unsupported extensions
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
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
 * Check whether the local `tsx` package is resolvable.
 * We prefer `node --import tsx/esm` over `npx tsx` to avoid IPC requirements
 * in restricted environments (and to behave consistently across platforms).
 */
function isTsxImportAvailable(): boolean {
  try {
    const req = createRequire(import.meta.url);
    // "tsx/esm" is what we use at runtime.
    req.resolve('tsx/esm');
    return true;
  } catch {
    return false;
  }
}

function resolveTsxImportPath(): string {
  const req = createRequire(import.meta.url);
  return req.resolve('tsx/esm');
}

function isTsNodeEsmAvailable(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req.resolve('ts-node/esm');
    return true;
  } catch {
    return false;
  }
}

function resolveTsNodeEsmPath(): string {
  const req = createRequire(import.meta.url);
  return req.resolve('ts-node/esm');
}

/**
 * Node.js runtime plugin.
 *
 * Implements the RuntimePlugin interface for launching Node.js modules.
 * Supports TypeScript (.ts) via `node --import tsx/esm` (ESM import) and JavaScript (.js, .mjs) via `node`.
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
   * - `.ts` → `node --import tsx/esm -e "import(<file://...>)" <args>`
   * - `.js` / `.mjs` → `node <entry> <args>`
   *
   * Validates:
   * - Entry file extension is supported (.ts, .js, .mjs)
   * - Entry file exists at the resolved path
   * - Required tools (node) are available in PATH
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
      const canUseTsNode = isTsNodeEsmAvailable();
      const canUseTsx = isTsxImportAvailable();
      if (!canUseTsNode && !canUseTsx) {
        throw new RuntimeError(
          'No TypeScript loader is available (required for .ts execution)',
          'Install dependencies (ts-node or tsx) or use a JavaScript entry (.js/.mjs)',
        );
      }

      // Prefer ts-node's ESM loader when available; it is more predictable across Node versions.
      if (canUseTsNode) {
        return {
          command: 'node',
          args: ['--loader', resolveTsNodeEsmPath(), entry, ...args],
          cwd: dir, // R6.3
          env: {},
        };
      }

      // Fallback: tsx ESM loader.
      const entryUrl = pathToFileURL(resolve(dir, entry)).href;
      const importExpr = `import(${JSON.stringify(entryUrl)})`;
      return {
        command: 'node',
        args: ['--import', resolveTsxImportPath(), '-e', importExpr, ...args],
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
