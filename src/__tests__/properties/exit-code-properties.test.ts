/**
 * Property-based tests for exit code categorization invariants.
 *
 * Each test spawns a REAL mcpx subprocess (via the mcpx-runner.mjs script)
 * with various error scenarios and verifies that the correct exit code is
 * produced for each error category.
 *
 * Exit code mapping:
 * - 1: General/unknown errors (non-existent modules, bad MCPX_ROOT)
 * - 2: Manifest errors (missing fields, bad types, invalid JSON)
 * - 3: Runtime errors (missing entry file, unavailable runtime)
 *
 * **Validates: Requirements 16.6, 16.7, 16.8, 16.9**
 *
 * @module __tests__/properties/exit-code-properties
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tsxEsmNodeArgs } from '../helpers/tsx-node-args.js';

// --- Test Runner Helper ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the mcpx-runner.mjs script that exercises real mcpx code paths.
 */
const MCPX_RUNNER = resolve(__dirname, '../helpers/mcpx-runner.mjs');

/**
 * Spawns the mcpx runner as a real subprocess and returns the exit code.
 *
 * @param args - CLI arguments (e.g., ['run', 'module-id'])
 * @param env - Environment variables to set
 * @returns Object with stdout, stderr, and exitCode
 */
function spawnMcpxRunner(
  args: string[],
  env: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number | null } {
  const spawnEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...env,
  };

  // Remove undefined values
  for (const key of Object.keys(spawnEnv)) {
    if (spawnEnv[key] === undefined) {
      delete spawnEnv[key];
    }
  }

  try {
    const result = execFileSync('node', [...tsxEsmNodeArgs(), MCPX_RUNNER, ...args], {
      env: spawnEnv,
      timeout: 15_000,
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

// --- Filesystem Helpers ---

/**
 * Creates a temporary module root with a modules/ directory.
 */
function createTempRoot(): { root: string; modulesDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'mcpx-exitcode-'));
  const modulesDir = join(root, 'modules');
  mkdirSync(modulesDir, { recursive: true });
  return { root, modulesDir };
}

/**
 * Creates a module directory with the given module.json content (as a string).
 */
function createModuleWithRawManifest(
  modulesDir: string,
  moduleId: string,
  manifestContent: string,
): void {
  const moduleDir = join(modulesDir, moduleId);
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, 'module.json'), manifestContent, 'utf-8');
}

/**
 * Creates a module directory with a valid manifest but no entry file.
 */
function createModuleWithMissingEntry(
  modulesDir: string,
  moduleId: string,
  runtime: string = 'nodejs',
  entry: string = 'nonexistent-entry.ts',
): void {
  const manifest = {
    id: moduleId,
    name: `Test Module ${moduleId}`,
    runtime,
    entry,
  };
  const moduleDir = join(modulesDir, moduleId);
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, 'module.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

// --- Generators ---

/** Generator for valid module IDs (short, for filesystem compatibility). */
const validModuleIdArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/);

/** Generator for invalid JSON strings. */
const invalidJsonArb = fc.oneof(
  // Broken JSON with missing closing brace
  fc.constant('{broken'),
  // Truncated JSON
  fc.constant('{"id": "test"'),
  // Not JSON at all
  fc.string({ minLength: 1, maxLength: 50 }).filter(s => {
    try { JSON.parse(s); return false; } catch { return true; }
  }),
  // Empty string
  fc.constant(''),
  // Just a number
  fc.constant('42'),
  // Array instead of object
  fc.constant('[1, 2, 3]'),
  // Trailing comma
  fc.constant('{"id": "test",}'),
);

/**
 * Generator for manifests missing required fields.
 * Each generated object is missing exactly one required field.
 * The 'id' field is always set to a valid value (needed for directory matching).
 */
const manifestMissingFieldsArb = fc.oneof(
  // Missing 'name' — has id, runtime, entry but no name
  fc.constant({ runtime: 'nodejs', entry: 'index.ts' }),
  fc.constant({ runtime: 'python', entry: 'main.py' }),
  fc.constant({ runtime: 'shell', entry: 'run.sh' }),
  // Missing 'runtime' — has id, name, entry but no runtime
  fc.constant({ name: 'Test Module', entry: 'index.ts' }),
  fc.constant({ name: 'Another Module', entry: 'server.js' }),
  // Missing 'entry' — has id, name, runtime but no entry
  fc.constant({ name: 'Test Module', runtime: 'nodejs' }),
  fc.constant({ name: 'Another Module', runtime: 'python' }),
  fc.constant({ name: 'Shell Module', runtime: 'shell' }),
);

/**
 * Generator for manifests with invalid field types or values.
 * The 'id' field is always valid (needed for directory matching) — the
 * invalidity is in other fields.
 */
