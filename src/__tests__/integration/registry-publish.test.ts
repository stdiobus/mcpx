/**
 * Integration tests for `mcpx publish` — Real publish flow.
 *
 * Tests the full publish flow using:
 * - Real HTTP servers (http.createServer) as mock registry accepting POST /modules
 * - Real publishCommand calls with real filesystem operations
 * - Real tarball creation and multipart form-data submission
 *
 * **Validates: Requirements 12.2, 12.10**
 *
 * @module __tests__/integration/registry-publish
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { publishCommand } from '../../cli/commands/publish.js';
import { Logger } from '../../core/logger.js';
import type { RegistryClient, RegistryEntry } from '../../registry/client.js';
import type { ParsedArgs } from '../../cli/parser.js';

// --- Helpers ---

/**
 * Represents a captured HTTP request received by the mock registry server.
 */
interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Creates a real HTTP server that accepts POST /modules and stores the payload.
 * Returns the server, its base URL, and a list of captured requests.
 */
function createMockRegistryServer(): Promise<{
  server: Server;
  baseUrl: string;
  requests: CapturedRequest[];
}> {
  return new Promise((resolvePromise, reject) => {
    const requests: CapturedRequest[] = [];

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        const body = Buffer.concat(chunks);

        requests.push({
          method: req.method ?? 'UNKNOWN',
          url: req.url ?? '/',
          headers: req.headers as Record<string, string | string[] | undefined>,
          body,
        });

        if (req.method === 'POST' && req.url === '/modules') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });

      req.on('error', (err) => {
        res.writeHead(500);
        res.end(err.message);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolvePromise({
          server,
          baseUrl: `http://127.0.0.1:${addr.port}`,
          requests,
        });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });

    server.on('error', reject);
  });
}

/**
 * Creates a RegistryClient backed by a real HTTP server.
 * Uses the real HttpRegistryClient pattern — makes actual HTTP calls.
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
    async publish(manifest: unknown, tarball: Buffer): Promise<void> {
      const formData = new FormData();
      formData.append('manifest', JSON.stringify(manifest));
      formData.append('tarball', new Blob([tarball]), `${(manifest as { id: string }).id}.tar.gz`);

      const res = await fetch(`${baseUrl}/modules`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Registry publish failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
      }
    },
  };
}

/**
 * Creates a temporary module directory with a valid module.json and source file.
 */
function createValidModuleDir(manifest?: Record<string, unknown>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-publish-integ-')));

  const defaultManifest = {
    id: 'test-publish-module',
    name: 'Test Publish Module',
    runtime: 'nodejs',
    entry: 'index.ts',
    version: '1.0.0',
    description: 'A test module for publish integration testing',
  };

  const finalManifest = manifest ?? defaultManifest;
  writeFileSync(join(dir, 'module.json'), JSON.stringify(finalManifest, null, 2), 'utf-8');

  // Create a real source file so the tarball has content
  const entry = (finalManifest as Record<string, unknown>).entry as string || 'index.ts';
  writeFileSync(join(dir, entry), 'export default function main() { return "hello"; }\n', 'utf-8');

  return dir;
}

// --- Test Suite ---

