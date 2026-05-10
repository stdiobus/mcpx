/**
 * Tests for the Shell runtime plugin.
 *
 * @see Requirement 8.4 — Shell executes entry file using `/bin/sh`
 * @see Requirement 8.5 — Report error if entry file does not exist
 * @see Requirement 8.3 — Working directory set to module directory
 * @see Requirement 8.8 — Report error if `/bin/sh` is not available
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { RuntimeError } from '../core/errors.js';
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
const { ShellPlugin } = await import('./shell.js');

const mockedExistsSync = jest.mocked(existsSync);
const mockedExecFileSync = jest.mocked(execFileSync);

describe('ShellPlugin', () => {
  let plugin: ShellPlugin;

  beforeEach(() => {
    plugin = new ShellPlugin();
    jest.clearAllMocks();
  });

  describe('metadata', () => {
    it('has name "shell"', () => {
      expect(plugin.name).toBe('shell');
    });

    it('supports .sh extensions', () => {
      expect(plugin.supportedExtensions).toContain('.sh');
    });
  });

  describe('checkAvailability', () => {
    it('returns available when /bin/sh exists', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedExecFileSync.mockReturnValue('GNU bash, version 5.2.15(1)-release');

      const result = await plugin.checkAvailability();

      expect(result.available).toBe(true);
      expect(result.tool).toBe('/bin/sh');
    });

    it('returns available even if --version fails (e.g., dash)', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('--version not supported');
      });

      const result = await plugin.checkAvailability();

      expect(result.available).toBe(true);
      expect(result.tool).toBe('/bin/sh');
    });

    it('returns unavailable when /bin/sh does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const result = await plugin.checkAvailability();

      expect(result.available).toBe(false);
      expect(result.tool).toBe('/bin/sh');
      expect(result.suggestion).toBeDefined();
    });
  });

  describe('buildCommand', () => {
    const makeModule = (entry: string, args?: string[]): ResolvedModule => ({
      manifest: {
        id: 'my-shell-module',
        name: 'My Shell Module',
        runtime: 'shell',
        entry,
        args,
      },
      dir: '/path/to/module',
      manifestPath: '/path/to/module/module.json',
    });

    it('uses /bin/sh to execute entry file', () => {
      mockedExistsSync.mockReturnValue(true);

      const module = makeModule('server.sh');
      const result = plugin.buildCommand(module);

      expect(result.command).toBe('/bin/sh');
      expect(result.args[0]).toBe('server.sh');
    });

    it('throws RuntimeError when entry file does not exist', () => {
      mockedExistsSync.mockReturnValue(false);

      const module = makeModule('missing.sh');

      expect(() => plugin.buildCommand(module)).toThrow(RuntimeError);
      expect(() => plugin.buildCommand(module)).toThrow(/Shell entry file not found/);
    });

    it('passes manifest args after entry file', () => {
      mockedExistsSync.mockReturnValue(true);

      const module = makeModule('server.sh', ['--port', '8080']);
      const result = plugin.buildCommand(module);

      expect(result.command).toBe('/bin/sh');
      expect(result.args).toEqual(['server.sh', '--port', '8080']);
    });

    it('sets working directory to module dir', () => {
      mockedExistsSync.mockReturnValue(true);

      const module = makeModule('server.sh');
      const result = plugin.buildCommand(module);

      expect(result.cwd).toBe('/path/to/module');
    });

    it('returns empty env object', () => {
      mockedExistsSync.mockReturnValue(true);

      const module = makeModule('server.sh');
      const result = plugin.buildCommand(module);

      expect(result.env).toEqual({});
    });
  });
});
