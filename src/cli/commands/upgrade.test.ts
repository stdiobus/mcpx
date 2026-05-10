/**
 * Tests for `mcpx upgrade` command.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { upgradeCommand } from './upgrade.js';
import { Logger } from '../../core/logger.js';
import type { RegistryClient, RegistryEntry } from '../../registry/client.js';
import type { ParsedArgs } from '../parser.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTempRoot(): string {
  const root = join(tmpdir(), `mcpx-upgrade-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'modules'), { recursive: true });
  return root;
}

function makeArgs(moduleId?: string, json = false): ParsedArgs {
  return {
    command: 'upgrade',
    moduleId,
    extraArgs: [],
    flags: { verbose: false, json },
  };
}

function createModuleDir(root: string, id: string, version: string): string {
  const dir = join(root, 'modules', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'module.json'), JSON.stringify({
    id,
    name: `Module ${id}`,
    runtime: 'nodejs',
    entry: 'index.ts',
    version,
  }));
  return dir;
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

function createBareRepo(): string {
  const workDir = join(tmpdir(), `mcpx-work-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const bareRepo = join(tmpdir(), `mcpx-bare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
  execSync('git init', { cwd: workDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: workDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: workDir, stdio: 'pipe' });
  writeFileSync(join(workDir, 'module.json'), JSON.stringify({
    id: 'test-module',
    name: 'Test Module',
    runtime: 'nodejs',
    entry: 'index.ts',
    version: '2.0.0',
  }));
  execSync('git add .', { cwd: workDir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: workDir, stdio: 'pipe' });
  execSync(`git clone --bare "${workDir}" "${bareRepo}"`, { stdio: 'pipe' });
  rmSync(workDir, { recursive: true, force: true });
  return bareRepo;
}

const sampleEntry: RegistryEntry = {
  id: 'test-module',
  name: 'Test Module',
  description: 'A test module',
  gitUrl: 'https://github.com/example/test-module.git',
  latestVersion: '2.0.0',
  runtimes: ['nodejs'],
  publishedAt: '2024-01-01T00:00:00Z',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('upgradeCommand', () => {
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

  describe('no modules installed', () => {
    it('returns exit code 1 when no modules are installed', async () => {
      const registry = createMockRegistry(new Map());
      const exitCode = await upgradeCommand({
        root,
        args: makeArgs(),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(1);
    });

    it('reports error to stderr when no modules installed', async () => {
      const registry = createMockRegistry(new Map());
      await upgradeCommand({
        root,
        args: makeArgs(),
        logger,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('No modules installed');
      expect(output).toContain('mcpx install');
    });

    it('outputs JSON error when no modules installed and --json', async () => {
      const registry = createMockRegistry(new Map());
      await upgradeCommand({
        root,
        args: makeArgs(undefined, true),
        logger,
        registryClient: registry,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('No modules installed');
    });
  });

  describe('specific module not installed', () => {
    it('returns exit code 1 when specified module is not installed', async () => {
      createModuleDir(root, 'other-module', '1.0.0');
      const registry = createMockRegistry(new Map([['nonexistent', sampleEntry]]));

      const exitCode = await upgradeCommand({
        root,
        args: makeArgs('nonexistent'),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(1);
    });

    it('suggests mcpx list and mcpx install when module not installed', async () => {
      createModuleDir(root, 'other-module', '1.0.0');
      const registry = createMockRegistry(new Map());

      await upgradeCommand({
        root,
        args: makeArgs('nonexistent'),
        logger,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('not installed');
      expect(output).toContain('mcpx list');
    });
  });

  describe('all modules up to date', () => {
    it('returns exit code 0 when module is already at latest version', async () => {
      createModuleDir(root, 'test-module', '2.0.0');
      const registry = createMockRegistry(new Map([['test-module', sampleEntry]]));

      const exitCode = await upgradeCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(0);
    });

    it('reports all modules up to date to stderr', async () => {
      createModuleDir(root, 'test-module', '2.0.0');
      const registry = createMockRegistry(new Map([['test-module', sampleEntry]]));

      await upgradeCommand({
        root,
        args: makeArgs(),
        logger,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('up to date');
    });

    it('outputs JSON with no upgrades when all up to date', async () => {
      createModuleDir(root, 'test-module', '2.0.0');
      const registry = createMockRegistry(new Map([['test-module', sampleEntry]]));

      await upgradeCommand({
        root,
        args: makeArgs(undefined, true),
        logger,
        registryClient: registry,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(true);
      expect(parsed.results[0].upgraded).toBe(false);
    });
  });

  describe('module not in registry', () => {
    it('skips modules not found in registry without error', async () => {
      createModuleDir(root, 'local-only-module', '1.0.0');
      const registry = createMockRegistry(new Map());

      const exitCode = await upgradeCommand({
        root,
        args: makeArgs(),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(0);
    });
  });

  describe('registry errors', () => {
    it('returns exit code 1 when registry query fails', async () => {
      createModuleDir(root, 'test-module', '1.0.0');
      const registry = createFailingRegistry(new Error('Network timeout'));

      const exitCode = await upgradeCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(1);
    });

    it('reports registry error in results', async () => {
      createModuleDir(root, 'test-module', '1.0.0');
      const registry = createFailingRegistry(new Error('Network timeout'));

      await upgradeCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('Failed to upgrade');
      expect(output).toContain('Network timeout');
    });
  });

  describe('successful upgrade', () => {
    let bareRepo: string;

    beforeEach(() => {
      bareRepo = createBareRepo();
    });

    afterEach(() => {
      rmSync(bareRepo, { recursive: true, force: true });
    });

    it('returns exit code 0 on successful upgrade', async () => {
      createModuleDir(root, 'test-module', '1.0.0');
      const entryWithLocalRepo: RegistryEntry = { ...sampleEntry, gitUrl: bareRepo };
      const registry = createMockRegistry(new Map([['test-module', entryWithLocalRepo]]));

      const exitCode = await upgradeCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(0);
    });

    it('removes old directory and clones new version', async () => {
      const moduleDir = createModuleDir(root, 'test-module', '1.0.0');
      const entryWithLocalRepo: RegistryEntry = { ...sampleEntry, gitUrl: bareRepo };
      const registry = createMockRegistry(new Map([['test-module', entryWithLocalRepo]]));

      await upgradeCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      // The directory should still exist (re-cloned)
      expect(existsSync(join(root, 'modules', 'test-module'))).toBe(true);
      // The new module.json should have version 2.0.0 (from the bare repo)
      const content = readFileSync(join(root, 'modules', 'test-module', 'module.json'), 'utf-8');
      const manifest = JSON.parse(content);
      expect(manifest.version).toBe('2.0.0');
    });

    it('reports upgrade with old and new version to stderr', async () => {
      createModuleDir(root, 'test-module', '1.0.0');
      const entryWithLocalRepo: RegistryEntry = { ...sampleEntry, gitUrl: bareRepo };
      const registry = createMockRegistry(new Map([['test-module', entryWithLocalRepo]]));

      await upgradeCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      const output = stderrSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('Upgraded');
      expect(output).toContain('1.0.0');
      expect(output).toContain('2.0.0');
    });

    it('outputs JSON with upgrade results when --json flag is set', async () => {
      createModuleDir(root, 'test-module', '1.0.0');
      const entryWithLocalRepo: RegistryEntry = { ...sampleEntry, gitUrl: bareRepo };
      const registry = createMockRegistry(new Map([['test-module', entryWithLocalRepo]]));

      await upgradeCommand({
        root,
        args: makeArgs('test-module', true),
        logger,
        registryClient: registry,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(true);
      expect(parsed.results[0].upgraded).toBe(true);
      expect(parsed.results[0].previousVersion).toBe('1.0.0');
      expect(parsed.results[0].newVersion).toBe('2.0.0');
    });
  });

  describe('upgrade all modules', () => {
    let bareRepo: string;

    beforeEach(() => {
      bareRepo = createBareRepo();
    });

    afterEach(() => {
      rmSync(bareRepo, { recursive: true, force: true });
    });

    it('upgrades all modules that have newer versions', async () => {
      createModuleDir(root, 'test-module', '1.0.0');
      createModuleDir(root, 'other-module', '3.0.0');

      const otherEntry: RegistryEntry = {
        ...sampleEntry,
        id: 'other-module',
        latestVersion: '3.0.0', // same version, no upgrade needed
      };

      const entryWithLocalRepo: RegistryEntry = { ...sampleEntry, gitUrl: bareRepo };
      const registry = createMockRegistry(new Map([
        ['test-module', entryWithLocalRepo],
        ['other-module', otherEntry],
      ]));

      await upgradeCommand({
        root,
        args: makeArgs(undefined, true),
        logger,
        registryClient: registry,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(true);

      const testResult = parsed.results.find((r: any) => r.id === 'test-module');
      const otherResult = parsed.results.find((r: any) => r.id === 'other-module');
      expect(testResult.upgraded).toBe(true);
      expect(otherResult.upgraded).toBe(false);
    });
  });

  describe('git clone failure during upgrade', () => {
    it('returns exit code 1 when git clone fails', async () => {
      createModuleDir(root, 'test-module', '1.0.0');
      const entryWithBadUrl: RegistryEntry = {
        ...sampleEntry,
        gitUrl: 'https://invalid-url-that-does-not-exist.example.com/repo.git',
      };
      const registry = createMockRegistry(new Map([['test-module', entryWithBadUrl]]));

      const exitCode = await upgradeCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient: registry,
      });

      expect(exitCode).toBe(1);
    });

    it('reports clone failure in results', async () => {
      createModuleDir(root, 'test-module', '1.0.0');
      const entryWithBadUrl: RegistryEntry = {
        ...sampleEntry,
        gitUrl: 'https://invalid-url-that-does-not-exist.example.com/repo.git',
      };
      const registry = createMockRegistry(new Map([['test-module', entryWithBadUrl]]));

      await upgradeCommand({
        root,
        args: makeArgs('test-module', true),
        logger,
        registryClient: registry,
      });

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(false);
      expect(parsed.results[0].error).toContain('Failed to clone');
    });
  });
});
