/**
 * Tests for `mcpx install` command.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { installCommand } from './install.js';
import { Logger } from '../../core/logger.js';
import type { RegistryClient, RegistryEntry } from '../../registry/client.js';
import type { ParsedArgs } from '../parser.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTempRoot(): string {
  const root = join(tmpdir(), `mcpx-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'modules'), { recursive: true });
  return root;
}

function makeArgs(moduleId?: string, json = false): ParsedArgs {
  return {
    command: 'install',
    moduleId,
    extraArgs: [],
    flags: { verbose: false, json },
  };
}

function createMockRegistry(modules: Map<string, RegistryEntry>): RegistryClient {
  return {
    async search(_query: string): Promise<RegistryEntry[]> {
      return [...modules.values()];
    },
    async getModule(id: string): Promise<RegistryEntry | null> {
      return modules.get(id) ?? null;
    },
    async publish(): Promise<void> { },
  };
}

function createFailingRegistry(error: Error): RegistryClient {
  return {
    async search(): Promise<RegistryEntry[]> {
      throw error;
    },
    async getModule(): Promise<RegistryEntry | null> {
      throw error;
    },
    async publish(): Promise<void> {
      throw error;
    },
  };
}

const sampleEntry: RegistryEntry = {
  id: 'test-module',
  name: 'Test Module',
  description: 'A test module',
  gitUrl: 'https://github.com/example/test-module.git',
  latestVersion: '1.0.0',
  runtimes: ['nodejs'],
  publishedAt: '2024-01-01T00:00:00Z',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('installCommand', () => {
  let root: string;
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  const logger = new Logger(false);

  beforeEach(() => {
    root = createTempRoot();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  describe('argument validation', () => {
    it('returns exit code 1 when no module name is provided', async () => {
      const registry = createMockRegistry(new Map());
      const exitCode = await installCommand({
        root,
        args: makeArgs(undefined),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(1);
    });

    it('reports error to stderr when no module name is provided', async () => {
      const registry = createMockRegistry(new Map());
      await installCommand({
        root,
        args: makeArgs(undefined),
        logger,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('No module name specified');
      expect(output).toContain('Usage: mcpx install <module_name>');
    });

    it('outputs JSON error when no module name and --json flag', async () => {
      const registry = createMockRegistry(new Map());
      await installCommand({
        root,
        args: makeArgs(undefined, true),
        logger,
        registryClient: registry,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('No module name specified');
    });
  });

  describe('module not found in registry', () => {
    it('returns exit code 1 when module is not in registry', async () => {
      const registry = createMockRegistry(new Map());
      const exitCode = await installCommand({
        root,
        args: makeArgs('nonexistent-module'),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(1);
    });

    it('suggests mcpx search when module not found', async () => {
      const registry = createMockRegistry(new Map());
      await installCommand({
        root,
        args: makeArgs('nonexistent-module'),
        logger,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('not found in the registry');
      expect(output).toContain('mcpx search');
    });

    it('outputs JSON with suggestion when module not found and --json', async () => {
      const registry = createMockRegistry(new Map());
      await installCommand({
        root,
        args: makeArgs('nonexistent-module', true),
        logger,
        registryClient: registry,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('not found in the registry');
      expect(parsed.suggestion).toContain('mcpx search');
    });
  });

  describe('module already installed', () => {
    it('returns exit code 1 when module directory already exists', async () => {
      // Create the module directory to simulate already installed
      mkdirSync(join(root, 'modules', 'test-module'), { recursive: true });

      const registry = createMockRegistry(new Map([['test-module', sampleEntry]]));
      const exitCode = await installCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(1);
    });

    it('suggests mcpx upgrade when module already installed', async () => {
      mkdirSync(join(root, 'modules', 'test-module'), { recursive: true });

      const registry = createMockRegistry(new Map([['test-module', sampleEntry]]));
      await installCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('already installed');
      expect(output).toContain('mcpx upgrade');
    });

    it('outputs JSON with suggestion when already installed and --json', async () => {
      mkdirSync(join(root, 'modules', 'test-module'), { recursive: true });

      const registry = createMockRegistry(new Map([['test-module', sampleEntry]]));
      await installCommand({
        root,
        args: makeArgs('test-module', true),
        logger,
        registryClient: registry,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('already installed');
      expect(parsed.suggestion).toContain('mcpx upgrade');
    });
  });

  describe('registry errors', () => {
    it('returns exit code 1 when registry query fails', async () => {
      const registry = createFailingRegistry(new Error('Network timeout'));
      const exitCode = await installCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(1);
    });

    it('reports network error to stderr', async () => {
      const registry = createFailingRegistry(new Error('Network timeout'));
      await installCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('Failed to query registry');
      expect(output).toContain('Network timeout');
    });
  });

  describe('successful installation', () => {
    let bareRepo: string;

    function createBareRepo(): string {
      const repo = join(tmpdir(), `mcpx-bare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      // Create a working repo with at least one commit, then clone as bare
      const workDir = join(tmpdir(), `mcpx-work-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(workDir, { recursive: true });
      execSync('git init', { cwd: workDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: workDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: workDir, stdio: 'pipe' });
      writeFileSync(join(workDir, 'README.md'), '# test');
      execSync('git add .', { cwd: workDir, stdio: 'pipe' });
      execSync('git commit -m "init"', { cwd: workDir, stdio: 'pipe' });
      execSync(`git clone --bare "${workDir}" "${repo}"`, { stdio: 'pipe' });
      rmSync(workDir, { recursive: true, force: true });
      return repo;
    }

    beforeEach(() => {
      bareRepo = createBareRepo();
    });

    afterEach(() => {
      rmSync(bareRepo, { recursive: true, force: true });
    });

    it('returns exit code 0 on successful git clone', async () => {
      const entryWithLocalRepo: RegistryEntry = {
        ...sampleEntry,
        gitUrl: bareRepo,
      };
      const localRegistry = createMockRegistry(new Map([['test-module', entryWithLocalRepo]]));

      const exitCode = await installCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: localRegistry,
      });

      expect(exitCode).toBe(0);
      expect(existsSync(join(root, 'modules', 'test-module'))).toBe(true);
    });

    it('outputs success JSON when --json flag is set', async () => {
      const entryWithLocalRepo: RegistryEntry = {
        ...sampleEntry,
        gitUrl: bareRepo,
      };
      const localRegistry = createMockRegistry(new Map([['test-module', entryWithLocalRepo]]));

      await installCommand({
        root,
        args: makeArgs('test-module', true),
        logger,
        registryClient: localRegistry,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(true);
      expect(parsed.moduleId).toBe('test-module');
      expect(parsed.installPath).toContain('test-module');
    });

    it('reports success to stderr in human-readable mode', async () => {
      const entryWithLocalRepo: RegistryEntry = {
        ...sampleEntry,
        gitUrl: bareRepo,
      };
      const localRegistry = createMockRegistry(new Map([['test-module', entryWithLocalRepo]]));

      await installCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: localRegistry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('Installed');
      expect(output).toContain('test-module');
    });
  });

  describe('git clone failure', () => {
    it('returns exit code 1 when git clone fails', async () => {
      const entryWithBadUrl: RegistryEntry = {
        ...sampleEntry,
        gitUrl: 'https://invalid-url-that-does-not-exist.example.com/repo.git',
      };
      const registry = createMockRegistry(new Map([['test-module', entryWithBadUrl]]));

      const exitCode = await installCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(1);
    });

    it('reports clone failure to stderr', async () => {
      const entryWithBadUrl: RegistryEntry = {
        ...sampleEntry,
        gitUrl: 'https://invalid-url-that-does-not-exist.example.com/repo.git',
      };
      const registry = createMockRegistry(new Map([['test-module', entryWithBadUrl]]));

      await installCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('Failed to clone');
    });
  });
});
