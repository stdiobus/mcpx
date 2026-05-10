/**
 * Integration tests for the `mcpx upgrade` command with real git repos and HTTP registry.
 *
 * These tests exercise the REAL upgrade flow end-to-end:
 * - Create bare git repos with real module content
 * - Start real HTTP servers as mock registries
 * - Call the real upgradeCommand with real filesystem operations
 * - Verify real file changes on disk
 *
 * _Requirements: 12.4, 12.5_
 *
 * @module __tests__/integration/registry-upgrade
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import * as http from 'node:http';
import { upgradeCommand } from '../../cli/commands/upgrade.js';
import { Logger } from '../../core/logger.js';
import type { RegistryClient, RegistryEntry } from '../../registry/client.js';
import type { ParsedArgs } from '../../cli/parser.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const TEST_TIMEOUT = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Creates a temporary module root with a modules/ directory.
 * Uses realpathSync to resolve symlinks (e.g., /var → /private/var on macOS).
 */
function createTempRoot(): { root: string; modulesDir: string } {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'mcpx-upgrade-integ-')),
  );
  const modulesDir = join(root, 'modules');
  mkdirSync(modulesDir, { recursive: true });
  return { root, modulesDir };
}

/**
 * Creates a bare git repository containing a module with the specified version.
 * Returns the path to the bare repo (usable as a git URL).
 */
