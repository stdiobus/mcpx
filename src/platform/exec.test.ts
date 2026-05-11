/**
 * Tests for platform/exec.ts — cross-platform exec/spawn.
 *
 * Tests verify:
 * - Successful execution with exit code propagation
 * - stdio transparency (inherit mode)
 * - Error handling for missing commands (ENOENT)
 * - Error handling for permission denied (EACCES)
 * - Windows shell mode detection
 * - Signal handling
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { resolve } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import type { ExecDescriptor } from '../runtimes/plugin.js';
import { RuntimeError } from '../core/errors.js';

// Mock child_process
jest.unstable_mockModule('node:child_process', () => ({
  spawnSync: jest.fn(),
}));

const { spawnSync } = await import('node:child_process');
const mockedSpawnSync = jest.mocked(spawnSync);

// We need to capture process.exit calls without actually exiting
const mockExit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as never);

describe('platform/exec', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  function setPlatform(platform: string) {
    Object.defineProperty(process, 'platform', {
      value: platform,
      writable: true,
      configurable: true,
    });
  }

  function createDescriptor(overrides?: Partial<ExecDescriptor>): ExecDescriptor {
    return {
      command: 'node',
      args: ['server.js'],
      cwd: resolve('/tmp/test-module'),
      env: { NODE_ENV: 'production' },
      ...overrides,
    };
  }

  describe('execModule — successful execution', () => {
    it('should call spawnSync with correct command and args', async () => {
      setPlatform('darwin');
      // Re-import to pick up platform change
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      mockedSpawnSync.mockReturnValue({
        status: 0,
        signal: null,
        error: undefined,
        stdout: null,
        stderr: null,
        pid: 1234,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      const descriptor = createDescriptor();

      expect(() => execModule(descriptor)).toThrow('process.exit(0)');

      expect(mockedSpawnSync).toHaveBeenCalledWith(
        'node',
        ['server.js'],
        expect.objectContaining({
          cwd: resolve('/tmp/test-module'),
          stdio: 'inherit',
        }),
      );
    });

    it('should propagate non-zero exit codes from child process', async () => {
      setPlatform('linux');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      mockedSpawnSync.mockReturnValue({
        status: 42,
        signal: null,
        error: undefined,
        stdout: null,
        stderr: null,
        pid: 1234,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      const descriptor = createDescriptor();

      expect(() => execModule(descriptor)).toThrow('process.exit(42)');
      expect(mockExit).toHaveBeenCalledWith(42);
    });

    it('should merge descriptor env with process.env', async () => {
      setPlatform('darwin');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      mockedSpawnSync.mockReturnValue({
        status: 0,
        signal: null,
        error: undefined,
        stdout: null,
        stderr: null,
        pid: 1234,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      const descriptor = createDescriptor({ env: { MY_VAR: 'hello' } });

      expect(() => execModule(descriptor)).toThrow('process.exit(0)');

      const callArgs = mockedSpawnSync.mock.calls[0];
      const options = callArgs[2] as { env: Record<string, string | undefined> };
      expect(options.env).toMatchObject({ MY_VAR: 'hello' });
      // Should also include inherited process.env keys
      expect(options.env.PATH).toBeDefined();
    });

    it('should use stdio: inherit for transparent passthrough', async () => {
      setPlatform('darwin');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      mockedSpawnSync.mockReturnValue({
        status: 0,
        signal: null,
        error: undefined,
        stdout: null,
        stderr: null,
        pid: 1234,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      const descriptor = createDescriptor();

      expect(() => execModule(descriptor)).toThrow('process.exit(0)');

      const callArgs = mockedSpawnSync.mock.calls[0];
      const options = callArgs[2] as { stdio: string };
      expect(options.stdio).toBe('inherit');
    });
  });

  describe('execModule — platform-specific behavior', () => {
    it('should NOT use shell on Unix (darwin)', async () => {
      setPlatform('darwin');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      mockedSpawnSync.mockReturnValue({
        status: 0,
        signal: null,
        error: undefined,
        stdout: null,
        stderr: null,
        pid: 1234,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      expect(() => execModule(createDescriptor())).toThrow('process.exit(0)');

      const callArgs = mockedSpawnSync.mock.calls[0];
      const options = callArgs[2] as { shell: boolean };
      expect(options.shell).toBe(false);
    });

    it('should NOT use shell on Unix (linux)', async () => {
      setPlatform('linux');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      mockedSpawnSync.mockReturnValue({
        status: 0,
        signal: null,
        error: undefined,
        stdout: null,
        stderr: null,
        pid: 1234,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      expect(() => execModule(createDescriptor())).toThrow('process.exit(0)');

      const callArgs = mockedSpawnSync.mock.calls[0];
      const options = callArgs[2] as { shell: boolean };
      expect(options.shell).toBe(false);
    });

    it('should use shell: true on Windows', async () => {
      setPlatform('win32');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      mockedSpawnSync.mockReturnValue({
        status: 0,
        signal: null,
        error: undefined,
        stdout: null,
        stderr: null,
        pid: 1234,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      expect(() => execModule(createDescriptor())).toThrow('process.exit(0)');

      const callArgs = mockedSpawnSync.mock.calls[0];
      const options = callArgs[2] as { shell: boolean };
      expect(options.shell).toBe(true);
    });
  });

  describe('execModule — error handling', () => {
    it('should throw RuntimeError with ENOENT for missing command', async () => {
      setPlatform('darwin');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      const enoentError = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      mockedSpawnSync.mockReturnValue({
        status: null,
        signal: null,
        error: enoentError,
        stdout: null,
        stderr: null,
        pid: 0,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      const descriptor = createDescriptor({ command: 'nonexistent-binary' });

      try {
        execModule(descriptor);
        throw new Error('Should have thrown');
      } catch (e) {
        const err = e as RuntimeError;
        expect(err.name).toBe('RuntimeError');
        expect(err.message).toContain('Command not found');
        expect(err.message).toContain('nonexistent-binary');
        expect(err.suggestion).toContain('PATH');
        expect(err.exitCode).toBe(3);
      }
    });

    it('should throw RuntimeError with EACCES for permission denied', async () => {
      setPlatform('darwin');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      const eaccesError = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
      mockedSpawnSync.mockReturnValue({
        status: null,
        signal: null,
        error: eaccesError,
        stdout: null,
        stderr: null,
        pid: 0,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      const descriptor = createDescriptor({ command: './my-binary' });

      try {
        execModule(descriptor);
        throw new Error('Should have thrown');
      } catch (e) {
        const err = e as RuntimeError;
        expect(err.name).toBe('RuntimeError');
        expect(err.message).toContain('Permission denied');
        expect(err.message).toContain('./my-binary');
        expect(err.suggestion).toContain('chmod');
        expect(err.exitCode).toBe(3);
      }
    });

    it('should throw RuntimeError for unknown errors', async () => {
      setPlatform('darwin');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      const unknownError = Object.assign(new Error('Something went wrong'), { code: 'UNKNOWN' });
      mockedSpawnSync.mockReturnValue({
        status: null,
        signal: null,
        error: unknownError,
        stdout: null,
        stderr: null,
        pid: 0,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      const descriptor = createDescriptor();

      try {
        execModule(descriptor);
        throw new Error('Should have thrown');
      } catch (e) {
        const err = e as RuntimeError;
        expect(err.name).toBe('RuntimeError');
        expect(err.message).toContain('Failed to execute');
        expect(err.message).toContain('Something went wrong');
        expect(err.exitCode).toBe(3);
      }
    });
  });

  describe('execModule — signal handling', () => {
    it('should exit with 128 + signal code for SIGTERM', async () => {
      setPlatform('darwin');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      mockedSpawnSync.mockReturnValue({
        status: null,
        signal: 'SIGTERM',
        error: undefined,
        stdout: null,
        stderr: null,
        pid: 1234,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      const descriptor = createDescriptor();

      expect(() => execModule(descriptor)).toThrow('process.exit(143)'); // 128 + 15
      expect(mockExit).toHaveBeenCalledWith(143);
    });

    it('should exit with 128 + signal code for SIGINT', async () => {
      setPlatform('darwin');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      mockedSpawnSync.mockReturnValue({
        status: null,
        signal: 'SIGINT',
        error: undefined,
        stdout: null,
        stderr: null,
        pid: 1234,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      const descriptor = createDescriptor();

      expect(() => execModule(descriptor)).toThrow('process.exit(130)'); // 128 + 2
      expect(mockExit).toHaveBeenCalledWith(130);
    });

    it('should exit with 128 + signal code for SIGKILL', async () => {
      setPlatform('darwin');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      mockedSpawnSync.mockReturnValue({
        status: null,
        signal: 'SIGKILL',
        error: undefined,
        stdout: null,
        stderr: null,
        pid: 1234,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      const descriptor = createDescriptor();

      expect(() => execModule(descriptor)).toThrow('process.exit(137)'); // 128 + 9
      expect(mockExit).toHaveBeenCalledWith(137);
    });
  });

  describe('execModule — null exit code handling', () => {
    it('should default to exit code 1 when status is null and no signal', async () => {
      setPlatform('darwin');
      jest.resetModules();
      jest.unstable_mockModule('node:child_process', () => ({
        spawnSync: mockedSpawnSync,
      }));
      const { execModule } = await import('./exec.js');

      mockedSpawnSync.mockReturnValue({
        status: null,
        signal: null,
        error: undefined,
        stdout: null,
        stderr: null,
        pid: 1234,
        output: [null, null, null],
      } as unknown as SpawnSyncReturns<Buffer>);

      const descriptor = createDescriptor();

      expect(() => execModule(descriptor)).toThrow('process.exit(1)');
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
