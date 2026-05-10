/**
 * Tests for `mcpx list` command.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getModuleStatuses, formatHumanReadable, listCommand } from './list.js';
import { Logger } from '../../core/logger.js';
import { registerPlugin } from '../../runtimes/registry.js';
import type { RuntimePlugin, RuntimeCheck, ExecDescriptor } from '../../runtimes/plugin.js';
import type { ResolvedModule } from '../../core/manifest.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTempRoot(): string {
  const root = join(tmpdir(), `mcpx-list-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'modules'), { recursive: true });
  return root;
}

function createModule(root: string, dirName: string, manifest: Record<string, unknown>): void {
  const moduleDir = join(root, 'modules', dirName);
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, 'module.json'), JSON.stringify(manifest, null, 2));
}

function createMockPlugin(available: boolean, tool = 'node', version?: string): RuntimePlugin {
  return {
    name: 'mock',
    supportedExtensions: ['.ts', '.js'],
    async checkAvailability(): Promise<RuntimeCheck> {
      return {
        available,
        tool,
        version,
        suggestion: available ? undefined : `Install ${tool}`,
      };
    },
    buildCommand(module: ResolvedModule): ExecDescriptor {
      return { command: tool, args: [module.manifest.entry], cwd: module.dir, env: {} };
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('getModuleStatuses', () => {
  let root: string;
  const logger = new Logger(false);

  beforeEach(() => {
    root = createTempRoot();
    // Register a mock nodejs plugin that is available
    registerPlugin('nodejs', createMockPlugin(true, 'node', '20.0.0'));
    registerPlugin('python', createMockPlugin(true, 'python3', '3.12.0'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns empty array when no modules exist', async () => {
    const statuses = await getModuleStatuses(root, logger);
    expect(statuses).toEqual([]);
  });

  it('returns ready status for valid module with available runtime', async () => {
    createModule(root, 'my-module', {
      id: 'my-module',
      name: 'My Module',
      runtime: 'nodejs',
      entry: 'index.ts',
    });

    const statuses = await getModuleStatuses(root, logger);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toEqual({
      id: 'my-module',
      name: 'My Module',
      runtime: 'nodejs',
      status: 'ready',
    });
  });

  it('returns unavailable status when runtime is not available', async () => {
    // Register an unavailable runtime
    registerPlugin('python', createMockPlugin(false, 'python3'));

    createModule(root, 'py-module', {
      id: 'py-module',
      name: 'Python Module',
      runtime: 'python',
      entry: 'server.py',
    });

    const statuses = await getModuleStatuses(root, logger);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].id).toBe('py-module');
    expect(statuses[0].status).toBe('unavailable');
    expect(statuses[0].issues).toBeDefined();
    expect(statuses[0].issues!.length).toBeGreaterThan(0);
  });

  it('returns misconfigured status for invalid manifest', async () => {
    createModule(root, 'bad-module', {
      id: 'bad-module',
      name: 'Bad Module',
      // missing runtime and entry
    });

    const statuses = await getModuleStatuses(root, logger);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].id).toBe('bad-module');
    expect(statuses[0].status).toBe('misconfigured');
    expect(statuses[0].issues).toBeDefined();
  });

  it('discovers multiple modules', async () => {
    createModule(root, 'module-a', {
      id: 'module-a',
      name: 'Module A',
      runtime: 'nodejs',
      entry: 'index.ts',
    });
    createModule(root, 'module-b', {
      id: 'module-b',
      name: 'Module B',
      runtime: 'python',
      entry: 'server.py',
    });

    const statuses = await getModuleStatuses(root, logger);
    expect(statuses).toHaveLength(2);
    const ids = statuses.map(s => s.id).sort();
    expect(ids).toEqual(['module-a', 'module-b']);
  });

  it('handles malformed JSON in module.json', async () => {
    const moduleDir = join(root, 'modules', 'broken');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, 'module.json'), '{ invalid json }');

    const statuses = await getModuleStatuses(root, logger);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe('misconfigured');
    expect(statuses[0].issues).toBeDefined();
  });
});

describe('formatHumanReadable', () => {
  it('returns "No modules found." for empty array', () => {
    const output = formatHumanReadable([]);
    expect(output).toBe('No modules found.');
  });

  it('formats a single module as a table', () => {
    const output = formatHumanReadable([
      { id: 'my-module', name: 'My Module', runtime: 'nodejs', status: 'ready' },
    ]);

    expect(output).toContain('ID');
    expect(output).toContain('NAME');
    expect(output).toContain('RUNTIME');
    expect(output).toContain('STATUS');
    expect(output).toContain('my-module');
    expect(output).toContain('My Module');
    expect(output).toContain('nodejs');
    expect(output).toContain('ready');
  });

  it('formats multiple modules aligned in columns', () => {
    const output = formatHumanReadable([
      { id: 'short', name: 'Short', runtime: 'nodejs', status: 'ready' },
      { id: 'a-longer-module-id', name: 'A Longer Name', runtime: 'python', status: 'unavailable' },
    ]);

    const lines = output.split('\n');
    // Header + separator + 2 data rows
    expect(lines).toHaveLength(4);
  });
});

describe('listCommand', () => {
  let root: string;
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    root = createTempRoot();
    registerPlugin('nodejs', createMockPlugin(true, 'node', '20.0.0'));
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('outputs JSON to stdout when --json flag is set', async () => {
    createModule(root, 'test-mod', {
      id: 'test-mod',
      name: 'Test Module',
      runtime: 'nodejs',
      entry: 'index.ts',
    });

    const exitCode = await listCommand({ root, json: true, verbose: false });
    expect(exitCode).toBe(0);

    // JSON should go to stdout
    expect(stdoutSpy).toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed[0].id).toBe('test-mod');
    expect(parsed[0].status).toBe('ready');
  });

  it('outputs human-readable format to stderr when --json is not set', async () => {
    createModule(root, 'test-mod', {
      id: 'test-mod',
      name: 'Test Module',
      runtime: 'nodejs',
      entry: 'index.ts',
    });

    const exitCode = await listCommand({ root, json: false, verbose: false });
    expect(exitCode).toBe(0);

    // Human-readable should go to stderr
    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('test-mod');
    expect(output).toContain('Test Module');

    // stdout should NOT have the table output
    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).not.toContain('test-mod');
  });

  it('returns exit code 0', async () => {
    const exitCode = await listCommand({ root, json: false, verbose: false });
    expect(exitCode).toBe(0);
  });
});
