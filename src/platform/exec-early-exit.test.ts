/**
 * Tests for early exit detection in platform/exec.ts.
 *
 * @see Requirement 18.5 — Capture up to 4096 bytes of stderr on early exit
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { SpawnSyncReturns } from 'node:child_process';
import type { ExecDescriptor } from '../runtimes/plugin.js';
import { RuntimeError } from '../core/errors.js';
import { Logger } from '../core/logger.js';

// Mock child_process
jest.unstable_mockModule('node:child_process', () => ({
  spawnSync: jest.fn(),
}));

const { spawnSync } = await import('node:child_process');
const mockedSpawnSync = jest.mocked(spawnSync);

describe('execModuleWithEarlyExitDetection', () => {
  let stderrOutput: string;
  let originalPlatform: PropertyDescriptor | undefined;
  let mockExit: ReturnType<typeof jest.spyOn>;
  let mockStderr: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    stderrOutput = '';
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true,
    });

    mockExit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    mockStderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput += chunk.toString();
      return true;
    });
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockStderr.mockRestore();
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  function createDescriptor(overrides?: Partial<ExecDescriptor>): ExecDescriptor {
    return {
      command: 'node',
      args: ['server.js'],
      cwd: '/path/to/module',
      env: { NODE_ENV: 'production' },
      ...overrides,
    };
  }

  it('should display early exit message when process exits quickly with non-zero code', async () => {
    jest.resetModules();
    jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: mockedSpawnSync,
    }));
    const { execModuleWithEarlyExitDetection } = await import('./exec.js');

    const stderrBuffer = Buffer.from('Error: Cannot find module "express"');
    mockedSpawnSync.mockReturnValue({
      status: 1,
      signal: null,
      error: undefined,
      stdout: null,
      stderr: stderrBuffer,
      pid: 1234,
      output: [null, null, stderrBuffer],
    } as unknown as SpawnSyncReturns<Buffer>);

    // Mock Date.now to simulate fast exit (< 2s)
    const now = Date.now();
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(now)       // start time
      .mockReturnValueOnce(now + 500); // elapsed = 500ms

    const descriptor = createDescriptor();
    const moduleInfo = { id: 'my-module', runtime: 'nodejs', entry: 'server.js' };
    const logger = new Logger(false);

    expect(() => execModuleWithEarlyExitDetection(descriptor, moduleInfo, logger))
      .toThrow('process.exit(1)');

    // Should display early exit diagnostic info
    expect(stderrOutput).toContain('my-module');
    expect(stderrOutput).toContain('exited with code 1');
    expect(stderrOutput).toContain('nodejs');
    expect(stderrOutput).toContain('server.js');
  });

  it('should NOT display early exit message when process runs longer than 2s', async () => {
    jest.resetModules();
    jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: mockedSpawnSync,
    }));
    const { execModuleWithEarlyExitDetection } = await import('./exec.js');

    const stderrBuffer = Buffer.from('some output');
    mockedSpawnSync.mockReturnValue({
      status: 1,
      signal: null,
      error: undefined,
      stdout: null,
      stderr: stderrBuffer,
      pid: 1234,
      output: [null, null, stderrBuffer],
    } as unknown as SpawnSyncReturns<Buffer>);

    // Mock Date.now to simulate slow exit (> 2s)
    const now = Date.now();
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(now)        // start time
      .mockReturnValueOnce(now + 5000); // elapsed = 5000ms

    const descriptor = createDescriptor();
    const moduleInfo = { id: 'my-module', runtime: 'nodejs', entry: 'server.js' };
    const logger = new Logger(false);

    expect(() => execModuleWithEarlyExitDetection(descriptor, moduleInfo, logger))
      .toThrow('process.exit(1)');

    // Should NOT display early exit message
    expect(stderrOutput).not.toContain('exited with code');
  });

  it('should NOT display early exit message when exit code is 0', async () => {
    jest.resetModules();
    jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: mockedSpawnSync,
    }));
    const { execModuleWithEarlyExitDetection } = await import('./exec.js');

    mockedSpawnSync.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: null,
      stderr: Buffer.from(''),
      pid: 1234,
      output: [null, null, Buffer.from('')],
    } as unknown as SpawnSyncReturns<Buffer>);

    const now = Date.now();
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now + 100);

    const descriptor = createDescriptor();
    const moduleInfo = { id: 'my-module', runtime: 'nodejs', entry: 'server.js' };
    const logger = new Logger(false);

    expect(() => execModuleWithEarlyExitDetection(descriptor, moduleInfo, logger))
      .toThrow('process.exit(0)');

    expect(stderrOutput).not.toContain('exited with code');
  });

  it('should throw RuntimeError for ENOENT (command not found)', async () => {
    jest.resetModules();
    jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: mockedSpawnSync,
    }));
    const { execModuleWithEarlyExitDetection } = await import('./exec.js');

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

    const descriptor = createDescriptor({ command: 'nonexistent' });
    const moduleInfo = { id: 'my-module', runtime: 'nodejs', entry: 'server.js' };
    const logger = new Logger(false);

    try {
      execModuleWithEarlyExitDetection(descriptor, moduleInfo, logger);
      throw new Error('Should have thrown');
    } catch (e) {
      const err = e as RuntimeError;
      expect(err.name).toBe('RuntimeError');
      expect(err.message).toContain('Command not found');
    }
  });

  it('should forward captured stderr to process.stderr', async () => {
    jest.resetModules();
    jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: mockedSpawnSync,
    }));
    const { execModuleWithEarlyExitDetection } = await import('./exec.js');

    const stderrContent = 'Module startup error details';
    const stderrBuffer = Buffer.from(stderrContent);
    mockedSpawnSync.mockReturnValue({
      status: 1,
      signal: null,
      error: undefined,
      stdout: null,
      stderr: stderrBuffer,
      pid: 1234,
      output: [null, null, stderrBuffer],
    } as unknown as SpawnSyncReturns<Buffer>);

    const now = Date.now();
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now + 100);

    const descriptor = createDescriptor();
    const moduleInfo = { id: 'test-mod', runtime: 'nodejs', entry: 'index.ts' };
    const logger = new Logger(false);

    expect(() => execModuleWithEarlyExitDetection(descriptor, moduleInfo, logger))
      .toThrow('process.exit(1)');

    // The module's stderr should be forwarded
    expect(stderrOutput).toContain(stderrContent);
  });

  it('should use piped stderr for capture', async () => {
    jest.resetModules();
    jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: mockedSpawnSync,
    }));
    const { execModuleWithEarlyExitDetection } = await import('./exec.js');

    mockedSpawnSync.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: null,
      stderr: Buffer.from(''),
      pid: 1234,
      output: [null, null, Buffer.from('')],
    } as unknown as SpawnSyncReturns<Buffer>);

    const now = Date.now();
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now + 100);

    const descriptor = createDescriptor();
    const moduleInfo = { id: 'test-mod', runtime: 'nodejs', entry: 'index.ts' };
    const logger = new Logger(false);

    expect(() => execModuleWithEarlyExitDetection(descriptor, moduleInfo, logger))
      .toThrow('process.exit(0)');

    // Verify spawnSync was called with piped stderr
    const callArgs = mockedSpawnSync.mock.calls[0];
    const options = callArgs[2] as { stdio: unknown[] };
    expect(options.stdio).toEqual(['inherit', 'inherit', 'pipe']);
  });

  it('should handle signal termination', async () => {
    jest.resetModules();
    jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: mockedSpawnSync,
    }));
    const { execModuleWithEarlyExitDetection } = await import('./exec.js');

    mockedSpawnSync.mockReturnValue({
      status: null,
      signal: 'SIGTERM',
      error: undefined,
      stdout: null,
      stderr: Buffer.from(''),
      pid: 1234,
      output: [null, null, Buffer.from('')],
    } as unknown as SpawnSyncReturns<Buffer>);

    const now = Date.now();
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now + 100);

    const descriptor = createDescriptor();
    const moduleInfo = { id: 'test-mod', runtime: 'nodejs', entry: 'index.ts' };
    const logger = new Logger(false);

    expect(() => execModuleWithEarlyExitDetection(descriptor, moduleInfo, logger))
      .toThrow('process.exit(143)'); // 128 + 15 (SIGTERM)
  });
});
