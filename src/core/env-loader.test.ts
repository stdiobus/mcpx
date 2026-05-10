/**
 * Tests for the Environment Loader module.
 *
 * @see Requirement 5 — Environment Variable Management
 * @see Requirement 10.5 — Env template syntax
 * @see Requirement 15 — Security and Secrets Management
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseDotenv,
  checkFilePermissions,
  resolveTemplate,
  maskValue,
  isTemplate,
  warnLiteralEnvValues,
  loadEnvironment,
  loadEnvironmentOrThrow,
} from './env-loader.js';
import { Logger } from './logger.js';
import { EnvironmentError } from './errors.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createLogger(): Logger {
  return new Logger(false);
}

function createTempDir(): string {
  const dir = join(tmpdir(), `mcpx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── parseDotenv ─────────────────────────────────────────────────────────────

describe('parseDotenv', () => {
  const logger = createLogger();

  it('parses simple KEY=VALUE pairs', () => {
    const content = 'FOO=bar\nBAZ=qux';
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips blank lines', () => {
    const content = 'FOO=bar\n\n\nBAZ=qux\n';
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips comment lines', () => {
    const content = '# This is a comment\nFOO=bar\n  # Indented comment\nBAZ=qux';
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles double-quoted values', () => {
    const content = 'FOO="hello world"\nBAR="with \\"quotes\\""';
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ FOO: 'hello world', BAR: 'with "quotes"' });
  });

  it('handles single-quoted values (literal, no escapes)', () => {
    const content = "FOO='hello world'\nBAR='no \\n escape'";
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ FOO: 'hello world', BAR: 'no \\n escape' });
  });

  it('handles escape sequences in double-quoted values', () => {
    const content = 'FOO="line1\\nline2"\nBAR="tab\\there"';
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ FOO: 'line1\nline2', BAR: 'tab\there' });
  });

  it('trims trailing whitespace from unquoted values', () => {
    const content = 'FOO=bar   \nBAZ=qux\t';
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles empty values', () => {
    const content = 'FOO=\nBAR=""';
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ FOO: '', BAR: '' });
  });

  it('handles values with = sign', () => {
    const content = 'FOO=bar=baz\nURL=https://example.com?a=1&b=2';
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ FOO: 'bar=baz', URL: 'https://example.com?a=1&b=2' });
  });

  it('handles keys with underscores and numbers', () => {
    const content = 'MY_VAR_1=hello\n_PRIVATE=secret';
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ MY_VAR_1: 'hello', _PRIVATE: 'secret' });
  });

  it('warns on malformed lines', () => {
    const warnLogger = createLogger();
    const warnSpy = jest.spyOn(warnLogger, 'warn');
    const content = 'GOOD=value\n123BAD=value\nALSO GOOD=nope';
    parseDotenv(content, '/path/.env', warnLogger);
    expect(warnSpy).toHaveBeenCalledWith('Malformed line in /path/.env:2');
    expect(warnSpy).toHaveBeenCalledWith('Malformed line in /path/.env:3');
  });

  it('handles Windows line endings (CRLF)', () => {
    const content = 'FOO=bar\r\nBAZ=qux\r\n';
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('allows whitespace around = sign', () => {
    const content = 'FOO = bar\nBAZ =qux';
    const result = parseDotenv(content, '.env', logger);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });
});

// ─── checkFilePermissions ────────────────────────────────────────────────────

describe('checkFilePermissions', () => {
  // Skip on Windows
  const isUnix = process.platform !== 'win32';

  const skipIfNotUnix = isUnix ? it : it.skip;

  skipIfNotUnix('warns when group/other have access', () => {
    const dir = createTempDir();
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'SECRET=value');
    chmodSync(envFile, 0o644); // rw-r--r--

    const logger = createLogger();
    const warnSpy = jest.spyOn(logger, 'warn');

    checkFilePermissions(envFile, logger);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Insecure permissions')
    );

    rmSync(dir, { recursive: true });
  });

  skipIfNotUnix('does not warn when permissions are 600', () => {
    const dir = createTempDir();
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'SECRET=value');
    chmodSync(envFile, 0o600); // rw-------

    const logger = createLogger();
    const warnSpy = jest.spyOn(logger, 'warn');

    checkFilePermissions(envFile, logger);

    expect(warnSpy).not.toHaveBeenCalled();

    rmSync(dir, { recursive: true });
  });
});

// ─── isTemplate ──────────────────────────────────────────────────────────────

describe('isTemplate', () => {
  it('identifies $env: templates', () => {
    expect(isTemplate('$env:MY_VAR')).toBe(true);
  });

  it('identifies $file: templates', () => {
    expect(isTemplate('$file:/path/to/secret')).toBe(true);
  });

  it('identifies $cmd: templates', () => {
    expect(isTemplate('$cmd:echo hello')).toBe(true);
  });

  it('returns false for literal values', () => {
    expect(isTemplate('just a value')).toBe(false);
    expect(isTemplate('')).toBe(false);
    expect(isTemplate('$notatemplate')).toBe(false);
  });
});

// ─── resolveTemplate ─────────────────────────────────────────────────────────

describe('resolveTemplate', () => {
  describe('$env: resolution', () => {
    it('resolves from process.env', () => {
      process.env.TEST_RESOLVE_VAR = 'resolved_value';
      const result = resolveTemplate('$env:TEST_RESOLVE_VAR', 'MY_KEY');
      expect(result).toBe('resolved_value');
      delete process.env.TEST_RESOLVE_VAR;
    });

    it('throws EnvironmentError for undefined variable', () => {
      delete process.env.NONEXISTENT_VAR_XYZ;
      expect(() => resolveTemplate('$env:NONEXISTENT_VAR_XYZ', 'MY_KEY'))
        .toThrow(EnvironmentError);
    });
  });

  describe('$file: resolution', () => {
    it('reads file contents and trims', () => {
      const dir = createTempDir();
      const secretFile = join(dir, 'secret.txt');
      writeFileSync(secretFile, '  my-secret-value  \n');

      const result = resolveTemplate(`$file:${secretFile}`, 'MY_KEY');
      expect(result).toBe('my-secret-value');

      rmSync(dir, { recursive: true });
    });

    it('throws EnvironmentError for missing file', () => {
      expect(() => resolveTemplate('$file:/nonexistent/path/secret.txt', 'MY_KEY'))
        .toThrow(EnvironmentError);
    });
  });

  describe('$cmd: resolution', () => {
    it('executes command and returns trimmed output', () => {
      const result = resolveTemplate('$cmd:echo hello_world', 'MY_KEY');
      expect(result).toBe('hello_world');
    });

    it('throws EnvironmentError for failing command', () => {
      expect(() => resolveTemplate('$cmd:false', 'MY_KEY'))
        .toThrow(EnvironmentError);
    });

    it('throws EnvironmentError for non-existent command', () => {
      expect(() => resolveTemplate('$cmd:nonexistent_command_xyz_123', 'MY_KEY'))
        .toThrow(EnvironmentError);
    });
  });

  it('returns literal values unchanged', () => {
    expect(resolveTemplate('just a value', 'MY_KEY')).toBe('just a value');
  });
});

// ─── maskValue ───────────────────────────────────────────────────────────────

describe('maskValue', () => {
  it('masks values longer than 4 chars: first 4 + ****', () => {
    expect(maskValue('sk-proj-abc123')).toBe('sk-p****');
    expect(maskValue('12345')).toBe('1234****');
  });

  it('fully masks values of 4 chars or fewer', () => {
    expect(maskValue('abcd')).toBe('****');
    expect(maskValue('abc')).toBe('****');
    expect(maskValue('ab')).toBe('****');
    expect(maskValue('a')).toBe('****');
  });

  it('fully masks empty string', () => {
    expect(maskValue('')).toBe('****');
  });
});

// ─── warnLiteralEnvValues ────────────────────────────────────────────────────

describe('warnLiteralEnvValues', () => {
  it('warns on literal non-empty values', () => {
    const logger = createLogger();
    const warnSpy = jest.spyOn(logger, 'warn');

    warnLiteralEnvValues({ API_KEY: 'sk-secret-123' }, logger);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('module.json env "API_KEY" contains a literal value')
    );
  });

  it('does not warn on empty values', () => {
    const logger = createLogger();
    const warnSpy = jest.spyOn(logger, 'warn');

    warnLiteralEnvValues({ API_KEY: '' }, logger);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn on template expressions', () => {
    const logger = createLogger();
    const warnSpy = jest.spyOn(logger, 'warn');

    warnLiteralEnvValues({
      A: '$env:MY_VAR',
      B: '$file:/path/to/secret',
      C: '$cmd:echo hello',
    }, logger);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─── loadEnvironment ─────────────────────────────────────────────────────────

describe('loadEnvironment', () => {
  let rootDir: string;
  let moduleDir: string;

  beforeEach(() => {
    rootDir = createTempDir();
    moduleDir = join(rootDir, 'modules', 'test-module');
    mkdirSync(moduleDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true });
  });

  it('loads from manifest defaults', () => {
    const result = loadEnvironment({
      rootDir,
      moduleDir,
      manifestEnv: { FOO: 'default_value' },
      logger: createLogger(),
    });

    expect(result.env.FOO).toBe('default_value');
    expect(result.errors).toHaveLength(0);
  });

  it('root .env overrides manifest defaults', () => {
    writeFileSync(join(rootDir, '.env'), 'FOO=from_root');

    const result = loadEnvironment({
      rootDir,
      moduleDir,
      manifestEnv: { FOO: 'default_value' },
      logger: createLogger(),
    });

    expect(result.env.FOO).toBe('from_root');
  });

  it('module .env overrides root .env', () => {
    writeFileSync(join(rootDir, '.env'), 'FOO=from_root');
    writeFileSync(join(moduleDir, '.env'), 'FOO=from_module');

    const result = loadEnvironment({
      rootDir,
      moduleDir,
      manifestEnv: { FOO: 'default_value' },
      logger: createLogger(),
    });

    expect(result.env.FOO).toBe('from_module');
  });

  it('system env overrides all other sources', () => {
    process.env.TEST_SYS_VAR = 'from_system';
    writeFileSync(join(rootDir, '.env'), 'TEST_SYS_VAR=from_root');
    writeFileSync(join(moduleDir, '.env'), 'TEST_SYS_VAR=from_module');

    const result = loadEnvironment({
      rootDir,
      moduleDir,
      manifestEnv: { TEST_SYS_VAR: 'default_value' },
      logger: createLogger(),
    });

    expect(result.env.TEST_SYS_VAR).toBe('from_system');
    delete process.env.TEST_SYS_VAR;
  });

  it('resolves $env: templates from manifest', () => {
    process.env.TEMPLATE_SOURCE = 'resolved_from_env';

    const result = loadEnvironment({
      rootDir,
      moduleDir,
      manifestEnv: { MY_VAR: '$env:TEMPLATE_SOURCE' },
      logger: createLogger(),
    });

    expect(result.env.MY_VAR).toBe('resolved_from_env');
    delete process.env.TEMPLATE_SOURCE;
  });

  it('resolves $file: templates from manifest', () => {
    const secretFile = join(rootDir, 'secret.txt');
    writeFileSync(secretFile, 'file_secret_value\n');

    const result = loadEnvironment({
      rootDir,
      moduleDir,
      manifestEnv: { MY_VAR: `$file:${secretFile}` },
      logger: createLogger(),
    });

    expect(result.env.MY_VAR).toBe('file_secret_value');
  });

  it('resolves $cmd: templates from manifest', () => {
    const result = loadEnvironment({
      rootDir,
      moduleDir,
      manifestEnv: { MY_VAR: '$cmd:echo cmd_output' },
      logger: createLogger(),
    });

    expect(result.env.MY_VAR).toBe('cmd_output');
  });

  it('collects errors for failed template resolution', () => {
    delete process.env.NONEXISTENT_XYZ_123;

    const result = loadEnvironment({
      rootDir,
      moduleDir,
      manifestEnv: { MY_VAR: '$env:NONEXISTENT_XYZ_123' },
      logger: createLogger(),
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('NONEXISTENT_XYZ_123');
  });

  it('handles missing .env files gracefully', () => {
    const result = loadEnvironment({
      rootDir,
      moduleDir,
      manifestEnv: undefined,
      logger: createLogger(),
    });

    expect(result.env).toEqual({});
    expect(result.errors).toHaveLength(0);
  });

  it('merges variables from multiple sources', () => {
    writeFileSync(join(rootDir, '.env'), 'A=root_a\nB=root_b');
    writeFileSync(join(moduleDir, '.env'), 'B=module_b\nC=module_c');

    const result = loadEnvironment({
      rootDir,
      moduleDir,
      manifestEnv: { A: 'default_a', D: 'default_d' },
      logger: createLogger(),
    });

    expect(result.env.A).toBe('root_a');      // root overrides manifest
    expect(result.env.B).toBe('module_b');    // module overrides root
    expect(result.env.C).toBe('module_c');    // only in module
    expect(result.env.D).toBe('default_d');   // only in manifest
  });
});

// ─── loadEnvironmentOrThrow ──────────────────────────────────────────────────

describe('loadEnvironmentOrThrow', () => {
  it('throws EnvironmentError when there are resolution errors', () => {
    const rootDir = createTempDir();
    const moduleDir = join(rootDir, 'mod');
    mkdirSync(moduleDir, { recursive: true });

    delete process.env.NONEXISTENT_THROW_TEST;

    expect(() => loadEnvironmentOrThrow({
      rootDir,
      moduleDir,
      manifestEnv: { KEY: '$env:NONEXISTENT_THROW_TEST' },
      logger: createLogger(),
    })).toThrow(EnvironmentError);

    rmSync(rootDir, { recursive: true });
  });

  it('returns env map when no errors', () => {
    const rootDir = createTempDir();
    const moduleDir = join(rootDir, 'mod');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(rootDir, '.env'), 'KEY=value');

    const result = loadEnvironmentOrThrow({
      rootDir,
      moduleDir,
      manifestEnv: undefined,
      logger: createLogger(),
    });

    expect(result).toEqual({ KEY: 'value' });

    rmSync(rootDir, { recursive: true });
  });
});
