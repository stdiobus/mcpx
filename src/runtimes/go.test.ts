/**
 * Tests for the Go runtime plugin.
 *
 * @see Requirement 8.1 — Go binary detection or `go run` fallback
 * @see Requirement 8.3 — Working directory set to module directory
 * @see Requirement 8.8 — Report error if `go` is not available
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ResolvedModule } from '../core/manifest.js';

// Mock fs and child_process
jest.unstable_mockModule('node:fs', () => ({
  existsSync: jest.fn(),
}));

jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: jest.fn(),
}));

const { existsSync } = await import('node:fs');
const { execFileSync } = await import('node:child_process');
const { GoPlugin } = await import('./go.js');

const mockedExistsSync = jest.mocked(existsSync);
const mockedExecFileSync = jest.mocked(execFileSync);

describe('GoPlugin', () => {
  let plugin: GoPlugin;

  beforeEach(() => {
    plugin = new GoPlugin();
    jest.clearAllMocks();
  });

  describe('metadata', () => {
    it('has name "go"', () => {
      expect(plugin.name).toBe('go');
    });

    it('supports .go extensions', () => {
      expect(plugin.supportedExtensions).toContain('.go');
    });
  });

  describe('checkAvailability', () => {
    it('returns available when go is found', async () => {
      mockedExecFileSync.mockReturnValue('go version go1.21.5 darwin/arm64');

      const result = await plugin.checkAvailability();

      expect(result.available).toBe(true);
      expect(result.tool).toBe('go');
      expect(result.version).toBe('go1.21.5 darwin/arm64');
    });

    it('returns unavailable when go is not found', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await plugin.checkAvailability();

      expect(result.available).toBe(false);
      expect(result.tool).toBe('go');
      expect(result.suggestion).toContain('Install Go');
    });
  });

  describe('buildCommand', () => {
    const makeModule = (entry: string, args?: string[]): ResolvedModule => ({
      manifest: {
        id: 'my-go-module',
        name: 'My Go Module',
        runtime: 'go',
        entry,
        args,
      },
      dir: '/path/to/module',
      manifestPath: '/path/to/module/module.json',
    });

    it('uses pre-built binary when it exists (entry without extension)', () => {
      mockedExistsSync.mockReturnValue(true);

      const module = makeModule('main.go');
      const result = plugin.buildCommand(module);

      expect(result.command).toBe('/path/to/module/main');
      expect(result.args).toEqual([]);
      expect(result.cwd).toBe('/path/to/module');
    });

    it('falls back to go run when no binary exists', () => {
      mockedExistsSync.mockReturnValue(false);

      const module = makeModule('cmd/server.go');
      const result = plugin.buildCommand(module);

      expect(result.command).toBe('go');
      expect(result.args).toEqual(['run', 'cmd/server.go']);
      expect(result.cwd).toBe('/path/to/module');
    });

    it('passes manifest args to pre-built binary', () => {
      mockedExistsSync.mockReturnValue(true);

      const module = makeModule('main.go', ['--port', '3000']);
      const result = plugin.buildCommand(module);

      expect(result.command).toBe('/path/to/module/main');
      expect(result.args).toEqual(['--port', '3000']);
    });

    it('passes manifest args to go run', () => {
      mockedExistsSync.mockReturnValue(false);

      const module = makeModule('main.go', ['--port', '3000']);
      const result = plugin.buildCommand(module);

      expect(result.command).toBe('go');
      expect(result.args).toEqual(['run', 'main.go', '--port', '3000']);
    });

    it('sets working directory to module dir', () => {
      mockedExistsSync.mockReturnValue(false);

      const module = makeModule('main.go');
      const result = plugin.buildCommand(module);

      expect(result.cwd).toBe('/path/to/module');
    });

    it('returns empty env object', () => {
      mockedExistsSync.mockReturnValue(false);

      const module = makeModule('main.go');
      const result = plugin.buildCommand(module);

      expect(result.env).toEqual({});
    });
  });
});