const manifestBadTypesArb = fc.oneof(
  // runtime is a number
  fc.constant({ id: 'test-mod', name: 'Test', runtime: 42, entry: 'index.ts' }),
  // entry is a boolean
  fc.constant({ id: 'test-mod', name: 'Test', runtime: 'nodejs', entry: true }),
  // name is null
  fc.constant({ id: 'test-mod', name: null, runtime: 'nodejs', entry: 'index.ts' }),
  // runtime is invalid value (not in enum)
  fc.constant({ id: 'test-mod', name: 'Test', runtime: 'java', entry: 'index.ts' }),
  // runtime is invalid value
  fc.constant({ id: 'test-mod', name: 'Test', runtime: 'ruby', entry: 'index.ts' }),
  // name is a number
  fc.constant({ id: 'test-mod', name: 123, runtime: 'nodejs', entry: 'index.ts' }),
  // entry is a number
  fc.constant({ id: 'test-mod', name: 'Test', runtime: 'nodejs', entry: 456 }),
  // runtime is empty string
  fc.constant({ id: 'test-mod', name: 'Test', runtime: '', entry: 'index.ts' }),
  // name is empty string (too short)
  fc.constant({ id: 'test-mod', name: '', runtime: 'nodejs', entry: 'index.ts' }),
  // entry is empty string
  fc.constant({ id: 'test-mod', name: 'Test', runtime: 'nodejs', entry: '' }),
);

/** Generator for valid runtimes. */
const validRuntimeArb = fc.constantFrom('nodejs', 'python', 'go', 'rust', 'shell', 'docker');

/** Generator for entry file names that won't exist. */
const nonexistentEntryArb = fc.oneof(
  fc.constant('nonexistent.ts'),
  fc.constant('missing-file.js'),
  fc.constant('no-such-file.py'),
  fc.constant('absent.go'),
  fc.constant('gone.sh'),
  fc.stringMatching(/^[a-z]{3,10}\.(ts|js|py|go|sh)$/).filter(s => s.length > 4),
);

