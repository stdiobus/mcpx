/**
 * Integration tests for `mcpx search` — Real search flow.
 *
 * Starts a real HTTP server returning search results (5 modules with
 * varying names/descriptions), calls the REAL searchCommand function,
 * and verifies:
 * - stdout (with --json) contains valid JSON array with id, name, description
 * - Results match what the mock server returned
 * - Without --json: stderr contains formatted module list
 * - Empty results: query with no matches → appropriate message
 *
 * **Validates: Requirements 12.8**
 *
 * @module __tests__/integration/registry-search
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { searchCommand } from '../../cli/commands/search.js';
import type { RegistryEntry } from '../../registry/client.js';

// --- Mock Registry Data (5 modules with varying names/descriptions) ---

const MOCK_MODULES: RegistryEntry[] = [
  {
    id: 'mcp-weather',
    name: 'MCP Weather Service',
    description: 'Real-time weather data provider for MCP clients',
    gitUrl: 'https://github.com/example/mcp-weather',
    latestVersion: '1.2.0',
    runtimes: ['nodejs'],
    publishedAt: '2024-03-01T10:00:00Z',
  },
  {
    id: 'mcp-database',
    name: 'MCP Database Connector',
    description: 'Connect to SQL and NoSQL databases via MCP',
    gitUrl: 'https://github.com/example/mcp-database',
    latestVersion: '2.0.1',
    runtimes: ['nodejs', 'python'],
    publishedAt: '2024-02-15T08:30:00Z',
  },
  {
    id: 'mcp-search-engine',
    name: 'MCP Search Engine',
    description: 'Full-text search capabilities for MCP servers',
    gitUrl: 'https://github.com/example/mcp-search-engine',
    latestVersion: '0.9.0',
    runtimes: ['go'],
    publishedAt: '2024-01-20T14:00:00Z',
  },
  {
    id: 'mcp-file-manager',
    name: 'MCP File Manager',
    description: 'File system operations through MCP protocol',
    gitUrl: 'https://github.com/example/mcp-file-manager',
    latestVersion: '1.0.0',
    runtimes: ['nodejs'],
    publishedAt: '2024-03-10T09:00:00Z',
  },
  {
    id: 'mcp-code-analyzer',
    name: 'MCP Code Analyzer',
    description: 'Static analysis and code quality tools for MCP',
    gitUrl: 'https://github.com/example/mcp-code-analyzer',
    latestVersion: '3.1.0',
    runtimes: ['python'],
    publishedAt: '2024-03-05T16:00:00Z',
  },
];

// --- Test Suite ---

describe('Integration: Registry Search', () => {
  let server: Server;
  let baseUrl: string;
  let tempDir: string;
  let originalFetch: typeof global.fetch;

  // Suppress stderr/stdout during tests
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let stdoutSpy: ReturnType<typeof jest.spyOn>;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcpx-search-int-'));

    // Start real HTTP server as mock registry
    const result = await createMockRegistryServer();
    server = result.server;
    baseUrl = result.baseUrl;

    // Override global.fetch to redirect registry requests to our local server.
    // This allows searchCommand to make REAL HTTP calls to our mock server.
    originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

      // Redirect default registry URL to our local mock server
      if (url.startsWith('https://registry.stdiobus.com')) {
        url = url.replace('https://registry.stdiobus.com', baseUrl);
      }

      return originalFetch(url, init);
    }) as typeof global.fetch;
  });

  afterAll(async () => {
    // Restore original fetch
    global.fetch = originalFetch;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(() => {
    stderrSpy?.mockRestore();
    stdoutSpy?.mockRestore();
  });

  function suppressOutput() {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  }

  function getStdoutOutput(): string {
    return stdoutSpy.mock.calls.map((c) => c[0]).join('');
  }

  function getStderrOutput(): string {
    return stderrSpy.mock.calls.map((c) => c[0]).join('');
  }

  /**
   * Creates a real HTTP server that acts as a module registry with search support.
   */
  function createMockRegistryServer(): Promise<{ server: Server; baseUrl: string }> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', 'http://localhost');

        // GET /modules?q=...&limit=...
        if (url.pathname === '/modules' && req.method === 'GET') {
          const query = url.searchParams.get('q') || '';
          const limit = parseInt(url.searchParams.get('limit') || '50', 10);

          // Substring matching against name and description
          const results = MOCK_MODULES.filter(
            (m) =>
              m.name.toLowerCase().includes(query.toLowerCase()) ||
              m.description.toLowerCase().includes(query.toLowerCase()),
          ).slice(0, limit);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(results));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          resolve({ server: srv, baseUrl: `http://127.0.0.1:${addr.port}` });
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      srv.on('error', reject);
    });
  }

  describe('JSON output (--json flag)', () => {
    it('returns valid JSON array with id, name, description fields', async () => {
      suppressOutput();

      const exitCode = await searchCommand({ query: 'MCP', json: true, verbose: false });
      expect(exitCode).toBe(0);

      const output = getStdoutOutput();
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(5); // All 5 modules match "MCP"

      // Verify each result has the required fields
      for (const entry of parsed) {
        expect(entry).toHaveProperty('id');
        expect(entry).toHaveProperty('name');
        expect(entry).toHaveProperty('description');
        expect(typeof entry.id).toBe('string');
        expect(typeof entry.name).toBe('string');
        expect(typeof entry.description).toBe('string');
      }
    });

    it('results match what the mock server returned', async () => {
      suppressOutput();

      const exitCode = await searchCommand({ query: 'weather', json: true, verbose: false });
      expect(exitCode).toBe(0);

      const output = getStdoutOutput();
      const parsed = JSON.parse(output);
      expect(parsed.length).toBe(1);
      expect(parsed[0].id).toBe('mcp-weather');
      expect(parsed[0].name).toBe('MCP Weather Service');
      expect(parsed[0].description).toBe('Real-time weather data provider for MCP clients');
    });

    it('JSON output does not include extra fields like gitUrl or latestVersion', async () => {
      suppressOutput();

      const exitCode = await searchCommand({ query: 'MCP', json: true, verbose: false });
      expect(exitCode).toBe(0);

      const output = getStdoutOutput();
      const parsed = JSON.parse(output);
      for (const entry of parsed) {
        expect(entry).not.toHaveProperty('gitUrl');
        expect(entry).not.toHaveProperty('latestVersion');
        expect(entry).not.toHaveProperty('runtimes');
        expect(entry).not.toHaveProperty('publishedAt');
      }
    });

    it('returns multiple matching results with correct data', async () => {
      suppressOutput();

      // "database" matches mcp-database name and description
      const exitCode = await searchCommand({ query: 'database', json: true, verbose: false });
      expect(exitCode).toBe(0);

      const output = getStdoutOutput();
      const parsed = JSON.parse(output);
      expect(parsed.length).toBeGreaterThanOrEqual(1);

      const ids = parsed.map((r: { id: string }) => r.id);
      expect(ids).toContain('mcp-database');
    });
  });

  describe('Human-readable output (no --json)', () => {
    it('stderr contains formatted module list with module details', async () => {
      suppressOutput();

      const exitCode = await searchCommand({ query: 'database', json: false, verbose: false });
      expect(exitCode).toBe(0);

      // Without --json, results go to stderr
      const output = getStderrOutput();
      expect(output).toContain('mcp-database');
      expect(output).toContain('MCP Database Connector');
      expect(output).toContain('Connect to SQL and NoSQL databases via MCP');
    });

    it('displays all matching results in stderr', async () => {
      suppressOutput();

      const exitCode = await searchCommand({ query: 'MCP', json: false, verbose: false });
      expect(exitCode).toBe(0);

      // All 5 modules should appear in stderr
      const output = getStderrOutput();
      expect(output).toContain('mcp-weather');
      expect(output).toContain('mcp-database');
      expect(output).toContain('mcp-search-engine');
      expect(output).toContain('mcp-file-manager');
      expect(output).toContain('mcp-code-analyzer');
    });

    it('stdout remains empty when not using --json', async () => {
      suppressOutput();

      const exitCode = await searchCommand({ query: 'MCP', json: false, verbose: false });
      expect(exitCode).toBe(0);

      const stdoutOutput = getStdoutOutput();
      expect(stdoutOutput).toBe('');
    });
  });

  describe('Empty results', () => {
    it('returns appropriate message when no modules match the query', async () => {
      suppressOutput();

      const exitCode = await searchCommand({
        query: 'zzz-nonexistent-xyz-999',
        json: false,
        verbose: false,
      });
      expect(exitCode).toBe(0);

      const output = getStderrOutput();
      expect(output).toContain('No modules found');
      expect(output).toContain('zzz-nonexistent-xyz-999');
    });

    it('returns empty JSON array when no results with --json', async () => {
      suppressOutput();

      const exitCode = await searchCommand({
        query: 'zzz-nonexistent-xyz-999',
        json: true,
        verbose: false,
      });
      expect(exitCode).toBe(0);

      const output = getStdoutOutput();
      const parsed = JSON.parse(output);
      expect(parsed).toEqual([]);
    });
  });
});
