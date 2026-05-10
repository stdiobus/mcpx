import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { validateManifest, VALID_RUNTIMES, MANIFEST_CONSTRAINTS } from '../../core/manifest.js';

/**
 * Property-based tests for manifest validation invariants.
 * Validates: Requirements 1.1, 1.2, 1.3, 1.5, 1.6, 1.7
 */

// --- Generators ---

/** Generator for valid module IDs matching ^[a-z0-9][a-z0-9-]{0,127}$ */
const validIdArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,127}$/);

/** Generator for valid runtime values */
const validRuntimeArb = fc.constantFrom(...VALID_RUNTIMES);

/** Generator for valid module names (1-256 chars, non-empty) */
const validNameArb = fc.string({ minLength: 1, maxLength: 256 });

/** Generator for valid entry strings (non-empty) */
const validEntryArb = fc.string({ minLength: 1, maxLength: 256 });

/** Generator for a valid manifest object with all required fields */
const validManifestArb = fc.record({
  id: validIdArb,
  name: validNameArb,
  runtime: validRuntimeArb,
  entry: validEntryArb,
});

/** Generator for invalid IDs: uppercase, special chars, or >128 chars */
const invalidIdArb = fc.oneof(
  // IDs with uppercase letters (must contain at least one uppercase)
  fc.stringMatching(/^[A-Z][a-zA-Z0-9-]{0,10}$/),
  // IDs containing at least one special character
  fc.stringMatching(/^[a-z][a-z0-9-]{0,5}[!@#$%^&*()][a-z0-9-]{0,5}$/),
  // IDs that are too long (>128 chars): generate exactly 129 valid chars
  fc.constant('a'.repeat(129)),
  // Empty string
  fc.constant(''),
  // IDs starting with hyphen
  fc.stringMatching(/^-[a-z0-9-]{0,10}$/),
);

/** Generator for invalid runtimes: random strings not in the enum */
const invalidRuntimeArb = fc.string({ minLength: 1, maxLength: 50 }).filter(
  s => !(VALID_RUNTIMES as readonly string[]).includes(s)
);

describe('Manifest Validation Properties', () => {
  describe('Property: Valid manifests always pass validation', () => {
    it('any manifest with valid required fields passes validation', () => {
      /**
       * **Validates: Requirements 1.1, 1.2**
       */
      fc.assert(
        fc.property(validManifestArb, (manifest) => {
          const result = validateManifest(manifest);
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
          expect(result.manifest).toBeDefined();
          expect(result.manifest!.id).toBe(manifest.id);
          expect(result.manifest!.name).toBe(manifest.name);
          expect(result.manifest!.runtime).toBe(manifest.runtime);
          expect(result.manifest!.entry).toBe(manifest.entry);
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('Property: Round-trip consistency', () => {
    it('JSON.parse(JSON.stringify(manifest)) produces identical validation result', () => {
      /**
       * **Validates: Requirements 1.6**
       */
      fc.assert(
        fc.property(validManifestArb, (manifest) => {
          const result1 = validateManifest(manifest);
          const roundTripped = JSON.parse(JSON.stringify(manifest));
          const result2 = validateManifest(roundTripped);

          expect(result1.valid).toBe(result2.valid);
          expect(result1.errors.length).toBe(result2.errors.length);
          if (result1.valid && result2.valid) {
            expect(result1.manifest!.id).toBe(result2.manifest!.id);
            expect(result1.manifest!.name).toBe(result2.manifest!.name);
            expect(result1.manifest!.runtime).toBe(result2.manifest!.runtime);
            expect(result1.manifest!.entry).toBe(result2.manifest!.entry);
          }
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('Property: Invalid id pattern always rejected', () => {
    it('IDs with uppercase, special chars, or >128 chars always produce validation errors', () => {
      /**
       * **Validates: Requirements 1.1, 1.5**
       */
      fc.assert(
        fc.property(invalidIdArb, (badId) => {
          const manifest = {
            id: badId,
            name: 'Test Module',
            runtime: 'nodejs',
            entry: 'index.ts',
          };
          const result = validateManifest(manifest);
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
          const idErrors = result.errors.filter(e => e.field === 'id');
          expect(idErrors.length).toBeGreaterThan(0);
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('Property: Invalid runtime always rejected', () => {
    it('random strings not in the runtime enum always produce validation errors', () => {
      /**
       * **Validates: Requirements 1.3**
       */
      fc.assert(
        fc.property(invalidRuntimeArb, (badRuntime) => {
          const manifest = {
            id: 'valid-module',
            name: 'Test Module',
            runtime: badRuntime,
            entry: 'index.ts',
          };
          const result = validateManifest(manifest);
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
          const runtimeErrors = result.errors.filter(e => e.field === 'runtime');
          expect(runtimeErrors.length).toBeGreaterThan(0);
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('Property: Extra fields never cause errors', () => {
    it('adding random extra keys to a valid manifest still passes validation', () => {
      /**
       * **Validates: Requirements 1.7**
       */
      const manifestWithExtrasArb = fc.tuple(
        validManifestArb,
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 20 }).filter(
            k => !['id', 'name', 'runtime', 'entry', 'env', 'args', 'description', 'version', 'dependencies'].includes(k)
          ),
          fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))
        )
      );

      fc.assert(
        fc.property(manifestWithExtrasArb, ([manifest, extras]) => {
          const manifestWithExtras = { ...manifest, ...extras };
          const result = validateManifest(manifestWithExtras);
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
          expect(result.manifest).toBeDefined();
        }),
        { numRuns: 500 }
      );
    });
  });
});
