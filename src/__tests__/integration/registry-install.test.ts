/**
 * Integration tests for `mcpx install` — Real install flow.
 *
 * These tests create REAL bare git repositories, start REAL HTTP servers
 * as mock registries, and call the REAL installCommand function to verify
 * the full install flow end-to-end.
 *
 * **Validates: Requirements 12.1, 12.9, 12.11**
 *
 * @module __tests__/integration/registry-install
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { installCommand } from '../../cli/commands/install.js';
import { Logger } from '../../core/logger.js';
import type { RegistryEntry, RegistryClient } from '../../registry/client.js';
import type { ParsedArgs } from '../../cli/parser.js';

// --- Constants ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Helper Functions ---

/**
 * Creates a temporary module root with a modules/ directory.
 */
function createTempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-reg-install-')));
  mkdirSync(join(root, 'modules'), { recursive: true });
  return root;
}

/**
 * Creates a REAL bare git repository containing a valid module.
 *
 * The repo contains:
 * - module.json with the specified manifest
 * - An entry file with the specified content
 */
function createBareRepoWithModule(manifest: Record<string, unknown>, entryContent: string): string {
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-git-work-')));
  const bareDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-git-bare-'))) + '-repo';

  // Initialize a working repo
  execSync('git init', { cwd: workDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: workDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: workDir, stdio: 'pipe' });

  // Write module files
  writeFileSync(join(workDir, 'module.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  writeFileSync(join(workDir, manifest.entry as string), entryContent, 'utf-8');

  // Commit
  execSync('git add .', { cwd: workDir, stdio: 'pipe' });
  execSync('git commit -m "Initial module commit"', { cwd: workDir, stdio: 'pipe' });

  // Clone as bare
  execSync(`git clone --bare "${workDir}" "${bareDir}"`, { stdio: 'pipe' });

  // Clean up working dir
  rmSync(workDir, { recursive: true, force: true });

  return bareDir;
}

/**
 * Starts a real HTTP server that acts as a mock registry.
 *
 * Responds to:
 * - GET /modules/<id> → returns module metadata or 404
 */
function startMockRegistry(
  modules: Map<string, RegistryEntry>,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const pathParts = url.pathname.split('/').filter(Boolean);

      // GET /modules/<id>
      if (req.method === 'GET' && pathParts[0] === 'modules' && pathParts[1]) {
        const moduleId = decodeURIComponent(pathParts[1]);
        const entry = modules.get(moduleId);

        if (entry) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(entry));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
        return;
      }

      // Default: 404
      res.writeHead(404);
      res.end('Not found');
    });

    const timer = setTimeout(() => {
      const err = new Error('Mock registry server listen timed out');
      // @ts-expect-error attach code for callers
      err.code = 'EPERM';
      server.close(() => reject(err));
    }, 1000);

    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timer);
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const baseUrl = `http://127.0.0.1:${addr.port}`;
        resolvePromise({ server, baseUrl });
        return;
      }
      reject(new Error('Failed to get server address'));
    });
  });
}

/**
 * Creates a RegistryClient backed by a real HTTP server.
 */