function createBareRepoWithVersion(
  moduleId: string,
  version: string,
  extraFiles?: Record<string, string>,
): string {
  const workDir = realpathSync(
    mkdtempSync(join(tmpdir(), `mcpx-work-${moduleId}-`)),
  );
  const bareRepo = realpathSync(
    mkdtempSync(join(tmpdir(), `mcpx-bare-${moduleId}-`)),
  );

  // Remove the bare repo dir so git clone --bare can create it fresh
  rmSync(bareRepo, { recursive: true, force: true });

  // Initialize work repo
  execSync('git init', { cwd: workDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: workDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: workDir, stdio: 'pipe' });

  // Write module.json
  const manifest = {
    id: moduleId,
    name: `Module ${moduleId}`,
    runtime: 'nodejs',
    entry: 'index.ts',
    version,
  };
  writeFileSync(join(workDir, 'module.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  // Write entry file
  writeFileSync(join(workDir, 'index.ts'), `// ${moduleId} v${version}\nconsole.log("hello");\n`, 'utf-8');

  // Write any extra files
  if (extraFiles) {
    for (const [name, content] of Object.entries(extraFiles)) {
      writeFileSync(join(workDir, name), content, 'utf-8');
    }
  }

  // Commit
  execSync('git add .', { cwd: workDir, stdio: 'pipe' });
  execSync(`git commit -m "v${version}"`, { cwd: workDir, stdio: 'pipe' });

  // Create bare clone
  execSync(`git clone --bare "${workDir}" "${bareRepo}"`, { stdio: 'pipe' });

  // Clean up work dir
  rmSync(workDir, { recursive: true, force: true });

  return bareRepo;
}

/**
 * Updates a bare git repository to a new version by pushing a new commit.
 */
function updateBareRepoToVersion(
  bareRepo: string,
  moduleId: string,
  newVersion: string,
  extraFiles?: Record<string, string>,
): void {
  const workDir = realpathSync(
    mkdtempSync(join(tmpdir(), `mcpx-update-${moduleId}-`)),
  );

  // Clone from bare repo
  execSync(`git clone "${bareRepo}" "${workDir}"`, { stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: workDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: workDir, stdio: 'pipe' });

  // Detect the current branch name (could be main or master depending on git config)
  const branchName = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workDir, encoding: 'utf-8' }).trim();

  // Remove all tracked files except .git to simulate a clean new version
  const trackedFiles = execSync('git ls-files', { cwd: workDir, encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const file of trackedFiles) {
    const filePath = join(workDir, file);
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  }

  // Write module.json with new version
  const manifest = {
    id: moduleId,
    name: `Module ${moduleId}`,
    runtime: 'nodejs',
    entry: 'index.ts',
    version: newVersion,
  };
  writeFileSync(join(workDir, 'module.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  // Write entry file
  writeFileSync(join(workDir, 'index.ts'), `// ${moduleId} v${newVersion}\nconsole.log("hello v${newVersion}");\n`, 'utf-8');

  // Write any extra files
  if (extraFiles) {
    for (const [name, content] of Object.entries(extraFiles)) {
      writeFileSync(join(workDir, name), content, 'utf-8');
    }
  }

  // Commit and push (git add -A stages removals too)
  execSync('git add -A', { cwd: workDir, stdio: 'pipe' });
  execSync(`git commit -m "v${newVersion}"`, { cwd: workDir, stdio: 'pipe' });
  execSync(`git push origin ${branchName}`, { cwd: workDir, stdio: 'pipe' });

  // Clean up work dir
  rmSync(workDir, { recursive: true, force: true });
}

/**
 * Installs a module from a bare git repo into the temp root (simulates prior install).
 */
function installModuleFromRepo(bareRepo: string, modulesDir: string, moduleId: string): string {
  const targetDir = join(modulesDir, moduleId);
  execSync(`git clone "${bareRepo}" "${targetDir}"`, { stdio: 'pipe' });
  return targetDir;
}

/**
 * Creates a real HTTP server that acts as a mock registry.
 * Returns the server and its base URL.
 */
function createMockRegistryServer(
  modules: Map<string, RegistryEntry>,
): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);

      // GET /modules/:id
      const moduleMatch = url.pathname.match(/^\/modules\/([^/?]+)$/);
      if (moduleMatch && req.method === 'GET') {
        const id = decodeURIComponent(moduleMatch[1]);
        const entry = modules.get(id);
        if (entry) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(entry));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
        return;
      }

      // GET /modules?q=...
      if (url.pathname === '/modules' && req.method === 'GET') {
        const results = [...modules.values()];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

/**
 * Creates a RegistryClient backed by a real HTTP server.
 */
function createHttpRegistryClient(baseUrl: string): RegistryClient {
  return {
    async search(query: string): Promise<RegistryEntry[]> {
      const url = `${baseUrl}/modules?q=${encodeURIComponent(query)}&limit=50`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Registry search failed: ${res.status}`);
      return res.json() as Promise<RegistryEntry[]>;
    },
    async getModule(id: string): Promise<RegistryEntry | null> {
      const url = `${baseUrl}/modules/${encodeURIComponent(id)}`;
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Registry lookup failed: ${res.status}`);
      return res.json() as Promise<RegistryEntry>;
    },
    async publish(): Promise<void> { },
  };
}

function makeArgs(moduleId?: string, json = false): ParsedArgs {
  return {
    command: 'upgrade',
    moduleId,
    extraArgs: [],
    flags: { verbose: false, json },
  };
}

/**
 * Captures stderr output from the upgrade command.
 */
function captureStderr(fn: () => Promise<number>): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origStdoutWrite = process.stdout.write.bind(process.stdout);

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;

  return fn().then((exitCode) => {
    process.stderr.write = origStderrWrite;
    process.stdout.write = origStdoutWrite;
    return { exitCode, stderr: stderrChunks.join(''), stdout: stdoutChunks.join('') };
  }).catch((err) => {
    process.stderr.write = origStderrWrite;
    process.stdout.write = origStdoutWrite;
    throw err;
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Integration: Registry Upgrade Flow', () => {
  let root: string;
  let modulesDir: string;
  let server: http.Server;
  let baseUrl: string;
  let bareRepo: string;
  const cleanupPaths: string[] = [];

  beforeEach(async () => {
    const temp = createTempRoot();
    root = temp.root;
    modulesDir = temp.modulesDir;
    cleanupPaths.push(root);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  describe('single module upgrade from v1.0.0 to v2.0.0', () => {
    it('upgrades module directory to new version with updated module.json', async () => {
      // Create bare git repo with v1.0.0
      bareRepo = createBareRepoWithVersion('test-module', '1.0.0', {
        'old-file.txt': 'this file exists in v1 only',
      });
      cleanupPaths.push(bareRepo);

      // Install v1.0.0 to temp root
      installModuleFromRepo(bareRepo, modulesDir, 'test-module');

      // Verify v1.0.0 is installed
      const installedManifest = JSON.parse(
        readFileSync(join(modulesDir, 'test-module', 'module.json'), 'utf-8'),
      );
      expect(installedManifest.version).toBe('1.0.0');

      // Update bare repo to v2.0.0
      updateBareRepoToVersion(bareRepo, 'test-module', '2.0.0');

      // Create mock registry returning latestVersion: "2.0.0"
      const registryModules = new Map<string, RegistryEntry>([
        ['test-module', {
          id: 'test-module',
          name: 'Module test-module',
          description: 'A test module',
          gitUrl: bareRepo,
          latestVersion: '2.0.0',
          runtimes: ['nodejs'],
          publishedAt: new Date().toISOString(),
        }],
      ]);

      const serverResult = await createMockRegistryServer(registryModules);
      server = serverResult.server;
      baseUrl = serverResult.baseUrl;

      const registryClient = createHttpRegistryClient(baseUrl);
      const logger = new Logger(false);

      // Run upgrade command
      const { exitCode } = await captureStderr(() =>
        upgradeCommand({
          root,
          args: makeArgs('test-module'),
          logger,
          registryClient,
        }),
      );

      // Verify results
      expect(exitCode).toBe(0);

      // Module directory still exists
      expect(existsSync(join(modulesDir, 'test-module'))).toBe(true);

      // module.json now has version "2.0.0"
      const updatedManifest = JSON.parse(
        readFileSync(join(modulesDir, 'test-module', 'module.json'), 'utf-8'),
      );
      expect(updatedManifest.version).toBe('2.0.0');

      // Entry file has new content
      const entryContent = readFileSync(join(modulesDir, 'test-module', 'index.ts'), 'utf-8');
      expect(entryContent).toContain('v2.0.0');

      // Old version files are gone (the old-file.txt from v1 is not in v2)
      expect(existsSync(join(modulesDir, 'test-module', 'old-file.txt'))).toBe(false);
    }, TEST_TIMEOUT);
  });

  describe('already up to date', () => {
    it('returns exitCode 0 and reports "up to date" when version matches', async () => {
      // Create bare repo with v2.0.0
      bareRepo = createBareRepoWithVersion('test-module', '2.0.0');
      cleanupPaths.push(bareRepo);

      // Install v2.0.0 to temp root
      installModuleFromRepo(bareRepo, modulesDir, 'test-module');

      // Create mock registry also returning latestVersion: "2.0.0"
      const registryModules = new Map<string, RegistryEntry>([
        ['test-module', {
          id: 'test-module',
          name: 'Module test-module',
          description: 'A test module',
          gitUrl: bareRepo,
          latestVersion: '2.0.0',
          runtimes: ['nodejs'],
          publishedAt: new Date().toISOString(),
        }],
      ]);

      const serverResult = await createMockRegistryServer(registryModules);
      server = serverResult.server;
      baseUrl = serverResult.baseUrl;

      const registryClient = createHttpRegistryClient(baseUrl);
      const logger = new Logger(false);

      // Run upgrade command
      const { exitCode, stderr } = await captureStderr(() =>
        upgradeCommand({
          root,
          args: makeArgs('test-module'),
          logger,
          registryClient,
        }),
      );

      // Verify: exitCode 0, stderr says "up to date"
      expect(exitCode).toBe(0);
      expect(stderr).toContain('up to date');

      // module.json still has version "2.0.0" (unchanged)
      const manifest = JSON.parse(
        readFileSync(join(modulesDir, 'test-module', 'module.json'), 'utf-8'),
      );
      expect(manifest.version).toBe('2.0.0');
    }, TEST_TIMEOUT);
  });

  describe('upgrade all outdated modules (no args)', () => {
    it('upgrades all modules that have newer versions available', async () => {
      // Create two modules: one outdated, one up-to-date
      const bareRepoA = createBareRepoWithVersion('module-a', '1.0.0');
      cleanupPaths.push(bareRepoA);
      const bareRepoB = createBareRepoWithVersion('module-b', '3.0.0');
      cleanupPaths.push(bareRepoB);

      // Install both
      installModuleFromRepo(bareRepoA, modulesDir, 'module-a');
      installModuleFromRepo(bareRepoB, modulesDir, 'module-b');

      // Update module-a bare repo to v2.0.0
      updateBareRepoToVersion(bareRepoA, 'module-a', '2.0.0');

      // Create mock registry: module-a has v2.0.0 available, module-b is at v3.0.0 (same)
      const registryModules = new Map<string, RegistryEntry>([
        ['module-a', {
          id: 'module-a',
          name: 'Module A',
          description: 'Module A',
          gitUrl: bareRepoA,
          latestVersion: '2.0.0',
          runtimes: ['nodejs'],
          publishedAt: new Date().toISOString(),
        }],
        ['module-b', {
          id: 'module-b',
          name: 'Module B',
          description: 'Module B',
          gitUrl: bareRepoB,
          latestVersion: '3.0.0',
          runtimes: ['nodejs'],
          publishedAt: new Date().toISOString(),
        }],
      ]);

      const serverResult = await createMockRegistryServer(registryModules);
      server = serverResult.server;
      baseUrl = serverResult.baseUrl;

      const registryClient = createHttpRegistryClient(baseUrl);
      const logger = new Logger(false);

      // Run upgrade with no module ID (upgrade all)
      const { exitCode, stdout } = await captureStderr(() =>
        upgradeCommand({
          root,
          args: makeArgs(undefined, true), // --json for structured output
          logger,
          registryClient,
        }),
      );

      expect(exitCode).toBe(0);

      // Parse JSON output
      const output = JSON.parse(stdout);
      expect(output.success).toBe(true);

      // module-a should be upgraded
      const resultA = output.results.find((r: { id: string }) => r.id === 'module-a');
      expect(resultA).toBeDefined();
      expect(resultA.upgraded).toBe(true);
      expect(resultA.previousVersion).toBe('1.0.0');
      expect(resultA.newVersion).toBe('2.0.0');

      // module-b should NOT be upgraded (already at latest)
      const resultB = output.results.find((r: { id: string }) => r.id === 'module-b');
      expect(resultB).toBeDefined();
      expect(resultB.upgraded).toBe(false);

      // Verify real files on disk
      const manifestA = JSON.parse(
        readFileSync(join(modulesDir, 'module-a', 'module.json'), 'utf-8'),
      );
      expect(manifestA.version).toBe('2.0.0');

      const manifestB = JSON.parse(
        readFileSync(join(modulesDir, 'module-b', 'module.json'), 'utf-8'),
      );
      expect(manifestB.version).toBe('3.0.0');
    }, TEST_TIMEOUT);
  });
});
