/**
 * Property-based tests for module discovery invariants.
 *
 * Tests use REAL filesystem operations (mkdtempSync, real module.json files)
 * to verify discovery properties hold across many random inputs.
 *
 * **Validates: Requirements 3.1, 3.2, 3.4, 3.5**
 *
 * @module __tests__/properties/discovery-properties
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { resolveModuleById, discoverAllModules, findDuplicateIds } from '../../core/resolver.js';
import { McpxError } from '../../core/errors.js';
import { createRealModuleRoot } from '../helpers/real-module-factory.js';

/**
 * Generates valid module IDs matching /^[a-z0-9][a-z0-9-]{0,19}$/
 * Kept short for filesystem compatibility.
 */
const validModuleId = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,19}$/).filter(id => id.length >= 1);

/**
 * Creates a minimal valid module.json content.
 */
function makeManifest(id: string): string {
  return JSON.stringify({
    id,
    name: `Module ${id}`,
    runtime: 'nodejs',
    entry: 'index.ts',
  }, null, 2) + '\n';
}

describe('Module Discovery Properties', () => {
  /**
   * Property: Discovery is deterministic — same root + same id → same result, always.
   *
   * **Validates: Requirements 3.1, 3.2**
   */
  it('discovery is deterministic: same root + same id → same result', () => {
    fc.assert(
      fc.property(validModuleId, (moduleId) => {
        const { root, modulesDir } = createRealModuleRoot();
        try {
          // Create a real module directory with a valid manifest
          const moduleDir = join(modulesDir, moduleId);
          mkdirSync(moduleDir, { recursive: true });
          writeFileSync(join(moduleDir, 'module.json'), makeManifest(moduleId));

          // Call resolveModuleById 50 times and verify identical results
          const firstResult = resolveModuleById(moduleId, root);
          for (let i = 1; i < 50; i++) {
            const result = resolveModuleById(moduleId, root);
            expect(result.dir).toBe(firstResult.dir);
            expect(result.manifestPath).toBe(firstResult.manifestPath);
            expect(result.manifest.id).toBe(firstResult.manifest.id);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property: Exact directory match takes priority over id-field scan.
   *
   * Create both: directory named X with id=X, AND directory named Y with id=X.
   * Verify: directory X is always found (exact match wins).
   *
   * **Validates: Requirements 3.1, 3.2**
   */
  it('exact directory match takes priority over id-field scan', () => {
    fc.assert(
      fc.property(
        validModuleId,
        validModuleId.filter(id => id.length >= 2),
        (moduleId, otherDirName) => {
          // Ensure the other directory name is different from the module ID
          fc.pre(otherDirName !== moduleId);

          const { root, modulesDir } = createRealModuleRoot();
          try {
            // Create directory named moduleId with id=moduleId (exact match)
            const exactDir = join(modulesDir, moduleId);
            mkdirSync(exactDir, { recursive: true });
            writeFileSync(join(exactDir, 'module.json'), makeManifest(moduleId));

            // Create directory named otherDirName with id=moduleId (id-field match)
            const otherDir = join(modulesDir, otherDirName);
            mkdirSync(otherDir, { recursive: true });
            writeFileSync(join(otherDir, 'module.json'), makeManifest(moduleId));

            // Resolve should always find the exact directory match
            const result = resolveModuleById(moduleId, root);
            expect(result.dir).toBe(exactDir);
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: Duplicate IDs always produce error.
   *
   * Create N directories (all with different names that DON'T match the target ID)
   * but all with the same id field in their module.json. Since no exact directory
   * name match exists, the scan phase detects duplicates and throws.
   *
   * **Validates: Requirements 3.4**
   */
  it('duplicate IDs always produce error when no exact directory match exists', () => {
    fc.assert(
      fc.property(
        validModuleId,
        fc.integer({ min: 2, max: 10 }),
        (moduleId, numDirs) => {
          const { root, modulesDir } = createRealModuleRoot();
          try {
            // Create N directories with different names but same id field
            // Directory names must NOT match moduleId to avoid exact match short-circuit
            for (let i = 0; i < numDirs; i++) {
              const dirName = `other-dir-${i}-${moduleId.slice(0, 5)}`;
              const dir = join(modulesDir, dirName);
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, 'module.json'), makeManifest(moduleId));
            }

            // Resolving should throw McpxError with 'manifest' code
            expect(() => resolveModuleById(moduleId, root)).toThrow(McpxError);
            try {
              resolveModuleById(moduleId, root);
            } catch (err) {
              expect(err).toBeInstanceOf(McpxError);
              expect((err as McpxError).code).toBe('manifest');
              expect((err as McpxError).message).toContain('Duplicate');
            }
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: Non-existent ID always produces error listing available modules.
   *
   * Create 1-20 modules with random valid IDs, then query a non-existent ID.
   * The error should list the available module IDs.
   *
   * **Validates: Requirements 3.5**
   */
  it('non-existent ID always produces error listing available modules', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(validModuleId, { minLength: 1, maxLength: 20 }),
        validModuleId,
        (existingIds, queryId) => {
          // Ensure the query ID is not in the existing set
          fc.pre(!existingIds.includes(queryId));

          const { root, modulesDir } = createRealModuleRoot();
          try {
            // Create real modules for each existing ID
            for (const id of existingIds) {
              const dir = join(modulesDir, id);
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, 'module.json'), makeManifest(id));
            }

            // Querying a non-existent ID should throw
            expect(() => resolveModuleById(queryId, root)).toThrow(McpxError);
            try {
              resolveModuleById(queryId, root);
            } catch (err) {
              expect(err).toBeInstanceOf(McpxError);
              expect((err as McpxError).code).toBe('general');
              const message = (err as McpxError).message;
              expect(message).toContain(queryId);
              // Error should list available module IDs
              for (const id of existingIds) {
                expect(message).toContain(id);
              }
            }
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
