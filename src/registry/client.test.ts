import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { HttpRegistryClient } from './client.js';
import type { RegistryEntry } from './client.js';
import type { ModuleManifest } from '../core/manifest.js';

// Mock fetch globally
const mockFetch = jest.fn<typeof global.fetch>();

describe('HttpRegistryClient', () => {
  let client: HttpRegistryClient;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = mockFetch;
    client = new HttpRegistryClient('https://registry.example.com');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mockFetch.mockReset();
  });

  describe('constructor', () => {
    it('uses default base URL when none provided', () => {
      const defaultClient = new HttpRegistryClient();
      // We can verify by triggering a request and checking the URL
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
      defaultClient.search('test');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://registry.stdiobus.com/modules')
      );
    });

    it('uses custom base URL when provided', () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
      client.search('test');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://registry.example.com/modules')
      );
    });
  });

  describe('search', () => {
    const mockResults: RegistryEntry[] = [
      {
        id: 'mcp-agentic',
        name: 'MCP Agentic Companion',
        description: 'An AI companion server',
        gitUrl: 'https://github.com/example/mcp-agentic',
        latestVersion: '1.0.0',
        runtimes: ['nodejs'],
        publishedAt: '2024-01-15T10:00:00Z',
      },
    ];

    it('sends GET request with encoded query and limit=50', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResults), { status: 200 }));

      await client.search('agentic companion');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://registry.example.com/modules?q=agentic%20companion&limit=50'
      );
    });

    it('returns parsed registry entries on success', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResults), { status: 200 }));

      const results = await client.search('agentic');

      expect(results).toEqual(mockResults);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mcp-agentic');
    });

    it('returns empty array when no results match', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

      const results = await client.search('nonexistent');

      expect(results).toEqual([]);
    });

    it('encodes special characters in query', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

      await client.search('hello&world=test');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://registry.example.com/modules?q=hello%26world%3Dtest&limit=50'
      );
    });

    it('throws error on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }));

      await expect(client.search('test')).rejects.toThrow(
        'Registry search failed: 500 Internal Server Error'
      );
    });
  });

  describe('getModule', () => {
    const mockEntry: RegistryEntry = {
      id: 'mcp-agentic',
      name: 'MCP Agentic Companion',
      description: 'An AI companion server',
      gitUrl: 'https://github.com/example/mcp-agentic',
      latestVersion: '2.1.0',
      runtimes: ['nodejs', 'docker'],
      publishedAt: '2024-03-01T12:00:00Z',
    };

    it('sends GET request with module ID in path', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(mockEntry), { status: 200 }));

      await client.getModule('mcp-agentic');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://registry.example.com/modules/mcp-agentic'
      );
    });

    it('returns parsed registry entry on success', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(mockEntry), { status: 200 }));

      const result = await client.getModule('mcp-agentic');

      expect(result).toEqual(mockEntry);
      expect(result?.latestVersion).toBe('2.1.0');
    });

    it('returns null on 404 response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404, statusText: 'Not Found' }));

      const result = await client.getModule('nonexistent-module');

      expect(result).toBeNull();
    });

    it('throws error on non-OK, non-404 response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }));

      await expect(client.getModule('restricted')).rejects.toThrow(
        'Registry lookup failed: 403 Forbidden'
      );
    });

    it('encodes module ID with special characters', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      await client.getModule('module/with/slashes');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://registry.example.com/modules/module%2Fwith%2Fslashes'
      );
    });
  });

  describe('publish', () => {
    const mockManifest: ModuleManifest = {
      id: 'my-module',
      name: 'My Module',
      runtime: 'nodejs',
      entry: 'index.ts',
      version: '1.0.0',
      description: 'A test module',
    };

    const mockTarball = Buffer.from('fake-tarball-content');

    it('sends POST request to /modules', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 201 }));

      await client.publish(mockManifest, mockTarball);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://registry.example.com/modules',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(FormData),
        })
      );
    });

    it('includes manifest JSON and tarball in form data', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 201 }));

      await client.publish(mockManifest, mockTarball);

      const call = mockFetch.mock.calls[0];
      const options = call[1] as RequestInit;
      const formData = options.body as FormData;

      expect(formData.get('manifest')).toBe(JSON.stringify(mockManifest));
      expect(formData.get('tarball')).toBeInstanceOf(Blob);
    });

    it('resolves without error on successful publish', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

      await expect(client.publish(mockManifest, mockTarball)).resolves.toBeUndefined();
    });

    it('throws error on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Validation failed: missing description', { status: 422, statusText: 'Unprocessable Entity' })
      );

      await expect(client.publish(mockManifest, mockTarball)).rejects.toThrow(
        'Registry publish failed: 422 Unprocessable Entity — Validation failed: missing description'
      );
    });

    it('throws error on server error without body', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 500, statusText: 'Internal Server Error' }));

      await expect(client.publish(mockManifest, mockTarball)).rejects.toThrow(
        'Registry publish failed: 500 Internal Server Error'
      );
    });
  });
});
