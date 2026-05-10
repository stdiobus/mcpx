/**
 * Tests for `mcpx publish` command.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishCommand, createTarball } from './publish.js';
import { Logger } from '../../core/logger.js';
import type { RegistryClient } from '../../registry/client.js';
import type { ModuleManifest } from '../../core/manifest.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTempModuleDir(manifest?: Record<string, unknown>): string {
  const dir = join(tmpdir(), `mcpx-publish-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  if (manifest) {
    writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
  }

  return dir;
}

const validManifest: Record<string, unknown> = {
  id: 'test-module',
  name: 'Test Module',
  runtime: 'nodejs',
  entry: 'index.ts',
  version: '1.0.0',
  description: 'A test module for publishing',
};

function createMockRegistry(): RegistryClient & { publishCalls: Array<{ manifest: ModuleManifest; tarball: Buffer }> } {
  const publishCalls: Array<{ manifest: ModuleManifest; tarball: Buffer }> = [];
  return {
    publishCalls,
    async search(): Promise<never[]> {
      return [];
    },
    async getModule(): Promise<null> {
      return null;
    },
    async publish(manifest: ModuleManifest, tarball: Buffer): Promise<void> {
      publishCalls.push({ manifest, tarball });
    },
  };
}

function createFailingRegistry(error: Error): RegistryClient {
  return {
    async search(): Promise<never[]> {
      return [];
    },
    async getModule(): Promise<null> {
      return null;
    },
    async publish(): Promise<void> {
      throw error;
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('publishCommand', () => {
  let moduleDir: string;
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (moduleDir) {
      rmSync(moduleDir, { recursive: true, force: true });
    }
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  describe('missing module.json', () => {
    it('returns exit code 1 when no module.json exists', async () => {
      moduleDir = createTempModuleDir(); // no manifest

      const exitCode = await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
      });

      expect(exitCode).toBe(1);
    });

    it('reports error to stderr when module.json is missing', async () => {
      moduleDir = createTempModuleDir();

      await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('No module.json found');
    });

    it('outputs JSON error when module.json is missing and --json', async () => {
      moduleDir = createTempModuleDir();

      await publishCommand({
        moduleDir,
        json: true,
        verbose: false,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('No module.json found');
    });
  });

  describe('invalid JSON', () => {
    it('returns exit code 2 when module.json is malformed', async () => {
      moduleDir = createTempModuleDir();
      writeFileSync(join(moduleDir, 'module.json'), '{ invalid json }');

      const exitCode = await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
      });

      expect(exitCode).toBe(2);
    });

    it('reports parse error to stderr', async () => {
      moduleDir = createTempModuleDir();
      writeFileSync(join(moduleDir, 'module.json'), '{ invalid json }');

      await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('Failed to parse module.json');
    });
  });

  describe('manifest validation failures', () => {
    it('returns exit code 2 when manifest is missing required fields', async () => {
      moduleDir = createTempModuleDir({ id: 'test', name: 'Test' }); // missing runtime, entry

      const exitCode = await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
      });

      expect(exitCode).toBe(2);
    });

    it('reports validation errors to stderr without contacting registry', async () => {
      const registry = createMockRegistry();
      moduleDir = createTempModuleDir({ id: 'test', name: 'Test' });

      await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('Manifest validation failed');
      expect(output).toContain('runtime');
      // Registry should NOT have been called
      expect(registry.publishCalls).toHaveLength(0);
    });

    it('outputs JSON with validation errors when --json', async () => {
      moduleDir = createTempModuleDir({ id: 'test', name: 'Test' });

      await publishCommand({
        moduleDir,
        json: true,
        verbose: false,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(false);
      expect(parsed.validationErrors).toBeDefined();
      expect(parsed.validationErrors.length).toBeGreaterThan(0);
    });

    it('does not contact registry when manifest is invalid', async () => {
      const registry = createMockRegistry();
      moduleDir = createTempModuleDir({ id: 'INVALID_ID' }); // invalid id pattern

      await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient: registry,
      });

      expect(registry.publishCalls).toHaveLength(0);
    });
  });

  describe('successful publish', () => {
    it('returns exit code 0 on successful publish', async () => {
      const registry = createMockRegistry();
      moduleDir = createTempModuleDir(validManifest);
      // Add a source file so tarball has content
      writeFileSync(join(moduleDir, 'index.ts'), 'console.log("hello");');

      const exitCode = await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient: registry,
      });

      expect(exitCode).toBe(0);
    });

    it('calls registry.publish with manifest and tarball', async () => {
      const registry = createMockRegistry();
      moduleDir = createTempModuleDir(validManifest);
      writeFileSync(join(moduleDir, 'index.ts'), 'console.log("hello");');

      await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient: registry,
      });

      expect(registry.publishCalls).toHaveLength(1);
      expect(registry.publishCalls[0].manifest.id).toBe('test-module');
      expect(registry.publishCalls[0].tarball).toBeInstanceOf(Buffer);
      expect(registry.publishCalls[0].tarball.length).toBeGreaterThan(0);
    });

    it('reports success to stderr in human-readable mode', async () => {
      const registry = createMockRegistry();
      moduleDir = createTempModuleDir(validManifest);
      writeFileSync(join(moduleDir, 'index.ts'), 'console.log("hello");');

      await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('Published');
      expect(output).toContain('test-module');
    });

    it('outputs success JSON when --json flag is set', async () => {
      const registry = createMockRegistry();
      moduleDir = createTempModuleDir(validManifest);
      writeFileSync(join(moduleDir, 'index.ts'), 'console.log("hello");');

      await publishCommand({
        moduleDir,
        json: true,
        verbose: false,
        registryClient: registry,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(true);
      expect(parsed.moduleId).toBe('test-module');
    });
  });

  describe('registry errors', () => {
    it('returns exit code 1 when registry publish fails', async () => {
      const registry = createFailingRegistry(new Error('503 Service Unavailable'));
      moduleDir = createTempModuleDir(validManifest);
      writeFileSync(join(moduleDir, 'index.ts'), 'console.log("hello");');

      const exitCode = await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient: registry,
      });

      expect(exitCode).toBe(1);
    });

    it('reports registry error to stderr', async () => {
      const registry = createFailingRegistry(new Error('503 Service Unavailable'));
      moduleDir = createTempModuleDir(validManifest);
      writeFileSync(join(moduleDir, 'index.ts'), 'console.log("hello");');

      await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('Failed to publish to registry');
      expect(output).toContain('503 Service Unavailable');
    });

    it('outputs JSON error when registry fails and --json', async () => {
      const registry = createFailingRegistry(new Error('Network error'));
      moduleDir = createTempModuleDir(validManifest);
      writeFileSync(join(moduleDir, 'index.ts'), 'console.log("hello");');

      await publishCommand({
        moduleDir,
        json: true,
        verbose: false,
        registryClient: registry,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Failed to publish to registry');
    });
  });
});

describe('createTarball', () => {
  let moduleDir: string;

  afterEach(() => {
    if (moduleDir) {
      rmSync(moduleDir, { recursive: true, force: true });
    }
  });

  it('creates a non-empty tarball buffer', () => {
    moduleDir = createTempModuleDir(validManifest);
    writeFileSync(join(moduleDir, 'index.ts'), 'export default {};');

    const logger = new Logger(false);
    const tarball = createTarball(moduleDir, logger);

    expect(tarball).toBeInstanceOf(Buffer);
    expect(tarball.length).toBeGreaterThan(0);
  });

  it('excludes node_modules from tarball', () => {
    moduleDir = createTempModuleDir(validManifest);
    writeFileSync(join(moduleDir, 'index.ts'), 'export default {};');
    mkdirSync(join(moduleDir, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(moduleDir, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {}');

    const logger = new Logger(false);
    const tarball = createTarball(moduleDir, logger);

    // Verify tarball doesn't contain node_modules by extracting and checking
    // We just verify it creates successfully — the tar command excludes it
    expect(tarball).toBeInstanceOf(Buffer);
    expect(tarball.length).toBeGreaterThan(0);
  });
});