describe('Integration: Registry Publish — Real Publish Flow', () => {
  let server: Server;
  let baseUrl: string;
  let requests: CapturedRequest[];
  let tempDirs: string[];

  // Suppress stderr/stdout during tests
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let stdoutSpy: ReturnType<typeof jest.spyOn>;

  beforeAll(async () => {
    const result = await createMockRegistryServer();
    server = result.server;
    baseUrl = result.baseUrl;
    requests = result.requests;
    tempDirs = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    stderrSpy?.mockRestore();
    stdoutSpy?.mockRestore();
    // Clear captured requests between tests
    requests.length = 0;
  });

  function suppressOutput() {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  }

  describe('Successful publish: valid module sends POST /modules to registry', () => {
    it('HTTP server receives the POST request with manifest and tarball', async () => {
      suppressOutput();

      const moduleDir = createValidModuleDir();
      tempDirs.push(moduleDir);

      const registryClient = createHttpRegistryClient(baseUrl);

      const exitCode = await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient,
      });

      // Process should exit successfully
      expect(exitCode).toBe(0);

      // Server should have received exactly one POST request
      expect(requests.length).toBe(1);
      const req = requests[0];

      // Verify it was a POST to /modules
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/modules');

      // Verify the request has content
      expect(req.body.length).toBeGreaterThan(0);
    });

    it('request body contains module manifest data', async () => {
      suppressOutput();

      const manifest = {
        id: 'my-publish-test',
        name: 'My Publish Test',
        runtime: 'nodejs',
        entry: 'index.ts',
        version: '2.0.0',
        description: 'Integration test module',
      };

      const moduleDir = createValidModuleDir(manifest);
      tempDirs.push(moduleDir);

      const registryClient = createHttpRegistryClient(baseUrl);

      const exitCode = await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient,
      });

      expect(exitCode).toBe(0);
      expect(requests.length).toBe(1);

      // The body is multipart form data — it should contain the manifest JSON
      const bodyStr = requests[0].body.toString('utf-8');
      expect(bodyStr).toContain('my-publish-test');
      expect(bodyStr).toContain('My Publish Test');
      expect(bodyStr).toContain('nodejs');
      expect(bodyStr).toContain('index.ts');
      expect(bodyStr).toContain('2.0.0');
    });

    it('request includes tarball (multipart/form-data content-type)', async () => {
      suppressOutput();

      const moduleDir = createValidModuleDir();
      tempDirs.push(moduleDir);

      const registryClient = createHttpRegistryClient(baseUrl);

      const exitCode = await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient,
      });

      expect(exitCode).toBe(0);
      expect(requests.length).toBe(1);

      // The content-type header should indicate multipart with a boundary
      const contentType = requests[0].headers['content-type'] as string;
      expect(contentType).toContain('multipart/form-data');
      expect(contentType).toMatch(/boundary=/);

      // The multipart body should contain a tarball part (filename with .tar.gz)
      const bodyStr = requests[0].body.toString('utf-8');
      expect(bodyStr).toContain('.tar.gz');
    });
  });

  describe('Validation failure: invalid manifest → exitCode non-zero, NO request sent', () => {
    it('exits non-zero and does NOT contact server when manifest is missing required fields', async () => {
      suppressOutput();

      // Create a module directory with an invalid manifest (missing runtime and entry)
      const moduleDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-publish-invalid-')));
      tempDirs.push(moduleDir);
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({ id: 'test', name: 'Test' }, null, 2),
        'utf-8',
      );
      writeFileSync(join(moduleDir, 'index.ts'), 'export default {};', 'utf-8');

      const registryClient = createHttpRegistryClient(baseUrl);

      const exitCode = await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient,
      });

      // Should exit with non-zero (exit code 2 for manifest errors)
      expect(exitCode).toBe(2);

      // Server should NOT have received any requests (R12.10)
      expect(requests.length).toBe(0);
    });

    it('exits non-zero when module.json is missing entirely', async () => {
      suppressOutput();

      // Create a directory without module.json
      const moduleDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-publish-no-manifest-')));
      tempDirs.push(moduleDir);
      writeFileSync(join(moduleDir, 'index.ts'), 'export default {};', 'utf-8');

      const registryClient = createHttpRegistryClient(baseUrl);

      const exitCode = await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient,
      });

      // Should exit with non-zero
      expect(exitCode).not.toBe(0);

      // Server should NOT have received any requests
      expect(requests.length).toBe(0);
    });

    it('exits non-zero when module.json contains invalid JSON', async () => {
      suppressOutput();

      const moduleDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-publish-bad-json-')));
      tempDirs.push(moduleDir);
      writeFileSync(join(moduleDir, 'module.json'), '{ broken json }', 'utf-8');

      const registryClient = createHttpRegistryClient(baseUrl);

      const exitCode = await publishCommand({
        moduleDir,
        json: false,
        verbose: false,
        registryClient,
      });

      // Should exit with non-zero (exit code 2 for manifest/parse errors)
      expect(exitCode).toBe(2);

      // Server should NOT have received any requests
      expect(requests.length).toBe(0);
    });
  });
});
