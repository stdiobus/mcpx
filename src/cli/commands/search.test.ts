/**
 * Tests for `mcpx search` command.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { searchCommand, formatSearchResults } from './search.js';
import type { RegistryEntry } from '../../registry/client.js';

// Mock fetch globally
const mockFetch = jest.fn<typeof global.fetch>();

describe('formatSearchResults', () => {
  it('returns empty string for empty array', () => {
    const output = formatSearchResults([]);
    expect(output).toBe('');
  });

  it('formats a single result as a table with headers', () => {
    const results: RegistryEntry[] = [
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

    const output = formatSearchResults(results);

    expect(output).toContain('ID');
    expect(output).toContain('NAME');
    expect(output).toContain('DESCRIPTION');
    expect(output).toContain('mcp-agentic');
    expect(output).toContain('MCP Agentic Companion');
    expect(output).toContain('An AI companion server');
  });

  it('formats multiple results aligned in columns', () => {
    const results: RegistryEntry[] = [
      {
        id: 'short',
        name: 'Short',
        description: 'A short module',
        gitUrl: '',
        latestVersion: '1.0.0',
        runtimes: ['nodejs'],
        publishedAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'a-longer-module-id',
        name: 'A Longer Name',
        description: 'A module with a longer description',
        gitUrl: '',
        latestVersion: '2.0.0',
        runtimes: ['python'],
        publishedAt: '2024-02-01T00:00:00Z',
      },
    ];

    const output = formatSearchResults(results);
    const lines = output.split('\n');

    // Header + separator + 2 data rows
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('ID');
    expect(lines[2]).toContain('short');
    expect(lines[3]).toContain('a-longer-module-id');
  });

  it('handles empty description gracefully', () => {
    const results: RegistryEntry[] = [
      {
        id: 'no-desc',
        name: 'No Description',
        description: '',
        gitUrl: '',
        latestVersion: '1.0.0',
        runtimes: [],
        publishedAt: '2024-01-01T00:00:00Z',
      },
    ];

    const output = formatSearchResults(results);
    expect(output).toContain('no-desc');
    expect(output).toContain('No Description');
  });
});

describe('searchCommand', () => {
  let originalFetch: typeof global.fetch;
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = mockFetch;
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mockFetch.mockReset();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

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
    {
      id: 'mcp-weather',
      name: 'MCP Weather',
      description: 'Weather data provider',
      gitUrl: 'https://github.com/example/mcp-weather',
      latestVersion: '0.5.0',
      runtimes: ['python'],
      publishedAt: '2024-02-20T08:00:00Z',
    },
  ];

  it('returns exit code 1 when query is empty', async () => {
    const exitCode = await searchCommand({ query: '', json: false, verbose: false });
    expect(exitCode).toBe(1);

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('Search query is required');
  });

  it('returns exit code 1 when query is whitespace only', async () => {
    const exitCode = await searchCommand({ query: '   ', json: false, verbose: false });
    expect(exitCode).toBe(1);
  });

  it('displays results to stderr in human-readable format', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResults), { status: 200 }));

    const exitCode = await searchCommand({ query: 'mcp', json: false, verbose: false });
    expect(exitCode).toBe(0);

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('mcp-agentic');
    expect(output).toContain('MCP Agentic Companion');
    expect(output).toContain('An AI companion server');
    expect(output).toContain('mcp-weather');

    // stdout should not have the results
    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).not.toContain('mcp-agentic');
  });

  it('outputs JSON to stdout when --json flag is set', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResults), { status: 200 }));

    const exitCode = await searchCommand({ query: 'mcp', json: true, verbose: false });
    expect(exitCode).toBe(0);

    expect(stdoutSpy).toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('mcp-agentic');
    expect(parsed[0].name).toBe('MCP Agentic Companion');
    expect(parsed[0].description).toBe('An AI companion server');
    // JSON output should only include id, name, description
    expect(parsed[0]).not.toHaveProperty('gitUrl');
    expect(parsed[0]).not.toHaveProperty('latestVersion');
  });

  it('displays helpful message when no results found', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const exitCode = await searchCommand({ query: 'nonexistent', json: false, verbose: false });
    expect(exitCode).toBe(0);

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('No modules found matching "nonexistent"');
  });

  it('outputs empty JSON array when no results found with --json', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const exitCode = await searchCommand({ query: 'nonexistent', json: true, verbose: false });
    expect(exitCode).toBe(0);

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(parsed).toEqual([]);
  });

  it('returns exit code 1 on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

    const exitCode = await searchCommand({ query: 'test', json: false, verbose: false });
    expect(exitCode).toBe(1);

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('Registry search failed');
    expect(output).toContain('Network timeout');
  });

  it('returns exit code 1 on HTTP error response', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Server Error', { status: 500, statusText: 'Internal Server Error' })
    );

    const exitCode = await searchCommand({ query: 'test', json: false, verbose: false });
    expect(exitCode).toBe(1);

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('Registry search failed');
  });
});
