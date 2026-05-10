/**
 * Unit tests for the Node.js runtime plugin (task 7.1).
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { RuntimeError, ManifestError } from '../core/errors.js';
import type { ResolvedModule } from '../core/manifest.js';

// Mock child_process and fs
jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: jest.fn(),
}));

jest.unstable_mockModule('node:fs', () => ({
  existsSync: jest.fn(),
}));

const childProcess = await import('node:child_process');
const fs = await import('node:fs');
const { NodejsPlugin } = await import('./nodejs.js');

const mockExecFileSync = jest.mocked(childProcess.execFileSync);
const mockExistsSync = jest.mocked(fs.existsSync);

function makeModule(overrides: Partial<ResolvedModule['manifest']> = {}, dir = '/path/to/module'): ResolvedModule {
  return {
    manifest: {
      id: 'test-module',
      name: 'Test Module',
      runtime: 'nodejs',
      entry: 'index.ts',
      ...overrides,
    },
    dir,
    manifestPath: `${dir}/module.json`,
  };
}

describe('NodejsPlugin', () => {
  let plugin: NodejsPlugin;

  beforeEach(() => {
    plugin = new NodejsPlugin();
    jest.resetAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('metadata', () => {
    it('has name "nodejs"', () => {
      expect(plugin.name).toBe('nodejs');
    });

    it('supports .ts, .js, .mjs extensions', () => {
      expect(plugin.supportedExtensions).toEqual(['.ts', '.js', '.mjs']);
    });
  });

  describe('checkAvailability', () => {
    it('returns available with version when node is found', async () => {
      mockExecFileSync.mockReturnValue('v20.11.0');

      const result = await plugin.checkAvailability();

      expect(result.available).toBe(true);
      expect(result.tool).toBe('node');
      expect(result.version).toBe('20.11.0');
    });

    it('strips v prefix from version', async () => {
      mockExecFileSync.mockReturnValue('v18.0.0');

      const result = await plugin.checkAvailability();

      expect(result.version).toBe('18.0.0');
    });

    it('returns unavailable with suggestion when node is not found', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await plugin.checkAvailability();

      expect(result.available).toBe(false);
      expect(result.tool).toBe('node');
      expect(result.suggestion).toContain('Node.js');
    });
  });

  describe('buildCommand — TypeScript (.ts)', () => {
    beforeEach(() => {
      // Default: both node and npx available, entry file exists
      mockExecFileSync.mockReturnValue('v20.11.0');
      mockExistsSync.mockReturnValue(true);
    });

    it('returns npx tsx command for .ts entry (R6.1)', () => {
      const module = makeModule({ entry: 'server.ts' });

      const result = plugin.buildCommand(module);

      expect(result.command).toBe('npx');
      expect(result.args[0]).toBe('tsx');
      expect(result.args[1]).toBe('server.ts');
    });

    it('sets cwd to module directory (R6.3)', () => {
      const module = makeModule({ entry: 'server.ts' }, '/my/module/dir');

      const result = plugin.buildCommand(module);

      expect(result.cwd).toBe('/my/module/dir');
    });

    it('includes manifest args after entry (R6.1)', () => {
      const module = makeModule({ entry: 'server.ts', args: ['--port', '3000'] });

      const result = plugin.buildCommand(module);

      expect(result.args).toEqual(['tsx', 'server.ts', '--port', '3000']);
    });

    it('returns empty env (manifest env is handled by env-loader, not plugins)', () => {
      const module = makeModule({ entry: 'server.ts', env: { API_KEY: 'test' } });

      const result = plugin.buildCommand(module);

      expect(result.env).toEqual({});
    });

    it('throws RuntimeError if npx not found (R6.5)', () => {
      // node available, npx not
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === 'node') return 'v20.11.0';
        throw new Error('ENOENT');
      });

      const module = makeModule({ entry: 'server.ts' });

      expect(() => plugin.buildCommand(module)).toThrow(RuntimeError);
      expect(() => plugin.buildCommand(module)).toThrow(/npx not found/);
    });
  });

  describe('buildCommand — JavaScript (.js)', () => {
    beforeEach(() => {
      mockExecFileSync.mockReturnValue('v20.11.0');
      mockExistsSync.mockReturnValue(true);
    });

    it('returns node command for .js entry (R6.2)', () => {
      const module = makeModule({ entry: 'server.js' });

      const result = plugin.buildCommand(module);

      expect(result.command).toBe('node');
      expect(result.args[0]).toBe('server.js');
    });

    it('sets cwd to module directory (R6.3)', () => {
      const module = makeModule({ entry: 'server.js' }, '/another/dir');

      const result = plugin.buildCommand(module);

      expect(result.cwd).toBe('/another/dir');
    });

    it('includes manifest args after entry', () => {
      const module = makeModule({ entry: 'server.js', args: ['--verbose'] });

      const result = plugin.buildCommand(module);

      expect(result.args).toEqual(['server.js', '--verbose']);
    });
  });

  describe('buildCommand — ESM JavaScript (.mjs)', () => {
    beforeEach(() => {
      mockExecFileSync.mockReturnValue('v20.11.0');
      mockExistsSync.mockReturnValue(true);
    });

    it('returns node command for .mjs entry (R6.2)', () => {
      const module = makeModule({ entry: 'server.mjs' });

      const result = plugin.buildCommand(module);

      expect(result.command).toBe('node');
      expect(result.args[0]).toBe('server.mjs');
    });
  });

  describe('buildCommand — unsupported extensions (R6.7)', () => {
    beforeEach(() => {
      mockExecFileSync.mockReturnValue('v20.11.0');
      mockExistsSync.mockReturnValue(true);
    });

    it('throws ManifestError for .cjs extension', () => {
      const module = makeModule({ entry: 'server.cjs' });

      expect(() => plugin.buildCommand(module)).toThrow(ManifestError);
      expect(() => plugin.buildCommand(module)).toThrow(/Unsupported file extension/);
    });

    it('throws ManifestError for .py extension', () => {
      const module = makeModule({ entry: 'server.py' });

      expect(() => plugin.buildCommand(module)).toThrow(ManifestError);
      expect(() => plugin.buildCommand(module)).toThrow(/\.py/);
    });

    it('throws ManifestError for no extension', () => {
      const module = makeModule({ entry: 'server' });

      expect(() => plugin.buildCommand(module)).toThrow(ManifestError);
    });

    it('includes suggestion with supported extensions', () => {
      const module = makeModule({ entry: 'server.rb' });

      try {
        plugin.buildCommand(module);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ManifestError);
        expect((err as ManifestError).suggestion).toContain('.ts');
        expect((err as ManifestError).suggestion).toContain('.js');
        expect((err as ManifestError).suggestion).toContain('.mjs');
      }
    });
  });

  describe('buildCommand — entry file not found (R6.6)', () => {
    beforeEach(() => {
      mockExecFileSync.mockReturnValue('v20.11.0');
    });

    it('throws RuntimeError when entry file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const module = makeModule({ entry: 'missing.ts' }, '/path/to/module');

      expect(() => plugin.buildCommand(module)).toThrow(RuntimeError);
      expect(() => plugin.buildCommand(module)).toThrow(/Entry file not found/);
    });

    it('includes the resolved path in the error message', () => {
      mockExistsSync.mockReturnValue(false);

      const module = makeModule({ entry: 'src/index.ts' }, '/my/module');

      try {
        plugin.buildCommand(module);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RuntimeError);
        expect((err as RuntimeError).message).toContain('/my/module/src/index.ts');
      }
    });
  });

  describe('buildCommand — node not available (R6.4)', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it('throws RuntimeError when node is not found for .js entry', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const module = makeModule({ entry: 'server.js' });

      expect(() => plugin.buildCommand(module)).toThrow(RuntimeError);
      expect(() => plugin.buildCommand(module)).toThrow(/Node\.js not found/);
    });

    it('throws RuntimeError when node is not found for .ts entry', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const module = makeModule({ entry: 'server.ts' });

      expect(() => plugin.buildCommand(module)).toThrow(RuntimeError);
      expect(() => plugin.buildCommand(module)).toThrow(/Node\.js not found/);
    });

    it('includes install suggestion in error', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const module = makeModule({ entry: 'server.js' });

      try {
        plugin.buildCommand(module);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RuntimeError);
        expect((err as RuntimeError).suggestion).toContain('nodejs.org');
      }
    });
  });

  describe('buildCommand — empty env/args defaults', () => {
    beforeEach(() => {
      mockExecFileSync.mockReturnValue('v20.11.0');
      mockExistsSync.mockReturnValue(true);
    });

    it('uses empty env when manifest has no env field', () => {
      const module = makeModule({ entry: 'server.js' });
      delete module.manifest.env;

      const result = plugin.buildCommand(module);

      expect(result.env).toEqual({});
    });

    it('uses no extra args when manifest has no args field', () => {
      const module = makeModule({ entry: 'server.js' });
      delete module.manifest.args;

      const result = plugin.buildCommand(module);

      expect(result.args).toEqual(['server.js']);
    });
  });
});
