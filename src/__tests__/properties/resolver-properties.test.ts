import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fc from 'fast-check';
import { resolveRoot } from '../../core/resolver.js';
import { McpxError } from '../../core/errors.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Property-based tests for root resolution invariants.
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 2.6
 */

// --- Helpers ---

/** Save and restore MCPX_ROOT around each test */
let originalMcpxRoot: string | undefined;
let originalArgv: string[];
let tempDirs: string[] = [];

function createTempDir(prefix = 'mcpx-resolver-prop-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Generator for valid directory name segments (alphanumeric + hyphens, no leading hyphen) */
const dirSegmentArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);

/** Generator for a random subdirectory path (1-3 segments deep) */
const subPathArb = fc.array(dirSegmentArb, { minLength: 1, maxLength: 3 }).map(
  (segments) => segments.join('/')
);

/** Generator for random non-existent path suffixes */
const nonExistentSuffixArb = fc.stringMatching(/^[a-z][a-z0-9-]{4,20}$/).map(
  (s) => `nonexistent-${s}-${Date.now()}`
);

describe('Root Resolution Properties', () => {
  beforeEach(() => {
    originalMcpxRoot = process.env.MCPX_ROOT;
    originalArgv = [...process.argv];
  });

  afterEach(() => {
    // Restore env
    if (originalMcpxRoot === undefined) {
      delete process.env.MCPX_ROOT;
    } else {
      process.env.MCPX_ROOT = originalMcpxRoot;
    }
    process.argv = originalArgv;

    // Clean up temp dirs
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs = [];
  });

  describe('Property: MCPX_ROOT always takes precedence when set and valid', () => {
    it('any valid directory set as MCPX_ROOT is returned by resolveRoot()', () => {
      /**
       * **Validates: Requirements 2.1**
       *
       * When MCPX_ROOT is set to a valid existing directory, resolveRoot()
       * must always return that directory regardless of other resolution methods.
       */
      fc.assert(
        fc.property(subPathArb, (subPath) => {
          const baseDir = createTempDir();
          const targetDir = join(baseDir, subPath);
          mkdirSync(targetDir, { recursive: true });

          process.env.MCPX_ROOT = targetDir;

          const result = resolveRoot();
          // resolve() normalizes the path; on macOS /var → /private/var via realpath
          expect(result).toBe(resolve(targetDir));
        }),
        { numRuns: 100 }
      );
    });

    it('MCPX_ROOT takes precedence even when script location has modules/', () => {
      /**
       * **Validates: Requirements 2.1**
       *
       * Even when a valid script location with modules/ exists,
       * MCPX_ROOT must still win.
       */
      fc.assert(
        fc.property(dirSegmentArb, (dirName) => {
          const baseDir = createTempDir();

          // Create a valid MCPX_ROOT target
          const envRoot = join(baseDir, 'env-root', dirName);
          mkdirSync(envRoot, { recursive: true });

          // Create a valid script location with modules/
          const scriptRoot = join(baseDir, 'script-root');
          const binDir = join(scriptRoot, 'bin');
          const modulesDir = join(scriptRoot, 'modules');
          mkdirSync(binDir, { recursive: true });
          mkdirSync(modulesDir);
          const scriptPath = join(binDir, 'mcpx');
          writeFileSync(scriptPath, '#!/usr/bin/env node');
          process.argv[1] = scriptPath;

          process.env.MCPX_ROOT = envRoot;

          const result = resolveRoot();
          expect(result).toBe(resolve(envRoot));
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property: Empty MCPX_ROOT is treated as unset', () => {
    it('empty string MCPX_ROOT never returns empty string and falls through', () => {
      /**
       * **Validates: Requirements 2.2**
       *
       * When MCPX_ROOT is set to "", it should be treated as unset.
       * The function should fall through to the next resolution method.
       * It should never return "" or a path derived from "".
       */
      fc.assert(
        fc.property(dirSegmentArb, (dirName) => {
          const baseDir = createTempDir();

          // Set MCPX_ROOT to empty string
          process.env.MCPX_ROOT = '';

          // Set up a valid script location so resolution can succeed
          const scriptRoot = join(baseDir, dirName);
          const binDir = join(scriptRoot, 'bin');
          const modulesDir = join(scriptRoot, 'modules');
          mkdirSync(binDir, { recursive: true });
          mkdirSync(modulesDir);
          const scriptPath = join(binDir, 'mcpx');
          writeFileSync(scriptPath, '#!/usr/bin/env node');
          process.argv[1] = scriptPath;

          const result = resolveRoot();

          // Result should NOT be empty string
          expect(result).not.toBe('');
          // Result should be the script-derived root (realpath resolves macOS symlinks)
          expect(result).toBe(realpathSync(scriptRoot));
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property: Relative MCPX_ROOT resolves against cwd', () => {
    it('relative paths are resolved to absolute paths based on process.cwd()', () => {
      /**
       * **Validates: Requirements 2.6**
       *
       * When MCPX_ROOT is set to a relative path, resolveRoot() must
       * resolve it against the current working directory and return
       * an absolute path.
       */
      const originalCwd = process.cwd();

      fc.assert(
        fc.property(subPathArb, (subPath) => {
          const baseDir = createTempDir();
          // Create the target directory inside baseDir
          const targetDir = join(baseDir, subPath);
          mkdirSync(targetDir, { recursive: true });

          // Change cwd to baseDir so relative path resolves correctly
          process.chdir(baseDir);

          // Set MCPX_ROOT to the relative path
          process.env.MCPX_ROOT = subPath;

          const result = resolveRoot();

          // Result must be absolute
          expect(isAbsolute(result)).toBe(true);

          // Result must equal the resolved absolute path
          // On macOS, realpath resolves /var → /private/var
          const expected = resolve(realpathSync(baseDir), subPath);
          expect(result).toBe(expected);
        }),
        { numRuns: 100 }
      );

      // Restore cwd
      process.chdir(originalCwd);
    });
  });

  describe('Property: Non-existent MCPX_ROOT always throws', () => {
    it('any non-existent path set as MCPX_ROOT causes McpxError to be thrown', () => {
      /**
       * **Validates: Requirements 2.3, 2.5**
       *
       * When MCPX_ROOT is set to a path that does not exist on the filesystem,
       * resolveRoot() must always throw a McpxError with category 'general'.
       */
      fc.assert(
        fc.property(nonExistentSuffixArb, (suffix) => {
          const baseDir = createTempDir();
          const nonExistentPath = join(baseDir, suffix);

          process.env.MCPX_ROOT = nonExistentPath;

          expect(() => resolveRoot()).toThrow(McpxError);

          try {
            resolveRoot();
          } catch (err) {
            const mcpxErr = err as McpxError;
            expect(mcpxErr.code).toBe('general');
            expect(mcpxErr.message).toContain('MCPX_ROOT');
            expect(mcpxErr.suggestion).toBeDefined();
          }
        }),
        { numRuns: 100 }
      );
    });

    it('deeply nested non-existent paths always throw', () => {
      /**
       * **Validates: Requirements 2.3, 2.5**
       *
       * Even deeply nested paths that don't exist must throw.
       */
      fc.assert(
        fc.property(
          fc.array(dirSegmentArb, { minLength: 2, maxLength: 5 }),
          (segments) => {
            const baseDir = createTempDir();
            // Only create the base, not the nested path
            const nonExistentPath = join(baseDir, ...segments, 'does-not-exist');

            process.env.MCPX_ROOT = nonExistentPath;

            expect(() => resolveRoot()).toThrow(McpxError);

            try {
              resolveRoot();
            } catch (err) {
              const mcpxErr = err as McpxError;
              expect(mcpxErr.code).toBe('general');
              expect(mcpxErr.exitCode).toBe(1);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