describe('Exit Code Properties', () => {
  describe('Property: Manifest errors ALWAYS produce exit code 2', () => {
    /**
     * **Validates: Requirements 16.6**
     *
     * Invalid JSON in module.json → exit code 2
     */
    it('invalid JSON always produces exit code 2', () => {
      fc.assert(
        fc.property(invalidJsonArb, (badJson) => {
          const { root, modulesDir } = createTempRoot();
          try {
            const moduleId = 'test-mod';
            createModuleWithRawManifest(modulesDir, moduleId, badJson);

            const result = spawnMcpxRunner(['run', moduleId], { MCPX_ROOT: root });

            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('[mcpx]');
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }),
        { numRuns: 50 },
      );
    });

    /**
     * **Validates: Requirements 16.6**
     *
     * Manifests missing required fields → exit code 2
     */
    it('manifests missing required fields always produce exit code 2', () => {
      fc.assert(
        fc.property(manifestMissingFieldsArb, (partialManifest) => {
          const { root, modulesDir } = createTempRoot();
          try {
            // Use a fixed module ID for the directory name.
            // The manifest is written with id added but missing one other required field.
            const moduleId = 'test-mod';
            const manifestContent = JSON.stringify(
              { id: moduleId, ...partialManifest },
              null,
              2,
            );
            createModuleWithRawManifest(modulesDir, moduleId, manifestContent);

            const result = spawnMcpxRunner(['run', moduleId], { MCPX_ROOT: root });

            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('[mcpx]');
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }),
        { numRuns: 50 },
      );
    });

    /**
     * **Validates: Requirements 16.6**
     *
     * Manifests with invalid field types → exit code 2
     */
    it('manifests with bad field types always produce exit code 2', () => {
      fc.assert(
        fc.property(manifestBadTypesArb, (badManifest) => {
          const { root, modulesDir } = createTempRoot();
          try {
            const moduleId = 'test-mod';
            // Write the manifest as-is — the id is always 'test-mod' (valid)
            // but other fields have invalid types/values
            const manifestContent = JSON.stringify(badManifest, null, 2);
            createModuleWithRawManifest(modulesDir, moduleId, manifestContent);

            const result = spawnMcpxRunner(['run', moduleId], { MCPX_ROOT: root });

            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('[mcpx]');
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('Property: Runtime errors ALWAYS produce exit code 3', () => {
    /**
     * **Validates: Requirements 16.7**
     *
     * Modules with valid manifests but missing entry files → exit code 3
     */
    it('missing entry file always produces exit code 3', () => {
      fc.assert(
        fc.property(
          validRuntimeArb,
          nonexistentEntryArb,
          (runtime, entry) => {
            const { root, modulesDir } = createTempRoot();
            try {
              const moduleId = 'test-mod';
              createModuleWithMissingEntry(modulesDir, moduleId, runtime, entry);

              const result = spawnMcpxRunner(['run', moduleId], { MCPX_ROOT: root });

              expect(result.exitCode).toBe(3);
              expect(result.stderr).toContain('[mcpx]');
              expect(result.stderr).toContain('Entry file not found');
            } finally {
              rmSync(root, { recursive: true, force: true });
            }
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('Property: General errors ALWAYS produce exit code 1', () => {
    /**
     * **Validates: Requirements 16.9**
     *
     * Non-existent modules → exit code 1
     */
    it('non-existent module always produces exit code 1', () => {
      fc.assert(
        fc.property(validModuleIdArb, (moduleId) => {
          const { root } = createTempRoot();
          try {
            // Don't create any module — just try to run a non-existent one
            const result = spawnMcpxRunner(['run', moduleId], { MCPX_ROOT: root });

            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('[mcpx]');
            expect(result.stderr).toContain('not found');
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }),
        { numRuns: 50 },
      );
    });

    /**
     * **Validates: Requirements 16.9**
     *
     * Bad MCPX_ROOT (non-existent path) → exit code 1
     */
    it('non-existent MCPX_ROOT always produces exit code 1', () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^\/tmp\/mcpx-nonexistent-[a-z0-9]{5,15}$/),
          (badRoot) => {
            const result = spawnMcpxRunner(['run', 'any-module'], { MCPX_ROOT: badRoot });

            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('[mcpx]');
            expect(result.stderr).toContain('does not exist');
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('Property: No error category ever produces exit code 0', () => {
    /**
     * **Validates: Requirements 16.6, 16.7, 16.8, 16.9**
     *
     * All error scenarios → exitCode !== 0
     */
    it('all error scenarios produce non-zero exit codes', () => {
      // Combine all error scenario generators
      const errorScenarioArb = fc.oneof(
        // Manifest error: invalid JSON
        invalidJsonArb.map(json => ({
          type: 'invalid-json' as const,
          json,
        })),
        // Manifest error: missing fields
        manifestMissingFieldsArb.map(manifest => ({
          type: 'missing-fields' as const,
          manifest,
        })),
        // Runtime error: missing entry
        fc.tuple(validRuntimeArb, nonexistentEntryArb).map(([runtime, entry]) => ({
          type: 'missing-entry' as const,
          runtime,
          entry,
        })),
        // General error: non-existent module
        validModuleIdArb.map(id => ({
          type: 'nonexistent-module' as const,
          id,
        })),
        // General error: bad MCPX_ROOT
        fc.stringMatching(/^\/tmp\/mcpx-bad-[a-z0-9]{5,10}$/).map(path => ({
          type: 'bad-root' as const,
          path,
        })),
      );

      fc.assert(
        fc.property(errorScenarioArb, (scenario) => {
          let result: { stdout: string; stderr: string; exitCode: number | null };

          switch (scenario.type) {
            case 'invalid-json': {
              const { root, modulesDir } = createTempRoot();
              try {
                createModuleWithRawManifest(modulesDir, 'test-mod', scenario.json);
                result = spawnMcpxRunner(['run', 'test-mod'], { MCPX_ROOT: root });
              } finally {
                rmSync(root, { recursive: true, force: true });
              }
              break;
            }
            case 'missing-fields': {
              const { root, modulesDir } = createTempRoot();
              try {
                const content = JSON.stringify({ ...scenario.manifest, id: 'test-mod' }, null, 2);
                createModuleWithRawManifest(modulesDir, 'test-mod', content);
                result = spawnMcpxRunner(['run', 'test-mod'], { MCPX_ROOT: root });
              } finally {
                rmSync(root, { recursive: true, force: true });
              }
              break;
            }
            case 'missing-entry': {
              const { root, modulesDir } = createTempRoot();
              try {
                createModuleWithMissingEntry(modulesDir, 'test-mod', scenario.runtime, scenario.entry);
                result = spawnMcpxRunner(['run', 'test-mod'], { MCPX_ROOT: root });
              } finally {
                rmSync(root, { recursive: true, force: true });
              }
              break;
            }
            case 'nonexistent-module': {
              const { root } = createTempRoot();
              try {
                result = spawnMcpxRunner(['run', scenario.id], { MCPX_ROOT: root });
              } finally {
                rmSync(root, { recursive: true, force: true });
              }
              break;
            }
            case 'bad-root': {
              result = spawnMcpxRunner(['run', 'any-module'], { MCPX_ROOT: scenario.path });
              break;
            }
          }

          // The key invariant: no error scenario ever produces exit code 0
          expect(result!.exitCode).not.toBe(0);
          expect(result!.stderr).toContain('[mcpx]');
        }),
        { numRuns: 50 },
      );
    });
  });
});
