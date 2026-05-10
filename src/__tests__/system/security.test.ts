/**
 * System-level tests for security behavior verification.
 *
 * Verifies security behaviors by spawning the REAL mcpx binary:
 * - Secret masking: values >4 chars show first 4 + "****", values ≤4 show "****" only
 * - File permissions: .env with insecure permissions triggers warning
 * - Env template security: $cmd: timeout, $file: nonexistent file error handling
 *
 * **Validates: Requirements 15.1, 15.2, 15.4, 15.5, 15.6, 15.7**
 *
 * @module __tests__/system/security
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --- Test Runner Helper ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the management-runner.mjs script that exercises real mcpx management commands.
 */
const MANAGEMENT_RUNNER = resolve(__dirname, '../helpers/management-runner.mjs');

/**
 * Spawns the management runner as a real subprocess and returns the result.
 * Uses spawnSync to always capture both stdout and stderr regardless of exit code.
 */
function spawnMcpx(
  args: string[],
  env: Record<string, string> = {},
  options: { timeout?: number } = {},
): { stdout: string; stderr: string; exitCode: number | null } {
  const { timeout = 30_000 } = options;
  const spawnEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...env,
  };

  // Remove undefined values
  for (const key of Object.keys(spawnEnv)) {
    if (spawnEnv[key] === undefined) {
      delete spawnEnv[key];
    }
  }

  const result = spawnSync('node', [MANAGEMENT_RUNNER, ...args], {
    env: spawnEnv,
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });

  return {
    stdout: result.stdout?.toString('utf-8') ?? '',
    stderr: result.stderr?.toString('utf-8') ?? '',
    exitCode: result.status,
  };
}

// --- Filesystem Helpers ---

interface TestModuleRoot {
  root: string;
  modulesDir: string;
}

/**
 * Creates a temporary module root with a modules/ directory.
 */
function createTempRoot(): TestModuleRoot {
  const root = mkdtempSync(join(tmpdir(), 'mcpx-sys-security-'));
  const modulesDir = join(root, 'modules');
  mkdirSync(modulesDir, { recursive: true });
  return { root, modulesDir };
}

// --- Tests ---

