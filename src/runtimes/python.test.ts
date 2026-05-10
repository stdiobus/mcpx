import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeError } from '../core/errors.js';
import type { ResolvedModule } from '../core/manifest.js';

// Mock child_process at the module level
jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: jest.fn(),
}));

const { execFileSync } = await import('node:child_process');
const { PythonPlugin } = await import('./python.js');

const mockedExecFileSync = jest.mocked(execFileSync);

/**
 * Helper to create a ResolvedModule for testing.
 */
function makeModule(dir: string, entry: string = 'server.py', args?: string[]): ResolvedModule {
  return {
    manifest: {
      id: 'test-python-module',
      name: 'Test Python Module',
      runtime: 'python',
      entry,
      args,
    },
    dir,
    manifestPath: join(dir, 'module.json'),
  };
}

describe('PythonPlugin', () => {
  let plugin: PythonPlugin;
  let tempDir: string;

  beforeEach(() => {
    plugin = new PythonPlugin();
    tempDir = mkdtempSync(join(tmpdir(), 'mcpx-python-test-'));
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('metadata', () => {
    it('has name "python"', () => {
      expect(plugin.name).toBe('python');
    });

    it('supports .py extension', () => {
      expect(plugin.supportedExtensions).toContain('.py');
    });
  });

  describe('checkAvailability', () => {
    it('returns available: true with uv when uv is found', async () => {
      mockedExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === 'uv') return 'uv 0.4.0\n';
        throw new Error('not found');
      });

      const result = await plugin.checkAvailability();
      expect(result.available).toBe(true);
      expect(result.tool).toBe('uv');
      expect(result.version).toBe('uv 0.4.0');
    });

    it('returns available: true with python3 when uv is not found', async () => {
      mockedExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === 'python3') return 'Python 3.12.0\n';
        throw new Error('not found');
      });

      const result = await plugin.checkAvailability();
      expect(result.available).toBe(true);
      expect(result.tool).toBe('python3');
      expect(result.version).toBe('Python 3.12.0');
    });

    it('returns available: true with python when uv and python3 are not found', async () => {
      mockedExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === 'python') return 'Python 3.11.0\n';
        throw new Error('not found');
      });

      const result = await plugin.checkAvailability();
      expect(result.available).toBe(true);
      expect(result.tool).toBe('python');
      expect(result.version).toBe('Python 3.11.0');
    });

    it('returns available: false with suggestion when no tools found', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = await plugin.checkAvailability();
      expect(result.available).toBe(false);
      expect(result.tool).toBe('python');
      expect(result.suggestion).toContain('Install Python');
    });
  });

  describe('buildCommand', () => {
    describe('R7.1: uv run when pyproject.toml exists and uv available', () => {
      it('uses "uv run <entry>" when pyproject.toml exists and uv is in PATH', () => {
        writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "test"\n');
        const module = makeModule(tempDir);

        mockedExecFileSync.mockImplementation((cmd: string) => {
          if (cmd === 'uv') return 'uv 0.4.0\n';
          if (cmd === 'python3') return 'Python 3.12.0\n';
          throw new Error('not found');
        });

        const result = plugin.buildCommand(module);
        expect(result.command).toBe('uv');
        expect(result.args[0]).toBe('run');
        expect(result.args[1]).toBe('server.py');
      });

      it('includes manifest args after entry in uv run command', () => {
        writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "test"\n');
        const module = makeModule(tempDir, 'server.py', ['--port', '8080']);

        mockedExecFileSync.mockImplementation((cmd: string) => {
          if (cmd === 'uv') return 'uv 0.4.0\n';
          throw new Error('not found');
        });

        const result = plugin.buildCommand(module);
        expect(result.command).toBe('uv');
        expect(result.args).toEqual(['run', 'server.py', '--port', '8080']);
      });
    });

    describe('R7.2: python3/python fallback when uv not available', () => {
      it('uses "python3 <entry>" when uv is not available', () => {
        const module = makeModule(tempDir);

        mockedExecFileSync.mockImplementation((cmd: string) => {
          if (cmd === 'python3') return 'Python 3.12.0\n';
          throw new Error('not found');
        });

        const result = plugin.buildCommand(module);
        expect(result.command).toBe('python3');
        expect(result.args[0]).toBe('server.py');
      });

      it('uses "python <entry>" when python3 is not available', () => {
        const module = makeModule(tempDir);

        mockedExecFileSync.mockImplementation((cmd: string) => {
          if (cmd === 'python') return 'Python 3.11.0\n';
          throw new Error('not found');
        });

        const result = plugin.buildCommand(module);
        expect(result.command).toBe('python');
        expect(result.args[0]).toBe('server.py');
      });

      it('falls back to python3 when pyproject.toml exists but uv is not available', () => {
        writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "test"\n');
        const module = makeModule(tempDir);

        mockedExecFileSync.mockImplementation((cmd: string) => {
          if (cmd === 'python3') return 'Python 3.12.0\n';
          throw new Error('not found');
        });

        const result = plugin.buildCommand(module);
        expect(result.command).toBe('python3');
        expect(result.args[0]).toBe('server.py');
      });
    });

    describe('R7.3: working directory set to module dir', () => {
      it('sets cwd to the module directory', () => {
        const module = makeModule(tempDir);

        mockedExecFileSync.mockImplementation((cmd: string) => {
          if (cmd === 'python3') return 'Python 3.12.0\n';
          throw new Error('not found');
        });

        const result = plugin.buildCommand(module);
        expect(result.cwd).toBe(tempDir);
      });

      it('sets cwd to module dir when using uv', () => {
        writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "test"\n');
        const module = makeModule(tempDir);

        mockedExecFileSync.mockImplementation((cmd: string) => {
          if (cmd === 'uv') return 'uv 0.4.0\n';
          throw new Error('not found');
        });

        const result = plugin.buildCommand(module);
        expect(result.cwd).toBe(tempDir);
      });
    });

    describe('R7.4: error when no Python found', () => {
      it('throws RuntimeError when no Python interpreter is found', () => {
        const module = makeModule(tempDir);

        mockedExecFileSync.mockImplementation(() => {
          throw new Error('not found');
        });

        expect(() => plugin.buildCommand(module)).toThrow(RuntimeError);
      });

      it('throws RuntimeError with exit code 3', () => {
        const module = makeModule(tempDir);

        mockedExecFileSync.mockImplementation(() => {
          throw new Error('not found');
        });

        try {
          plugin.buildCommand(module);
          throw new Error('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(RuntimeError);
          expect((err as RuntimeError).exitCode).toBe(3);
        }
      });

      it('includes helpful suggestion in error', () => {
        const module = makeModule(tempDir);

        mockedExecFileSync.mockImplementation(() => {
          throw new Error('not found');
        });

        try {
          plugin.buildCommand(module);
          throw new Error('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(RuntimeError);
          expect((err as RuntimeError).message).toContain('Python not found');
          expect((err as RuntimeError).suggestion).toContain('Install Python');
        }
      });
    });

    describe('manifest args handling', () => {
      it('includes manifest args after the entry file', () => {
        const module = makeModule(tempDir, 'server.py', ['--port', '3000']);

        mockedExecFileSync.mockImplementation((cmd: string) => {
          if (cmd === 'python3') return 'Python 3.12.0\n';
          throw new Error('not found');
        });

        const result = plugin.buildCommand(module);
        expect(result.args).toEqual(['server.py', '--port', '3000']);
      });

      it('handles empty args array', () => {
        const module = makeModule(tempDir, 'server.py', []);

        mockedExecFileSync.mockImplementation((cmd: string) => {
          if (cmd === 'python3') return 'Python 3.12.0\n';
          throw new Error('not found');
        });

        const result = plugin.buildCommand(module);
        expect(result.args).toEqual(['server.py']);
      });

      it('handles undefined args', () => {
        const module = makeModule(tempDir, 'server.py', undefined);

        mockedExecFileSync.mockImplementation((cmd: string) => {
          if (cmd === 'python3') return 'Python 3.12.0\n';
          throw new Error('not found');
        });

        const result = plugin.buildCommand(module);
        expect(result.args).toEqual(['server.py']);
      });
    });

    describe('env field in ExecDescriptor', () => {
      it('returns an empty env object', () => {
        const module = makeModule(tempDir);

        mockedExecFileSync.mockImplementation((cmd: string) => {
          if (cmd === 'python3') return 'Python 3.12.0\n';
          throw new Error('not found');
        });

        const result = plugin.buildCommand(module);
        expect(result.env).toEqual({});
      });
    });
  });
});
