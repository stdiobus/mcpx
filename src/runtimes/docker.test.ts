/**
 * Tests for the Docker runtime plugin.
 *
 * @see Requirement 8.6 — Docker executes with `docker run --rm -i` using image from entry
 * @see Requirement 8.7 — Pass all resolved env vars using `-e` flags
 * @see Requirement 8.3 — Working directory set to module directory
 * @see Requirement 8.8 — Report error if `docker` is not available
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { resolve, join } from 'node:path';
import type { ResolvedModule } from '../core/manifest.js';

// Mock child_process
jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: jest.fn(),
}));

const { execFileSync } = await import('node:child_process');
const { DockerPlugin } = await import('./docker.js');

const mockedExecFileSync = jest.mocked(execFileSync);

describe('DockerPlugin', () => {
  let plugin: DockerPlugin;

  beforeEach(() => {
    plugin = new DockerPlugin();
    jest.clearAllMocks();
  });

  describe('metadata', () => {
    it('has name "docker"', () => {
      expect(plugin.name).toBe('docker');
    });
  });

  describe('checkAvailability', () => {
    it('returns available when docker is found', async () => {
      mockedExecFileSync.mockReturnValue('Docker version 24.0.7, build afdd53b');

      const result = await plugin.checkAvailability();

      expect(result.available).toBe(true);
      expect(result.tool).toBe('docker');
      expect(result.version).toBe('24.0.7, build afdd53b');
    });

    it('returns unavailable when docker is not found', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await plugin.checkAvailability();

      expect(result.available).toBe(false);
      expect(result.tool).toBe('docker');
      expect(result.suggestion).toContain('Install Docker');
    });
  });

  describe('buildCommand', () => {
    const MODULE_DIR = resolve('/tmp/test-module');
    const makeModule = (entry: string, args?: string[]): ResolvedModule => ({
      manifest: {
        id: 'my-docker-module',
        name: 'My Docker Module',
        runtime: 'docker',
        entry,
        args,
      },
      dir: MODULE_DIR,
      manifestPath: join(MODULE_DIR, 'module.json'),
    });

    it('uses docker run --rm -i with image from entry', () => {
      const module = makeModule('my-mcp-server:latest');
      const result = plugin.buildCommand(module);

      expect(result.command).toBe('docker');
      expect(result.args).toContain('run');
      expect(result.args).toContain('--rm');
      expect(result.args).toContain('-i');
      expect(result.args).toContain('my-mcp-server:latest');
    });

    it('passes resolved env vars as -e flags', () => {
      const module = makeModule('my-mcp-server:latest');
      const resolvedEnv = {
        API_KEY: 'sk-test-123',
        DATABASE_URL: 'postgres://localhost/db',
      };

      const result = plugin.buildCommand(module, resolvedEnv);

      expect(result.args).toContain('-e');
      expect(result.args).toContain('API_KEY=sk-test-123');
      expect(result.args).toContain('DATABASE_URL=postgres://localhost/db');
    });

    it('places -e flags before image name', () => {
      const module = makeModule('my-mcp-server:latest');
      const resolvedEnv = { MY_VAR: 'value' };

      const result = plugin.buildCommand(module, resolvedEnv);

      const imageIndex = result.args.indexOf('my-mcp-server:latest');
      const envFlagIndex = result.args.indexOf('-e');
      expect(envFlagIndex).toBeLessThan(imageIndex);
    });

    it('handles empty env vars', () => {
      const module = makeModule('my-mcp-server:latest');
      const result = plugin.buildCommand(module, {});

      expect(result.args).toEqual(['run', '--rm', '-i', 'my-mcp-server:latest']);
    });

    it('handles no env vars (undefined)', () => {
      const module = makeModule('my-mcp-server:latest');
      const result = plugin.buildCommand(module);

      expect(result.args).toEqual(['run', '--rm', '-i', 'my-mcp-server:latest']);
    });

    it('passes manifest args after image name', () => {
      const module = makeModule('my-mcp-server:latest', ['--port', '3000']);
      const result = plugin.buildCommand(module);

      const imageIndex = result.args.indexOf('my-mcp-server:latest');
      expect(result.args.slice(imageIndex + 1)).toEqual(['--port', '3000']);
    });

    it('sets working directory to module dir', () => {
      const module = makeModule('my-mcp-server:latest');
      const result = plugin.buildCommand(module);

      expect(result.cwd).toBe(MODULE_DIR);
    });

    it('returns empty env object (env passed via -e flags, not process env)', () => {
      const module = makeModule('my-mcp-server:latest');
      const result = plugin.buildCommand(module, { KEY: 'val' });

      expect(result.env).toEqual({});
    });

    it('handles multiple env vars correctly', () => {
      const module = makeModule('my-mcp-server:latest');
      const resolvedEnv = {
        VAR1: 'value1',
        VAR2: 'value2',
        VAR3: 'value3',
      };

      const result = plugin.buildCommand(module, resolvedEnv);

      // Count -e flags
      const eFlags = result.args.filter((arg) => arg === '-e');
      expect(eFlags.length).toBe(3);
    });
  });
});