describe('System: Security Behavior', () => {
  let tempRoot: TestModuleRoot;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot.root, { recursive: true, force: true });
    }
  });

  describe('Secret masking', () => {
    it('masks values >4 chars by showing first 4 + "****"', () => {
      tempRoot = createTempRoot();

      // Create module with env vars of various lengths
      const moduleDir = join(tempRoot.modulesDir, 'secret-module');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({
          id: 'secret-module',
          name: 'Secret Module',
          runtime: 'shell',
          entry: 'run.sh',
          env: { PLACEHOLDER: '' },
        }),
        'utf-8',
      );
      writeFileSync(join(moduleDir, 'run.sh'), '#!/bin/sh\necho ok\n', 'utf-8');

      // Create .env with secrets of various lengths
      const envContent = [
        'LONG_SECRET=super-secret-api-key-12345',
        'MEDIUM_SECRET=abcde',
        'FIVE_CHARS=hello',
        'FOUR_CHARS=abcd',
        'THREE_CHARS=abc',
        'TWO_CHARS=ab',
        'ONE_CHAR=x',
      ].join('\n');
      const envPath = join(moduleDir, '.env');
      writeFileSync(envPath, envContent, 'utf-8');
      chmodSync(envPath, 0o600);

      const result = spawnMcpx(['env', 'secret-module', '--json'], {
        MCPX_ROOT: tempRoot.root,
      });

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout) as {
        moduleId: string;
        variables: Array<{ name: string; maskedValue: string }>;
        count: number;
      };

      // Values >4 chars: show first 4 + "****"
      const longSecret = output.variables.find((v) => v.name === 'LONG_SECRET');
      expect(longSecret).toBeDefined();
      expect(longSecret!.maskedValue).toBe('supe****');

      const mediumSecret = output.variables.find((v) => v.name === 'MEDIUM_SECRET');
      expect(mediumSecret).toBeDefined();
      expect(mediumSecret!.maskedValue).toBe('abcd****');

      const fiveChars = output.variables.find((v) => v.name === 'FIVE_CHARS');
      expect(fiveChars).toBeDefined();
      expect(fiveChars!.maskedValue).toBe('hell****');

      // Values ≤4 chars: show "****" only
      const fourChars = output.variables.find((v) => v.name === 'FOUR_CHARS');
      expect(fourChars).toBeDefined();
      expect(fourChars!.maskedValue).toBe('****');

      const threeChars = output.variables.find((v) => v.name === 'THREE_CHARS');
      expect(threeChars).toBeDefined();
      expect(threeChars!.maskedValue).toBe('****');

      const twoChars = output.variables.find((v) => v.name === 'TWO_CHARS');
      expect(twoChars).toBeDefined();
      expect(twoChars!.maskedValue).toBe('****');

      const oneChar = output.variables.find((v) => v.name === 'ONE_CHAR');
      expect(oneChar).toBeDefined();
      expect(oneChar!.maskedValue).toBe('****');
    });

    it('never exposes full secret values in stdout or stderr', () => {
      tempRoot = createTempRoot();

      const moduleDir = join(tempRoot.modulesDir, 'leak-check');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({
          id: 'leak-check',
          name: 'Leak Check Module',
          runtime: 'shell',
          entry: 'run.sh',
          env: { PLACEHOLDER: '' },
        }),
        'utf-8',
      );
      writeFileSync(join(moduleDir, 'run.sh'), '#!/bin/sh\necho ok\n', 'utf-8');

      // Secrets that should NEVER appear in output
      const secrets = [
        { key: 'API_KEY', value: 'sk-proj-abc123def456ghi789' },
        { key: 'DB_PASSWORD', value: 'P@ssw0rd!Complex#2024' },
        { key: 'TOKEN', value: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      ];

      const envContent = secrets.map((s) => `${s.key}=${s.value}`).join('\n');
      const envPath = join(moduleDir, '.env');
      writeFileSync(envPath, envContent, 'utf-8');
      chmodSync(envPath, 0o600);

      const result = spawnMcpx(['env', 'leak-check', '--json'], {
        MCPX_ROOT: tempRoot.root,
      });

      expect(result.exitCode).toBe(0);

      // Verify NO full secret values appear anywhere in stdout or stderr
      const combinedOutput = result.stdout + result.stderr;
      for (const secret of secrets) {
        expect(combinedOutput).not.toContain(secret.value);
      }

      // Verify the masked values are present instead
      const output = JSON.parse(result.stdout) as {
        variables: Array<{ name: string; maskedValue: string }>;
      };

      for (const secret of secrets) {
        const variable = output.variables.find((v) => v.name === secret.key);
        expect(variable).toBeDefined();
        // Should show first 4 chars + "****"
        expect(variable!.maskedValue).toBe(secret.value.slice(0, 4) + '****');
      }
    });
  });

  describe('File permissions', () => {
    it('warns when .env has insecure permissions (644)', () => {
      // Skip on Windows where Unix permissions don't apply
      if (process.platform === 'win32') return;

      tempRoot = createTempRoot();

      const moduleDir = join(tempRoot.modulesDir, 'perms-test');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({
          id: 'perms-test',
          name: 'Permissions Test',
          runtime: 'shell',
          entry: 'run.sh',
          env: { PLACEHOLDER: '' },
        }),
        'utf-8',
      );
      writeFileSync(join(moduleDir, 'run.sh'), '#!/bin/sh\necho ok\n', 'utf-8');

      // Create .env with insecure permissions (644 = owner rw, group r, other r)
      const envPath = join(moduleDir, '.env');
      writeFileSync(envPath, 'SOME_VAR=some-value\n', 'utf-8');
      chmodSync(envPath, 0o644);

      const result = spawnMcpx(['env', 'perms-test', '--json'], {
        MCPX_ROOT: tempRoot.root,
      });

      // Command should still succeed (warning, not error)
      expect(result.exitCode).toBe(0);

      // stderr should contain a permission warning
      expect(result.stderr).toMatch(/[Ii]nsecure permissions/);
      expect(result.stderr).toContain('644');
      expect(result.stderr).toMatch(/chmod 600/);
    });

    it('does not warn when .env has secure permissions (600)', () => {
      // Skip on Windows where Unix permissions don't apply
      if (process.platform === 'win32') return;

      tempRoot = createTempRoot();

      const moduleDir = join(tempRoot.modulesDir, 'secure-perms');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({
          id: 'secure-perms',
          name: 'Secure Permissions Test',
          runtime: 'shell',
          entry: 'run.sh',
          env: { PLACEHOLDER: '' },
        }),
        'utf-8',
      );
      writeFileSync(join(moduleDir, 'run.sh'), '#!/bin/sh\necho ok\n', 'utf-8');

      // Create .env with secure permissions (600 = owner rw only)
      const envPath = join(moduleDir, '.env');
      writeFileSync(envPath, 'SOME_VAR=some-value\n', 'utf-8');
      chmodSync(envPath, 0o600);

      const result = spawnMcpx(['env', 'secure-perms', '--json'], {
        MCPX_ROOT: tempRoot.root,
      });

      expect(result.exitCode).toBe(0);

      // stderr should NOT contain a permission warning
      expect(result.stderr).not.toMatch(/[Ii]nsecure permissions/);
      expect(result.stderr).not.toContain('644');
    });
  });

  describe('Env template security', () => {
    it('$cmd: with long-running command times out after 10 seconds', () => {
      tempRoot = createTempRoot();

      const moduleDir = join(tempRoot.modulesDir, 'timeout-test');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({
          id: 'timeout-test',
          name: 'Timeout Test',
          runtime: 'shell',
          entry: 'run.sh',
          env: {
            SLOW_CMD: '$cmd:sleep 30',
          },
        }),
        'utf-8',
      );
      writeFileSync(join(moduleDir, 'run.sh'), '#!/bin/sh\necho ok\n', 'utf-8');

      // Create .env with secure permissions so no permission warning
      const envPath = join(moduleDir, '.env');
      writeFileSync(envPath, '', 'utf-8');
      chmodSync(envPath, 0o600);

      const startTime = Date.now();
      const result = spawnMcpx(
        ['env', 'timeout-test', '--json'],
        { MCPX_ROOT: tempRoot.root },
        { timeout: 30_000 },
      );
      const elapsed = Date.now() - startTime;

      // Should fail (env resolution error)
      // The command should have timed out — not waited the full 30s
      expect(elapsed).toBeLessThan(20_000);
      expect(elapsed).toBeGreaterThanOrEqual(9_000);

      // stderr should mention timeout
      const combinedOutput = result.stdout + result.stderr;
      expect(combinedOutput).toMatch(/timed? ?out|timeout/i);
    }, 35_000);

    it('$file: with nonexistent file produces error, not crash', () => {
      tempRoot = createTempRoot();

      const moduleDir = join(tempRoot.modulesDir, 'file-missing');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({
          id: 'file-missing',
          name: 'File Missing Test',
          runtime: 'shell',
          entry: 'run.sh',
          env: {
            SECRET_FROM_FILE: '$file:/tmp/nonexistent-secret-file-xyz-12345.txt',
          },
        }),
        'utf-8',
      );
      writeFileSync(join(moduleDir, 'run.sh'), '#!/bin/sh\necho ok\n', 'utf-8');

      const result = spawnMcpx(['env', 'file-missing', '--json'], {
        MCPX_ROOT: tempRoot.root,
      });

      // Should not crash — should produce a structured error or warning
      // The exit code may be 0 (with error in stderr) or non-zero
      // Key: it should NOT be a crash (null exit code or signal)
      expect(result.exitCode).not.toBeNull();

      // stderr should mention the file not being found
      expect(result.stderr).toMatch(/not found|file.*not|cannot read/i);
      expect(result.stderr).toContain('nonexistent-secret-file-xyz-12345');
    });
  });
});
