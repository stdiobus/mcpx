/**
 * Tests for the Rust runtime plugin.
 *
 * @see Requirement 8.2 — Rust binary detection in target/release/ or `cargo run` fallback
 * @see Requirement 8.3 — Working directory set to module directory
 * @see Requirement 8.8 — Report error if `cargo` is not available
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { resolve, join } from 'node:path';
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
const { RustPlugin } = await import('./rust.js');

const mockedExistsSync = jest.mocked(existsSync);
const mockedExecFileSync = jest.mocked(execFileSync);

describe('RustPlugin', () => {
  let plugin: RustPlugin;

  beforeEach(() => {
    plugin = new RustPlugin();
    jest.clearAllMocks();
  });

  describe('metadata', () => {
    it('has name "rust"', () => {
      expect(plugin.name).toBe('rust');
    });

    it('supports .rs extensions', () => {
      expect(plugin.supportedExtensions).toContain('.rs');
    });
  });

  describe('checkAvailability', () => {
    it('returns available when cargo is found', async () => {
      mockedExecFileSync.mockReturnValue('cargo 1.74.0 (ecb9851af 2023-10-18)');

      const result = await plugin.checkAvailability();

      expect(result.available).toBe(true);
      expect(result.tool).toBe('cargo');
      expect(result.version).toBe('1.74.0 (ecb9851af 2023-10-18)');
    });

    it('returns unavailable when cargo is not found', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await plugin.checkAvailability();

      expect(result.available).toBe(false);
      expect(result.tool).toBe('cargo');
      expect(result.suggestion).toContain('Install Rust');
    });
  });

  describe('buildCommand', () => {
    const MODULE_DIR = resolve('/tmp/test-module');
    const makeModule = (id: string, args?: string[]): ResolvedModule => ({
      manifest: {
        id,
        name: 'My Rust Module',
        runtime: 'rust',
        entry: 'src/main.rs',
        args,
      },
      dir: MODULE_DIR,
      manifestPath: join(MODULE_DIR, 'module.json'),
    });

    it('uses pre-built binary from target/release/<id> when it exists', () => {
      mockedExistsSync.mockReturnValue(true);

      const module = makeModule('my-rust-server');
      const result = plugin.buildCommand(module);

      expect(result.command).toBe(resolve(MODULE_DIR, 'target', 'release', 'my-rust-server'));
      expect(result.args).toEqual([]);
      expect(result.cwd).toBe(MODULE_DIR);
    });

    it('falls back to cargo run when no binary exists', () => {
      mockedExistsSync.mockReturnValue(false);

      const module = makeModule('my-rust-server');
      const result = plugin.buildCommand(module);

      expect(result.command).toBe('cargo');
      expect(result.args).toEqual(['run']);
      expect(result.cwd).toBe(MODULE_DIR);
    });

    it('passes manifest args to pre-built binary', () => {
      mockedExistsSync.mockReturnValue(true);

      const module = makeModule('my-rust-server', ['--port', '3000']);
      const result = plugin.buildCommand(module);

      expect(result.command).toBe(resolve(MODULE_DIR, 'target', 'release', 'my-rust-server'));
      expect(result.args).toEqual(['--port', '3000']);
    });

    it('passes manifest args to cargo run with -- separator', () => {
      mockedExistsSync.mockReturnValue(false);

      const module = makeModule('my-rust-server', ['--port', '3000']);
      const result = plugin.buildCommand(module);

      expect(result.command).toBe('cargo');
      expect(result.args).toEqual(['run', '--', '--port', '3000']);
    });

    it('does not add -- separator when no args', () => {
      mockedExistsSync.mockReturnValue(false);

      const module = makeModule('my-rust-server');
      const result = plugin.buildCommand(module);

      expect(result.command).toBe('cargo');
      expect(result.args).toEqual(['run']);
    });

    it('sets working directory to module dir', () => {
      mockedExistsSync.mockReturnValue(false);

      const module = makeModule('my-rust-server');
      const result = plugin.buildCommand(module);

      expect(result.cwd).toBe(MODULE_DIR);
    });

    it('returns empty env object', () => {
      mockedExistsSync.mockReturnValue(false);

      const module = makeModule('my-rust-server');
      const result = plugin.buildCommand(module);

      expect(result.env).toEqual({});
    });
  });
});
