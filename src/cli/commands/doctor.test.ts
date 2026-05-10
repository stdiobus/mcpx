/**
 * Tests for `mcpx doctor` command.
 *
 * @see Requirement 10.3 — Validate manifests, check runtimes, verify env
 * @see Requirement 11.1–11.8 — Health checks and validation
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger } from '../../core/logger.js';
import { doctorCommand, type HealthCheckResult } from './doctor.js';
import { registerPlugin } from '../../runtimes/registry.js';
import type { RuntimePlugin, RuntimeCheck, ExecDescriptor } from '../../runtimes/plugin.js';
import type { ResolvedModule } from '../../core/manifest.js';
import type { ParsedArgs } from '../parser.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTempRoot(): string {
  const root = join(tmpdir(), `mcpx-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'modules'), { recursive: true });
  return root;
}

function createModule(root: string, dirName: string, manifest: Record<string, unknown>, createEntry = true): void {
  const moduleDir = join(root, 'modules', dirName);
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, 'module.json'), JSON.stringify(manifest, null, 2));
  if (createEntry && manifest.entry) {
    writeFileSync(join(moduleDir, manifest.entry as string), '// entry file');
  }
}

function makeArgs(flags: { json?: boolean; verbose?: boolean } = {}): ParsedArgs {
  return {
    command: 'doctor',
    extraArgs: [],
    flags: {
      verbose: flags.verbose ?? false,
      json: flags.json ?? false,
    },
  };
}

// ─── Mock Runtime Plugin ─────────────────────────────────────────────────────

function createMockPlugin(available: boolean, tool = 'node', version = '20.0.0'): RuntimePlugin {
  return {
    name: 'nodejs',
    supportedExtensions: ['.ts', '.js', '.mjs'],
    async checkAvailability(): Promise<RuntimeCheck> {
      if (available) {
        return { available: true, tool, version };
      }
      return { available: false, tool, suggestion: `Install ${tool}` };
    },
    buildCommand(module: ResolvedModule): ExecDescriptor {
      return { command: tool, args: [module.manifest.entry], cwd: module.dir, env: {} };
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('mcpx doctor command', () => {
  let root: string;
  let logger: Logger;
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    root = createTempRoot();
    logger = new Logger(false);

    // Capture stdout/stderr
    stdoutOutput = '';
    stderrOutput = '';
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutOutput += chunk.toString();
      return true;
    });
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput += chunk.toString();
      return true;
    });

    // Register mock plugins for all runtimes
    const availablePlugin = createMockPlugin(true);
    registerPlugin('nodejs', availablePlugin);
    registerPlugin('python', createMockPlugin(true, 'python3', '3.11.0'));
    registerPlugin('go', createMockPlugin(true, 'go', '1.21.0'));
    registerPlugin('rust', createMockPlugin(true, 'cargo', '1.72.0'));
    registerPlugin('shell', createMockPlugin(true, '/bin/sh', ''));
    registerPlugin('docker', createMockPlugin(true, 'docker', '24.0.5'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  describe('no modules found', () => {
    it('should report warning when no modules exist', async () => {
      const exitCode = await doctorCommand(makeArgs(), root, logger);
      expect(exitCode).toBe(0);
    });

    it('should output JSON when --json flag is set and no modules found', async () => {
      const exitCode = await doctorCommand(makeArgs({ json: true }), root, logger);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutOutput) as HealthCheckResult[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].severity).toBe('warning');
      expect(parsed[0].check).toBe('discovery');
    });
  });

  describe('manifest validation (R11.2)', () => {
    it('should report error for invalid JSON in module.json', async () => {
      const moduleDir = join(root, 'modules', 'bad-json');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(join(moduleDir, 'module.json'), '{ invalid json }');

      const exitCode = await doctorCommand(makeArgs({ json: true }), root, logger);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdoutOutput) as HealthCheckResult[];
      expect(parsed.some(r => r.check === 'manifest-parse' && r.severity === 'error')).toBe(true);
    });

    it('should report error for missing required fields', async () => {
      createModule(root, 'missing-fields', { id: 'missing-fields' }, false);

      const exitCode = await doctorCommand(makeArgs({ json: true }), root, logger);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdoutOutput) as HealthCheckResult[];
      expect(parsed.some(r => r.check === 'manifest-schema' && r.severity === 'error')).toBe(true);
    });

    it('should pass for valid manifest', async () => {
      createModule(root, 'valid-module', {
        id: 'valid-module',
        name: 'Valid Module',
        runtime: 'nodejs',
        entry: 'index.ts',
      });

      const exitCode = await doctorCommand(makeArgs({ json: true }), root, logger);
      expect(exitCode).toBe(0);
    });
  });

  describe('runtime availability (R11.1)', () => {
    it('should report error when runtime tool is unavailable', async () => {
      registerPlugin('nodejs', createMockPlugin(false, 'node'));

      createModule(root, 'no-runtime', {
        id: 'no-runtime',
        name: 'No Runtime',
        runtime: 'nodejs',
        entry: 'index.ts',
      });

      const exitCode = await doctorCommand(makeArgs({ json: true }), root, logger);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdoutOutput) as HealthCheckResult[];
      expect(parsed.some(r => r.check === 'runtime-available' && r.severity === 'error')).toBe(true);
    });

    it('should report info when runtime is available with version', async () => {
      createModule(root, 'has-runtime', {
        id: 'has-runtime',
        name: 'Has Runtime',
        runtime: 'nodejs',
        entry: 'index.ts',
      });

      const exitCode = await doctorCommand(makeArgs({ json: true }), root, logger);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutOutput) as HealthCheckResult[];
      expect(parsed.some(r => r.check === 'runtime-available' && r.severity === 'info')).toBe(true);
    });
  });

  describe('entry file check (R11.4)', () => {
    it('should report error when entry file does not exist', async () => {
      createModule(root, 'no-entry', {
        id: 'no-entry',
        name: 'No Entry',
        runtime: 'nodejs',
        entry: 'missing.ts',
      }, false);

      const exitCode = await doctorCommand(makeArgs({ json: true }), root, logger);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdoutOutput) as HealthCheckResult[];
      expect(parsed.some(r => r.check === 'entry-file' && r.severity === 'error')).toBe(true);
    });

    it('should pass when entry file exists and is readable', async () => {
      createModule(root, 'has-entry', {
        id: 'has-entry',
        name: 'Has Entry',
        runtime: 'nodejs',
        entry: 'index.ts',
      });

      const exitCode = await doctorCommand(makeArgs({ json: true }), root, logger);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutOutput) as HealthCheckResult[];
      expect(parsed.every(r => r.check !== 'entry-file')).toBe(true);
    });
  });

  describe('environment variable resolution (R11.3)', () => {
    it('should report warning for unresolvable env vars with empty defaults', async () => {
      createModule(root, 'needs-env', {
        id: 'needs-env',
        name: 'Needs Env',
        runtime: 'nodejs',
        entry: 'index.ts',
        env: { SOME_MISSING_VAR: '' },
      });

      const exitCode = await doctorCommand(makeArgs({ json: true }), root, logger);
      const parsed = JSON.parse(stdoutOutput) as HealthCheckResult[];
      expect(parsed.some(r => r.check === 'env-resolution' && r.severity === 'warning')).toBe(true);
    });

    it('should not report issues for env vars with literal defaults', async () => {
      createModule(root, 'has-defaults', {
        id: 'has-defaults',
        name: 'Has Defaults',
        runtime: 'nodejs',
        entry: 'index.ts',
        env: { MY_VAR: 'default-value' },
      });

      const exitCode = await doctorCommand(makeArgs({ json: true }), root, logger);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutOutput) as HealthCheckResult[];
      expect(parsed.every(r => r.check !== 'env-resolution' || r.severity !== 'error')).toBe(true);
    });
  });

  describe('exit codes (R11.7, R11.8)', () => {
    it('should exit 0 when all checks pass', async () => {
      createModule(root, 'healthy', {
        id: 'healthy',
        name: 'Healthy Module',
        runtime: 'nodejs',
        entry: 'index.ts',
      });

      const exitCode = await doctorCommand(makeArgs(), root, logger);
      expect(exitCode).toBe(0);
    });

    it('should exit 1 when error-severity issues exist', async () => {
      createModule(root, 'broken', {
        id: 'broken',
        name: 'Broken Module',
        runtime: 'nodejs',
        entry: 'nonexistent.ts',
      }, false);

      const exitCode = await doctorCommand(makeArgs(), root, logger);
      expect(exitCode).toBe(1);
    });

    it('should exit 0 when only warnings exist', async () => {
      createModule(root, 'warn-only', {
        id: 'warn-only',
        name: 'Warn Only',
        runtime: 'nodejs',
        entry: 'index.ts',
        env: { UNSET_VAR: '' },
      });

      const exitCode = await doctorCommand(makeArgs(), root, logger);
      expect(exitCode).toBe(0);
    });
  });

  describe('--json output (R11.5)', () => {
    it('should output valid JSON to stdout when --json is set', async () => {
      createModule(root, 'json-test', {
        id: 'json-test',
        name: 'JSON Test',
        runtime: 'nodejs',
        entry: 'index.ts',
      });

      await doctorCommand(makeArgs({ json: true }), root, logger);
      expect(() => JSON.parse(stdoutOutput)).not.toThrow();
      const parsed = JSON.parse(stdoutOutput) as HealthCheckResult[];
      expect(Array.isArray(parsed)).toBe(true);
      for (const result of parsed) {
        expect(result).toHaveProperty('module');
        expect(result).toHaveProperty('check');
        expect(result).toHaveProperty('severity');
        expect(result).toHaveProperty('message');
        expect(result).toHaveProperty('suggestion');
      }
    });

    it('should output human-readable format to stderr when --json is not set', async () => {
      createModule(root, 'human-test', {
        id: 'human-test',
        name: 'Human Test',
        runtime: 'nodejs',
        entry: 'index.ts',
      });

      await doctorCommand(makeArgs({ json: false }), root, logger);
      expect(stderrOutput).toContain('[mcpx]');
      expect(stdoutOutput).toBe('');
    });
  });

  describe('multiple modules', () => {
    it('should check all discovered modules', async () => {
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

      const exitCode = await doctorCommand(makeArgs({ json: true }), root, logger);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutOutput) as HealthCheckResult[];
      const modules = new Set(parsed.map(r => r.module));
      expect(modules.has('module-a')).toBe(true);
      expect(modules.has('module-b')).toBe(true);
    });
  });
});
