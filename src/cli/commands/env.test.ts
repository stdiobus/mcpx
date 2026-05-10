/**
 * Tests for the `mcpx env <module_id>` command.
 *
 * @see Requirement 10.4 — mcpx env <module_id> displays resolved env with masked values
 * @see Requirement 15.1 — Never log full unmasked values
 * @see Requirement 15.2 — Masking format
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { envCommand } from './env.js';
import type { ParsedArgs } from '../parser.js';
import { McpxError } from '../../core/errors.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTempDir(): string {
  const dir = join(tmpdir(), `mcpx-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createModuleStructure(rootDir: string, moduleId: string, manifest: object, envContent?: string): string {
  const modulesDir = join(rootDir, 'modules');
  mkdirSync(modulesDir, { recursive: true });
  const moduleDir = join(modulesDir, moduleId);
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, 'module.json'), JSON.stringify(manifest));
  if (envContent) {
    writeFileSync(join(moduleDir, '.env'), envContent);
  }
  return moduleDir;
}

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: 'env',
    moduleId: undefined,
    extraArgs: [],
    flags: { verbose: false, json: false },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('envCommand', () => {
  let rootDir: string;
  let originalMcpxRoot: string | undefined;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let stdoutSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    rootDir = createTempDir();
    originalMcpxRoot = process.env.MCPX_ROOT;
    process.env.MCPX_ROOT = rootDir;

    // Spy on stderr and stdout writes
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalMcpxRoot !== undefined) {
      process.env.MCPX_ROOT = originalMcpxRoot;
    } else {
      delete process.env.MCPX_ROOT;
    }
    jest.restoreAllMocks();
    rmSync(rootDir, { recursive: true });
  });

  it('throws McpxError when no module ID is provided', () => {
    expect(() => envCommand(makeArgs())).toThrow(McpxError);
    expect(() => envCommand(makeArgs())).toThrow('No module ID specified');
  });

  it('displays masked environment variables from manifest defaults', () => {
    createModuleStructure(rootDir, 'test-module', {
      id: 'test-module',
      name: 'Test Module',
      runtime: 'nodejs',
      entry: 'index.ts',
      env: { API_KEY: 'sk-proj-abc123def456' },
    });

    envCommand(makeArgs({ moduleId: 'test-module' }));

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('test-module');
    expect(output).toContain('API_KEY=sk-p****');
    // Must NOT contain the full value
    expect(output).not.toContain('sk-proj-abc123def456');
  });

  it('masks values of 4 chars or fewer as full mask ****', () => {
    createModuleStructure(rootDir, 'test-module', {
      id: 'test-module',
      name: 'Test Module',
      runtime: 'nodejs',
      entry: 'index.ts',
      env: { SHORT: 'abc' },
    });

    envCommand(makeArgs({ moduleId: 'test-module' }));

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('SHORT=****');
    expect(output).not.toContain('abc');
  });

  it('loads variables from module .env file', () => {
    createModuleStructure(
      rootDir,
      'test-module',
      {
        id: 'test-module',
        name: 'Test Module',
        runtime: 'nodejs',
        entry: 'index.ts',
      },
      'SECRET_TOKEN=super-secret-token-value\n'
    );

    envCommand(makeArgs({ moduleId: 'test-module' }));

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('SECRET_TOKEN=supe****');
    expect(output).not.toContain('super-secret-token-value');
  });

  it('loads variables from root .env file', () => {
    createModuleStructure(rootDir, 'test-module', {
      id: 'test-module',
      name: 'Test Module',
      runtime: 'nodejs',
      entry: 'index.ts',
      env: { ROOT_VAR: '' },
    });
    writeFileSync(join(rootDir, '.env'), 'ROOT_VAR=root-level-secret\n');

    envCommand(makeArgs({ moduleId: 'test-module' }));

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('ROOT_VAR=root****');
    expect(output).not.toContain('root-level-secret');
  });

  it('outputs valid JSON to stdout when --json flag is set', () => {
    createModuleStructure(rootDir, 'test-module', {
      id: 'test-module',
      name: 'Test Module',
      runtime: 'nodejs',
      entry: 'index.ts',
      env: { MY_KEY: 'hello-world-value' },
    });

    envCommand(makeArgs({ moduleId: 'test-module', flags: { verbose: false, json: true } }));

    // JSON goes to stdout
    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(stdoutOutput);

    expect(parsed.moduleId).toBe('test-module');
    expect(parsed.variables).toBeInstanceOf(Array);
    expect(parsed.variables).toHaveLength(1);
    expect(parsed.variables[0].name).toBe('MY_KEY');
    expect(parsed.variables[0].maskedValue).toBe('hell****');
    expect(parsed.count).toBe(1);

    // Full value must NOT appear in JSON output
    expect(stdoutOutput).not.toContain('hello-world-value');
  });

  it('displays message when no environment variables are configured', () => {
    createModuleStructure(rootDir, 'test-module', {
      id: 'test-module',
      name: 'Test Module',
      runtime: 'nodejs',
      entry: 'index.ts',
    });

    envCommand(makeArgs({ moduleId: 'test-module' }));

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('no environment variables configured');
  });

  it('sorts variables alphabetically', () => {
    createModuleStructure(
      rootDir,
      'test-module',
      {
        id: 'test-module',
        name: 'Test Module',
        runtime: 'nodejs',
        entry: 'index.ts',
      },
      'ZEBRA=value1\nALPHA=value2\nMIDDLE=value3\n'
    );

    envCommand(makeArgs({ moduleId: 'test-module' }));

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    // Find the variable lines (formatted as "  NAME=masked")
    const alphaIdx = output.indexOf('ALPHA=');
    const middleIdx = output.indexOf('MIDDLE=');
    const zebraIdx = output.indexOf('ZEBRA=');
    expect(alphaIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(zebraIdx);
  });

  it('shows variable count in human-readable output', () => {
    createModuleStructure(rootDir, 'test-module', {
      id: 'test-module',
      name: 'Test Module',
      runtime: 'nodejs',
      entry: 'index.ts',
      env: { A: 'value1', B: 'value2', C: 'value3' },
    });

    envCommand(makeArgs({ moduleId: 'test-module' }));

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('3 variable(s) resolved');
  });

  it('never outputs full unmasked values to any stream', () => {
    const secretValue = 'super-secret-api-key-12345';
    createModuleStructure(rootDir, 'test-module', {
      id: 'test-module',
      name: 'Test Module',
      runtime: 'nodejs',
      entry: 'index.ts',
      env: { SECRET: secretValue },
    });

    envCommand(makeArgs({ moduleId: 'test-module' }));

    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrOutput).not.toContain(secretValue);
    expect(stdoutOutput).not.toContain(secretValue);
  });

  it('JSON output never contains full unmasked values', () => {
    const secretValue = 'my-very-long-secret-key';
    createModuleStructure(rootDir, 'test-module', {
      id: 'test-module',
      name: 'Test Module',
      runtime: 'nodejs',
      entry: 'index.ts',
      env: { TOKEN: secretValue },
    });

    envCommand(makeArgs({ moduleId: 'test-module', flags: { verbose: false, json: true } }));

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).not.toContain(secretValue);
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.variables[0].maskedValue).toBe('my-v****');
  });
});
