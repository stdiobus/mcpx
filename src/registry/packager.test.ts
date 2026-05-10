import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  shouldExclude,
  collectFiles,
  readAndValidateManifest,
  createTarball,
  packageModule,
  EXCLUDE_PATTERNS,
} from './packager.js';

describe('packager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcpx-packager-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('EXCLUDE_PATTERNS', () => {
    it('includes .env and .env.* patterns', () => {
      expect(EXCLUDE_PATTERNS).toContain('.env');
      expect(EXCLUDE_PATTERNS).toContain('.env.*');
    });

    it('includes node_modules', () => {
      expect(EXCLUDE_PATTERNS).toContain('node_modules');
    });

    it('includes build artifact directories', () => {
      expect(EXCLUDE_PATTERNS).toContain('target');
      expect(EXCLUDE_PATTERNS).toContain('dist');
      expect(EXCLUDE_PATTERNS).toContain('__pycache__');
    });

    it('includes .git directory', () => {
      expect(EXCLUDE_PATTERNS).toContain('.git');
    });
  });

  describe('shouldExclude', () => {
    it('excludes exact .env match', () => {
      expect(shouldExclude('.env')).toBe(true);
    });

    it('excludes .env.local (glob pattern)', () => {
      expect(shouldExclude('.env.local')).toBe(true);
    });

    it('excludes .env.production', () => {
      expect(shouldExclude('.env.production')).toBe(true);
    });

    it('excludes node_modules', () => {
      expect(shouldExclude('node_modules')).toBe(true);
    });

    it('excludes target directory', () => {
      expect(shouldExclude('target')).toBe(true);
    });

    it('excludes dist directory', () => {
      expect(shouldExclude('dist')).toBe(true);
    });

    it('excludes __pycache__', () => {
      expect(shouldExclude('__pycache__')).toBe(true);
    });

    it('excludes .git', () => {
      expect(shouldExclude('.git')).toBe(true);
    });

    it('excludes .DS_Store', () => {
      expect(shouldExclude('.DS_Store')).toBe(true);
    });

    it('does not exclude module.json', () => {
      expect(shouldExclude('module.json')).toBe(false);
    });

    it('does not exclude source files', () => {
      expect(shouldExclude('index.ts')).toBe(false);
      expect(shouldExclude('server.py')).toBe(false);
      expect(shouldExclude('main.go')).toBe(false);
    });

    it('does not exclude package.json', () => {
      expect(shouldExclude('package.json')).toBe(false);
    });
  });

  describe('collectFiles', () => {
    it('includes module.json', () => {
      writeFileSync(join(tempDir, 'module.json'), '{}');
      const files = collectFiles(tempDir);
      expect(files).toContain('module.json');
    });

    it('includes source files', () => {
      writeFileSync(join(tempDir, 'module.json'), '{}');
      writeFileSync(join(tempDir, 'index.ts'), 'export {}');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src', 'main.ts'), 'console.log("hi")');

      const files = collectFiles(tempDir);
      expect(files).toContain('module.json');
      expect(files).toContain('index.ts');
      expect(files).toContain(join('src', 'main.ts'));
    });

    it('excludes .env files', () => {
      writeFileSync(join(tempDir, 'module.json'), '{}');
      writeFileSync(join(tempDir, '.env'), 'SECRET=value');
      writeFileSync(join(tempDir, '.env.local'), 'LOCAL=value');

      const files = collectFiles(tempDir);
      expect(files).not.toContain('.env');
      expect(files).not.toContain('.env.local');
    });

    it('excludes node_modules directory', () => {
      writeFileSync(join(tempDir, 'module.json'), '{}');
      mkdirSync(join(tempDir, 'node_modules'));
      mkdirSync(join(tempDir, 'node_modules', 'some-pkg'));
      writeFileSync(join(tempDir, 'node_modules', 'some-pkg', 'index.js'), '');

      const files = collectFiles(tempDir);
      expect(files).not.toContain(join('node_modules', 'some-pkg', 'index.js'));
    });

    it('excludes build artifact directories', () => {
      writeFileSync(join(tempDir, 'module.json'), '{}');
      mkdirSync(join(tempDir, 'dist'));
      writeFileSync(join(tempDir, 'dist', 'bundle.js'), '');
      mkdirSync(join(tempDir, 'target'));
      writeFileSync(join(tempDir, 'target', 'output'), '');
      mkdirSync(join(tempDir, '__pycache__'));
      writeFileSync(join(tempDir, '__pycache__', 'mod.pyc'), '');

      const files = collectFiles(tempDir);
      expect(files).not.toContain(join('dist', 'bundle.js'));
      expect(files).not.toContain(join('target', 'output'));
      expect(files).not.toContain(join('__pycache__', 'mod.pyc'));
    });

    it('returns sorted file list', () => {
      writeFileSync(join(tempDir, 'z-file.ts'), '');
      writeFileSync(join(tempDir, 'a-file.ts'), '');
      writeFileSync(join(tempDir, 'module.json'), '{}');

      const files = collectFiles(tempDir);
      const sorted = [...files].sort();
      expect(files).toEqual(sorted);
    });
  });

  describe('readAndValidateManifest', () => {
    it('returns valid result for a correct manifest', () => {
      const manifest = {
        id: 'test-module',
        name: 'Test Module',
        runtime: 'nodejs',
        entry: 'index.ts',
      };
      writeFileSync(join(tempDir, 'module.json'), JSON.stringify(manifest));

      const result = readAndValidateManifest(tempDir);
      expect(result.valid).toBe(true);
      expect(result.manifest?.id).toBe('test-module');
    });

    it('returns error when module.json does not exist', () => {
      const result = readAndValidateManifest(tempDir);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('No module.json found');
    });

    it('returns error for invalid JSON', () => {
      writeFileSync(join(tempDir, 'module.json'), '{invalid json}');

      const result = readAndValidateManifest(tempDir);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Failed to parse');
    });

    it('returns validation errors for missing required fields', () => {
      writeFileSync(join(tempDir, 'module.json'), JSON.stringify({ id: 'test' }));

      const result = readAndValidateManifest(tempDir);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('createTarball', () => {
    it('creates a non-empty buffer', () => {
      writeFileSync(join(tempDir, 'module.json'), JSON.stringify({
        id: 'test-module',
        name: 'Test',
        runtime: 'nodejs',
        entry: 'index.ts',
      }));
      writeFileSync(join(tempDir, 'index.ts'), 'export default {}');

      const tarball = createTarball(tempDir);
      expect(tarball).toBeInstanceOf(Buffer);
      expect(tarball.length).toBeGreaterThan(0);
    });

    it('excludes .env files from tarball', () => {
      writeFileSync(join(tempDir, 'module.json'), '{}');
      writeFileSync(join(tempDir, '.env'), 'SECRET=value');
      writeFileSync(join(tempDir, 'index.ts'), 'export {}');

      const tarball = createTarball(tempDir);
      // The tarball should not contain .env content
      // We verify by checking the tarball doesn't include the secret
      const content = tarball.toString('utf-8');
      expect(content).not.toContain('SECRET=value');
    });
  });

  describe('packageModule', () => {
    it('succeeds with a valid module directory', () => {
      const manifest = {
        id: 'test-module',
        name: 'Test Module',
        runtime: 'nodejs',
        entry: 'index.ts',
      };
      writeFileSync(join(tempDir, 'module.json'), JSON.stringify(manifest));
      writeFileSync(join(tempDir, 'index.ts'), 'export default {}');

      const result = packageModule({ moduleDir: tempDir });
      expect(result.success).toBe(true);
      expect(result.tarball).toBeInstanceOf(Buffer);
      expect(result.tarball!.length).toBeGreaterThan(0);
      expect(result.manifest?.id).toBe('test-module');
    });

    it('fails when module.json is missing', () => {
      const result = packageModule({ moduleDir: tempDir });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Manifest validation failed');
      expect(result.validationErrors).toBeDefined();
    });

    it('fails when manifest has validation errors', () => {
      writeFileSync(join(tempDir, 'module.json'), JSON.stringify({
        id: 'INVALID-UPPERCASE',
        name: 'Test',
        runtime: 'nodejs',
        entry: 'index.ts',
      }));

      const result = packageModule({ moduleDir: tempDir });
      expect(result.success).toBe(false);
      expect(result.validationErrors).toBeDefined();
      expect(result.validationErrors!.length).toBeGreaterThan(0);
    });

    it('fails when module.json is invalid JSON', () => {
      writeFileSync(join(tempDir, 'module.json'), 'not json');

      const result = packageModule({ moduleDir: tempDir });
      expect(result.success).toBe(false);
      expect(result.validationErrors).toBeDefined();
    });

    it('succeeds with skipValidation even if manifest is incomplete', () => {
      writeFileSync(join(tempDir, 'module.json'), JSON.stringify({ id: 'test' }));

      const result = packageModule({ moduleDir: tempDir, skipValidation: true });
      expect(result.success).toBe(true);
      expect(result.tarball).toBeInstanceOf(Buffer);
    });

    it('fails with skipValidation when module.json is missing', () => {
      const result = packageModule({ moduleDir: tempDir, skipValidation: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain('No module.json found');
    });

    it('fails with skipValidation when module.json is invalid JSON', () => {
      writeFileSync(join(tempDir, 'module.json'), '{broken');

      const result = packageModule({ moduleDir: tempDir, skipValidation: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to parse');
    });
  });
});