function createHttpRegistryClient(baseUrl: string): RegistryClient {
  return {
    async search(query: string): Promise<RegistryEntry[]> {
      const res = await fetch(`${baseUrl}/modules?q=${encodeURIComponent(query)}&limit=50`);
      return res.json() as Promise<RegistryEntry[]>;
    },
    async getModule(id: string): Promise<RegistryEntry | null> {
      const res = await fetch(`${baseUrl}/modules/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      return res.json() as Promise<RegistryEntry>;
    },
    async publish(): Promise<void> { },
  };
}

/**
 * Builds a ParsedArgs object for the install command.
 */
function makeArgs(moduleId?: string, json = false): ParsedArgs {
  return {
    command: 'install',
    moduleId,
    extraArgs: [],
    flags: { verbose: false, json },
  };
}

// --- Test Suite ---

describe('Integration: Registry Install Flow', () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];
  const logger = new Logger(false);
  let canListen = true;

  // Suppress stderr/stdout during tests
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let stdoutSpy: ReturnType<typeof jest.spyOn>;

  afterEach(() => {
    stderrSpy?.mockRestore();
    stdoutSpy?.mockRestore();
  });

  afterAll(async () => {
    // Close all servers
    for (const server of servers) {
      await new Promise<void>((r) => server.close(() => r()));
    }
    // Clean up temp directories
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function suppressOutput() {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  }

  describe('successful install', () => {
    it('installs a module from registry by cloning from git', async () => {
      if (!canListen) return;
      suppressOutput();

      // Create a real bare git repo with a valid module
      const manifest = {
        id: 'test-module',
        name: 'Test Module',
        runtime: 'nodejs',
        entry: 'index.js',
        version: '1.0.0',
        description: 'A test module for integration testing',
      };
      const entryContent = 'console.log("hello from test-module");\n';
      const bareRepo = createBareRepoWithModule(manifest, entryContent);
      tempDirs.push(bareRepo);

      // Start a mock registry that returns metadata pointing to the bare repo
      const registryModules = new Map<string, RegistryEntry>([
        [
          'test-module',
          {
            id: 'test-module',
            name: 'Test Module',
            description: 'A test module for integration testing',
            gitUrl: bareRepo,
            latestVersion: '1.0.0',
            runtimes: ['nodejs'],
            publishedAt: '2024-01-01T00:00:00Z',
          },
        ],
      ]);
      let server: Server;
      let baseUrl: string;
      try {
        const started = await startMockRegistry(registryModules);
        server = started.server;
        baseUrl = started.baseUrl;
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === 'EPERM') {
          canListen = false;
          return;
        }
        throw err;
      }
      servers.push(server);

      // Create a temp root for installation
      const root = createTempRoot();
      tempDirs.push(root);

      // Create a real HTTP registry client pointing to our mock server
      const registryClient = createHttpRegistryClient(baseUrl);

      // Call the real installCommand
      const exitCode = await installCommand({
        root,
        args: makeArgs('test-module'),
        logger,
        registryClient,
      });

      // Verify: exit code 0 (success)
      expect(exitCode).toBe(0);

      // Verify: module directory created
      const moduleDir = join(root, 'modules', 'test-module');
      expect(existsSync(moduleDir)).toBe(true);

      // Verify: module.json exists and contains correct fields
      const installedManifestPath = join(moduleDir, 'module.json');
      expect(existsSync(installedManifestPath)).toBe(true);

      const installedManifest = JSON.parse(readFileSync(installedManifestPath, 'utf-8'));
      expect(installedManifest.id).toBe('test-module');
      expect(installedManifest.name).toBe('Test Module');
      expect(installedManifest.runtime).toBe('nodejs');
      expect(installedManifest.entry).toBe('index.js');

      // Verify: entry file exists (cloned from git)
      const entryFilePath = join(moduleDir, 'index.js');
      expect(existsSync(entryFilePath)).toBe(true);

      const installedEntryContent = readFileSync(entryFilePath, 'utf-8');
      expect(installedEntryContent.replace(/\r\n/g, '\n')).toBe(entryContent.replace(/\r\n/g, '\n'));
    }, 30_000);
  });

  describe('module not found in registry', () => {
    it('exits with code 1 and stderr suggests mcpx search', async () => {
      if (!canListen) return;
      suppressOutput();

      // Start an empty mock registry (no modules registered)
      const registryModules = new Map<string, RegistryEntry>();
      let server: Server;
      let baseUrl: string;
      try {
        const started = await startMockRegistry(registryModules);
        server = started.server;
        baseUrl = started.baseUrl;
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === 'EPERM') {
          canListen = false;
          return;
        }
        throw err;
      }
      servers.push(server);

      // Create a temp root
      const root = createTempRoot();
      tempDirs.push(root);

      // Create a real HTTP registry client
      const registryClient = createHttpRegistryClient(baseUrl);

      // Call installCommand for a non-existent module
      const exitCode = await installCommand({
        root,
        args: makeArgs('nonexistent-module'),
        logger,
        registryClient,
      });

      // Verify: exit code 1
      expect(exitCode).toBe(1);

      // Verify: stderr mentions the module and suggests mcpx search
      const stderrOutput = (stderrSpy.mock.calls as Array<[string]>)
        .map((call) => call[0])
        .join('');
      expect(stderrOutput).toContain('not found');
      expect(stderrOutput.toLowerCase()).toContain('search');
    });
  });

  describe('module already installed', () => {
    it('exits with code 1 and stderr suggests mcpx upgrade', async () => {
      if (!canListen) return;
      suppressOutput();

      // Create a bare repo (needed for registry entry, though it won't be cloned)
      const manifest = {
        id: 'already-installed',
        name: 'Already Installed Module',
        runtime: 'nodejs',
        entry: 'index.js',
        version: '1.0.0',
      };
      const bareRepo = createBareRepoWithModule(manifest, 'console.log("hi");\n');
      tempDirs.push(bareRepo);

      // Start a mock registry with the module
      const registryModules = new Map<string, RegistryEntry>([
        [
          'already-installed',
          {
            id: 'already-installed',
            name: 'Already Installed Module',
            description: 'Test module',
            gitUrl: bareRepo,
            latestVersion: '1.0.0',
            runtimes: ['nodejs'],
            publishedAt: '2024-01-01T00:00:00Z',
          },
        ],
      ]);
      let server: Server;
      let baseUrl: string;
      try {
        const started = await startMockRegistry(registryModules);
        server = started.server;
        baseUrl = started.baseUrl;
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === 'EPERM') {
          canListen = false;
          return;
        }
        throw err;
      }
      servers.push(server);

      // Create a temp root with the module already installed
      const root = createTempRoot();
      tempDirs.push(root);

      // Pre-create the module directory to simulate already installed
      mkdirSync(join(root, 'modules', 'already-installed'), { recursive: true });

      // Create a real HTTP registry client
      const registryClient = createHttpRegistryClient(baseUrl);

      // Call installCommand for the already-installed module
      const exitCode = await installCommand({
        root,
        args: makeArgs('already-installed'),
        logger,
        registryClient,
      });

      // Verify: exit code 1
      expect(exitCode).toBe(1);

      // Verify: stderr mentions already installed and suggests upgrade
      const stderrOutput = (stderrSpy.mock.calls as Array<[string]>)
        .map((call) => call[0])
        .join('');
      expect(stderrOutput).toContain('already installed');
      expect(stderrOutput.toLowerCase()).toContain('upgrade');
    });
  });
});
