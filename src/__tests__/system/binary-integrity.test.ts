/**
 * System-level tests for built binary verification.
 *
 * Verifies the built package works as a real npm binary:
 * - Package structure (bin/mcpx shebang, dist/index.js, compiled modules)
 * - Real execution from bin (--help exits 0, run nonexistent exits non-zero)
 * - No runtime errors on import (dist/index.js loads without error)
 *
 * **Validates: Requirements 10.7, 13.2**
 *
 * @module __tests__/system/binary-integrity
 */

import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsxEsmNodeArgs } from '../helpers/tsx-node-args.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Root of the packages/mcpx directory */
// __dirname = <repo>/src/__tests__/system → go up 3 levels to reach repo root.
const PACKAGE_ROOT = resolve(__dirname, '../../..');

/** Path to the bin/mcpx shim */
const BIN_MCPX = resolve(PACKAGE_ROOT, 'bin/mcpx.js');

/** Path to the dist directory */
const DIST_DIR = resolve(PACKAGE_ROOT, 'out/dist');

/** Path to the dist/index.js entry */
const DIST_INDEX = resolve(DIST_DIR, 'index.js');

// --- Helper ---

/**
 * Spawns a node process and returns stdout, stderr, and exit code.
 */
function spawnNode(
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): { stdout: string; stderr: string; exitCode: number | null } {
  const { cwd, timeout = 15_000 } = options;
  try {
    const result = execFileSync('node', args, {
      cwd,
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    return {
      stdout: (result as unknown as Buffer).toString('utf-8'),
      stderr: '',
      exitCode: 0,
    };
  } catch (error: unknown) {
    const spawnError = error as {
      stdout?: Buffer;
      stderr?: Buffer;
      status?: number | null;
    };
    return {
      stdout: spawnError.stdout?.toString('utf-8') ?? '',
      stderr: spawnError.stderr?.toString('utf-8') ?? '',
      exitCode: spawnError.status ?? null,
    };
  }
}

describe('System: Binary Integrity', () => {
  describe('Package structure', () => {
    it('bin/mcpx exists and has shebang #!/usr/bin/env node', () => {
      expect(existsSync(BIN_MCPX)).toBe(true);

      const content = readFileSync(BIN_MCPX, 'utf-8');
      // On Windows checkouts, the file may have CRLF endings; normalize so the test is portable.
      const firstLine = content.split('\n')[0].replace(/\r$/, '');
      expect(firstLine).toBe('#!/usr/bin/env node');
    });

    it('out/dist/index.js exists after build', () => {
      expect(existsSync(DIST_INDEX)).toBe(true);

      // Verify it's a non-empty file
      const stat = statSync(DIST_INDEX);
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(0);
    });

    it('out/dist/ contains all bundled files', () => {
      expect(existsSync(DIST_DIR)).toBe(true);

      const entries = readdirSync(DIST_DIR);

      // Verify expected bundle files exist
      expect(entries).toContain('index.js');
      expect(entries).toContain('index.cjs');
      expect(entries).toContain('cli.js');
    });
  });

  describe('Real execution from bin', () => {
    it('node packages/mcpx/bin/mcpx --help exits 0', () => {
      // The bin/mcpx shim imports dist/index.js — it should load without error
      const result = spawnNode([BIN_MCPX, '--help']);

      expect(result.exitCode).toBe(0);
    });

    it('node mcpx-runner.mjs run nonexistent exits non-zero with error on stderr', () => {
      // Use the mcpx-runner which exercises the real compiled CLI code paths
      const MCPX_RUNNER = resolve(__dirname, '../helpers/mcpx-runner.mjs');
      const result = spawnNode([...tsxEsmNodeArgs(), MCPX_RUNNER, 'run', 'nonexistent-module-xyz'], {
        cwd: PACKAGE_ROOT,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.exitCode).not.toBeNull();
      // Should have error output on stderr
      expect(result.stderr.length).toBeGreaterThan(0);
      // stderr should reference the module name or indicate it wasn't found
      expect(result.stderr.toLowerCase()).toMatch(/nonexistent|not found|error/);
    });

    it('bin/mcpx loads without runtime import errors', () => {
      // Verify the bin shim can load the dist entry without crashing
      const result = spawnNode([BIN_MCPX]);

      expect(result.exitCode).toBe(0);
      // No error output on stderr (no import failures)
      expect(result.stderr).toBe('');
    });
  });

  describe('No runtime errors on import', () => {
    it('node -e "await import(dist/index.js)" exits 0', () => {
      // ESM import of the dist entry point should succeed without errors
      const importPath = pathToFileURL(DIST_INDEX).href;
      // Use dynamic import since the package is ESM (type: "module")
      const result = spawnNode(
        ['--input-type=module', '-e', `await import('${importPath}');`],
        { cwd: PACKAGE_ROOT },
      );

      expect(result.exitCode).toBe(0);
    });

    it('bundled modules can be imported without errors', () => {
      // Verify the bundled entry points can be imported
      const modules = [
        resolve(DIST_DIR, 'index.js'),
        resolve(DIST_DIR, 'cli.js'),
      ];

      for (const modulePath of modules) {
        const safePath = pathToFileURL(modulePath).href;
        const result = spawnNode(
          ['--input-type=module', '-e', `await import('${safePath}');`],
          { cwd: PACKAGE_ROOT },
        );

        expect(result.exitCode).toBe(0);
      }
    });
  });
});
