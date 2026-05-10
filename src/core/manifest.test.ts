import { describe, it, expect } from '@jest/globals';
import { validateManifest, VALID_RUNTIMES, MANIFEST_CONSTRAINTS } from './manifest.js';

/**
 * Unit tests for manifest validation (task 6.4).
 * Validates: Requirements 1.1, 1.2, 1.3, 1.5, 1.6, 1.7
 */

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'my-module',
    name: 'My Module',
    runtime: 'nodejs',
    entry: 'index.ts',
    ...overrides,
  };
}

describe('validateManifest', () => {
  describe('valid manifests', () => {
    it('accepts a minimal valid manifest with only required fields', () => {
      const result = validateManifest(validManifest());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.manifest).toBeDefined();
      expect(result.manifest!.id).toBe('my-module');
    });

    it('accepts a manifest with all optional fields', () => {
      const result = validateManifest(validManifest({
        env: { API_KEY: 'default-value' },
        args: ['--port', '3000'],
        description: 'A test module',
        version: '1.0.0',
      }));
      expect(result.valid).toBe(true);
      expect(result.manifest!.env).toEqual({ API_KEY: 'default-value' });
      expect(result.manifest!.args).toEqual(['--port', '3000']);
      expect(result.manifest!.description).toBe('A test module');
      expect(result.manifest!.version).toBe('1.0.0');
    });

    it('ignores unrecognized fields without error (Requirement 1.7)', () => {
      const result = validateManifest(validManifest({
        customField: 'hello',
        anotherUnknown: 42,
        nested: { deep: true },
      }));
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts all valid runtime values', () => {
      for (const runtime of VALID_RUNTIMES) {
        const result = validateManifest(validManifest({ runtime }));
        expect(result.valid).toBe(true);
        expect(result.manifest!.runtime).toBe(runtime);
      }
    });

    it('accepts id with only lowercase alphanumeric and hyphens', () => {
      const result = validateManifest(validManifest({ id: 'a0-test-module-123' }));
      expect(result.valid).toBe(true);
    });

    it('accepts single character id', () => {
      const result = validateManifest(validManifest({ id: 'a' }));
      expect(result.valid).toBe(true);
    });

    it('accepts id at max length (128 chars)', () => {
      const id = 'a' + 'b'.repeat(127);
      const result = validateManifest(validManifest({ id }));
      expect(result.valid).toBe(true);
    });
  });

  describe('required field validation', () => {
    it('reports error when id is missing', () => {
      const { id, ...rest } = validManifest();
      const result = validateManifest(rest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'id' }));
    });

    it('reports error when name is missing', () => {
      const { name, ...rest } = validManifest();
      const result = validateManifest(rest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'name' }));
    });

    it('reports error when runtime is missing', () => {
      const { runtime, ...rest } = validManifest();
      const result = validateManifest(rest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'runtime' }));
    });

    it('reports error when entry is missing', () => {
      const { entry, ...rest } = validManifest();
      const result = validateManifest(rest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'entry' }));
    });

    it('reports all missing required fields at once', () => {
      const result = validateManifest({});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(4);
      const fields = result.errors.map(e => e.field);
      expect(fields).toContain('id');
      expect(fields).toContain('name');
      expect(fields).toContain('runtime');
      expect(fields).toContain('entry');
    });
  });

  describe('type validation', () => {
    it('rejects non-object input (null)', () => {
      const result = validateManifest(null);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('JSON object');
    });

    it('rejects non-object input (array)', () => {
      const result = validateManifest([]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('JSON object');
    });

    it('rejects non-object input (string)', () => {
      const result = validateManifest('hello');
      expect(result.valid).toBe(false);
    });

    it('rejects id that is not a string', () => {
      const result = validateManifest(validManifest({ id: 123 }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'id',
        actual: 'number',
      }));
    });

    it('rejects name that is not a string', () => {
      const result = validateManifest(validManifest({ name: true }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'name' }));
    });

    it('rejects runtime that is not a string', () => {
      const result = validateManifest(validManifest({ runtime: 42 }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'runtime' }));
    });

    it('rejects entry that is not a string', () => {
      const result = validateManifest(validManifest({ entry: null }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'entry' }));
    });
  });

  describe('id pattern validation', () => {
    it('rejects id starting with a hyphen', () => {
      const result = validateManifest(validManifest({ id: '-invalid' }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('id');
    });

    it('rejects id with uppercase letters', () => {
      const result = validateManifest(validManifest({ id: 'MyModule' }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('id');
    });

    it('rejects id with spaces', () => {
      const result = validateManifest(validManifest({ id: 'my module' }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('id');
    });

    it('rejects id with underscores', () => {
      const result = validateManifest(validManifest({ id: 'my_module' }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('id');
    });

    it('rejects empty id string', () => {
      const result = validateManifest(validManifest({ id: '' }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('id');
    });

    it('rejects id exceeding 128 characters', () => {
      const id = 'a' + 'b'.repeat(128); // 129 chars
      const result = validateManifest(validManifest({ id }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('id');
    });
  });

  describe('runtime enum validation', () => {
    it('rejects invalid runtime value', () => {
      const result = validateManifest(validManifest({ runtime: 'java' }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('runtime');
      expect(result.errors[0].message).toContain('nodejs');
      expect(result.errors[0].actual).toBe('java');
    });
  });

  describe('name validation', () => {
    it('rejects empty name', () => {
      const result = validateManifest(validManifest({ name: '' }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('name');
    });

    it('rejects name exceeding 256 characters', () => {
      const result = validateManifest(validManifest({ name: 'x'.repeat(257) }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('name');
    });
  });

  describe('entry validation', () => {
    it('rejects empty entry string', () => {
      const result = validateManifest(validManifest({ entry: '' }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('entry');
    });
  });

  describe('optional field validation — env', () => {
    it('rejects env that is not an object', () => {
      const result = validateManifest(validManifest({ env: 'not-object' }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'env' }));
    });

    it('rejects env that is an array', () => {
      const result = validateManifest(validManifest({ env: ['a', 'b'] }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'env' }));
    });

    it('rejects env that is null', () => {
      const result = validateManifest(validManifest({ env: null }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'env' }));
    });

    it('rejects env with non-string values', () => {
      const result = validateManifest(validManifest({ env: { KEY: 123 } }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'env.KEY' }));
    });

    it('rejects env with more than 64 entries', () => {
      const env: Record<string, string> = {};
      for (let i = 0; i < 65; i++) {
        env[`VAR_${i}`] = 'value';
      }
      const result = validateManifest(validManifest({ env }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'env' }));
    });

    it('accepts env with exactly 64 entries', () => {
      const env: Record<string, string> = {};
      for (let i = 0; i < 64; i++) {
        env[`VAR_${i}`] = 'value';
      }
      const result = validateManifest(validManifest({ env }));
      expect(result.valid).toBe(true);
    });
  });

  describe('optional field validation — args', () => {
    it('rejects args that is not an array', () => {
      const result = validateManifest(validManifest({ args: 'not-array' }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'args' }));
    });

    it('rejects args with non-string elements', () => {
      const result = validateManifest(validManifest({ args: ['valid', 42] }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'args[1]' }));
    });

    it('rejects args with more than 64 elements', () => {
      const args = Array.from({ length: 65 }, (_, i) => `arg${i}`);
      const result = validateManifest(validManifest({ args }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'args' }));
    });

    it('accepts args with exactly 64 elements', () => {
      const args = Array.from({ length: 64 }, (_, i) => `arg${i}`);
      const result = validateManifest(validManifest({ args }));
      expect(result.valid).toBe(true);
    });
  });

  describe('optional field validation — description', () => {
    it('rejects description that is not a string', () => {
      const result = validateManifest(validManifest({ description: 123 }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'description' }));
    });

    it('rejects description exceeding 1024 characters', () => {
      const result = validateManifest(validManifest({ description: 'x'.repeat(1025) }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'description' }));
    });

    it('accepts description at exactly 1024 characters', () => {
      const result = validateManifest(validManifest({ description: 'x'.repeat(1024) }));
      expect(result.valid).toBe(true);
    });
  });

  describe('optional field validation — version', () => {
    it('rejects version that is not a string', () => {
      const result = validateManifest(validManifest({ version: 1 }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'version' }));
    });

    it('rejects version not matching semver pattern', () => {
      const result = validateManifest(validManifest({ version: '1.0' }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('version');
    });

    it('rejects version with v prefix', () => {
      const result = validateManifest(validManifest({ version: 'v1.0.0' }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('version');
    });

    it('rejects version with pre-release suffix', () => {
      const result = validateManifest(validManifest({ version: '1.0.0-beta' }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('version');
    });

    it('accepts valid semver version', () => {
      const result = validateManifest(validManifest({ version: '2.10.3' }));
      expect(result.valid).toBe(true);
      expect(result.manifest!.version).toBe('2.10.3');
    });
  });

  describe('error reporting', () => {
    it('includes field path in error', () => {
      const result = validateManifest(validManifest({ id: 'INVALID' }));
      expect(result.errors[0].field).toBe('id');
    });

    it('includes expected format in error message', () => {
      const result = validateManifest(validManifest({ runtime: 'java' }));
      expect(result.errors[0].message).toContain('nodejs');
      expect(result.errors[0].message).toContain('python');
    });

    it('includes actual value in error', () => {
      const result = validateManifest(validManifest({ runtime: 'java' }));
      expect(result.errors[0].actual).toBe('java');
    });

    it('reports multiple errors from different fields', () => {
      const result = validateManifest({
        id: 'INVALID',
        name: '',
        runtime: 'java',
        entry: '',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });
  });
});
