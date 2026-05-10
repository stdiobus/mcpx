/**
 * Integration tests for real error handling scenarios.
 *
 * Each test spawns a REAL mcpx process (via the mcpx-runner.mjs script)
 * for specific error scenarios and verifies:
 * - Correct exit codes
 * - Meaningful stderr messages
 * - stdout is ALWAYS empty (stdio transparency)
 *
 * **Validates: Requirements 16.6, 16.7, 16.8, 16.9, 3.3, 3.4, 1.5, 4.2, 4.3**
 *
 * @module __tests__/integration/error-scenarios
 */

import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --- Test Runner Helper ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the mcpx-runner.mjs script that exercises real mcpx code paths.
 */
const MCPX_RUNNER = resolve(__dirname, '../helpers/mcpx-runner.mjs');

/**
 * Spawns the mcpx runner as a real subprocess and returns the result.
 */
function spawnMcpx(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number | null } {
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

  try {
    const result = execFileSync('node', [MCPX_RUNNER, ...args], {
      env: spawnEnv,
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });

    return {
      stdout: (result as unknown as Buffer).toString('utf-8'),
      stderr: '',
      exitCode: 0,
    };
  } catch (error: unknown) {
    const spawnError = error as {
      stdout?: Buffer;
      stderr?: Buffer;
      status?: number | null;
    };
    return {
      stdout: spawnError.stdout?.toString('utf-8') ?? '',
      stderr: spawnError.stderr?.toString('utf-8') ?? '',
      exitCode: spawnError.status ?? null,
    };
  }
}

// --- Filesystem Helpers ---

/**
 * Creates a temporary module root with a modules/ directory.
 */
function createTempRoot(): { root: string; modulesDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'mcpx-error-int-'));
  const modulesDir = join(root, 'modules');
  mkdirSync(modulesDir, { recursive: true });
  return { root, modulesDir };
}

describe('Integration: Error Scenarios', () => {
  describe('Module not found', () => {
    it('produces exit code 1 and stderr contains the module ID', () => {
      const { root } = createTempRoot();
      try {
        const result = spawnMcpx(['run', 'nonexistent-xyz'], { MCPX_ROOT: root });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('nonexistent-xyz');
        expect(Buffer.byteLength(result.stdout)).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('Invalid manifest (missing runtime)', () => {
    it('produces exit code 2 and stderr mentions "runtime"', () => {
      const { root, modulesDir } = createTempRoot();
      try {
        // Create module.json without the runtime field
        const moduleDir = join(modulesDir, 'bad-manifest');
        mkdirSync(moduleDir, { recursive: true });
        writeFileSync(
          join(moduleDir, 'module.json'),
          JSON.stringify({ id: 'bad-manifest', name: 'Bad Module', entry: 'index.ts' }, null, 2),
          'utf-8',
        );

        const result = spawnMcpx(['run', 'bad-manifest'], { MCPX_ROOT: root });

        expect(result.exitCode).toBe(2);
        expect(result.stderr.toLowerCase()).toContain('runtime');
        expect(Buffer.byteLength(result.stdout)).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('Invalid JSON', () => {
    it('produces exit code 2 and stderr mentions "JSON"', () => {
      const { root, modulesDir } = createTempRoot();
      try {
        const moduleDir = join(modulesDir, 'broken-json');
        mkdirSync(moduleDir, { recursive: true });
        writeFileSync(join(moduleDir, 'module.json'), '{broken', 'utf-8');

        const result = spawnMcpx(['run', 'broken-json'], { MCPX_ROOT: root });

        expect(result.exitCode).toBe(2);
        expect(result.stderr.toLowerCase()).toContain('json');
        expect(Buffer.byteLength(result.stdout)).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('Missing entry file', () => {
    it('produces exit code 3 and stderr mentions the file path', () => {
      const { root, modulesDir } = createTempRoot();
      try {
        // Valid manifest pointing to a nonexistent entry file
        const moduleDir = join(modulesDir, 'missing-entry');
        mkdirSync(moduleDir, { recursive: true });
        writeFileSync(
          join(moduleDir, 'module.json'),
          JSON.stringify(
            { id: 'missing-entry', name: 'Missing Entry', runtime: 'nodejs', entry: 'does-not-exist.ts' },
            null,
            2,
          ),
          'utf-8',
        );

        const result = spawnMcpx(['run', 'missing-entry'], { MCPX_ROOT: root });

        expect(result.exitCode).toBe(3);
        expect(result.stderr).toContain('does-not-exist.ts');
        expect(Buffer.byteLength(result.stdout)).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('Unsupported runtime', () => {
    it('produces exit code 2 and stderr lists valid runtimes', () => {
      const { root, modulesDir } = createTempRoot();
      try {
        const moduleDir = join(modulesDir, 'bad-runtime');
        mkdirSync(moduleDir, { recursive: true });
        writeFileSync(
          join(moduleDir, 'module.json'),
          JSON.stringify(
            { id: 'bad-runtime', name: 'Bad Runtime', runtime: 'java', entry: 'Main.java' },
            null,
            2,
          ),
          'utf-8',
        );

        const result = spawnMcpx(['run', 'bad-runtime'], { MCPX_ROOT: root });

        expect(result.exitCode).toBe(2);
        // stderr should mention the runtime field and list valid options
        expect(result.stderr).toContain('runtime');
        expect(result.stderr).toContain('nodejs');
        expect(result.stderr).toContain('python');
        expect(result.stderr).toContain('go');
        expect(result.stderr).toContain('rust');
        expect(result.stderr).toContain('shell');
        expect(result.stderr).toContain('docker');
        expect(Buffer.byteLength(result.stdout)).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('Duplicate module IDs', () => {
    it('produces non-zero exit code and stderr lists both paths', () => {
      const { root, modulesDir } = createTempRoot();
      try {
        // Create two directories with the same module ID in their manifests
        // Note: the duplicate-mod ID doesn't match either directory name,
        // so the resolver scans subdirectories and detects the conflict.
        const dir1 = join(modulesDir, 'mod-alpha');
        const dir2 = join(modulesDir, 'mod-beta');
        mkdirSync(dir1, { recursive: true });
        mkdirSync(dir2, { recursive: true });

        const sharedId = 'duplicate-mod';
        writeFileSync(
          join(dir1, 'module.json'),
          JSON.stringify({ id: sharedId, name: 'Module Alpha', runtime: 'nodejs', entry: 'index.ts' }, null, 2),
          'utf-8',
        );
        writeFileSync(
          join(dir2, 'module.json'),
          JSON.stringify({ id: sharedId, name: 'Module Beta', runtime: 'nodejs', entry: 'index.ts' }, null, 2),
          'utf-8',
        );

        const result = spawnMcpx(['run', sharedId], { MCPX_ROOT: root });

        // Duplicate IDs are classified as manifest errors (exit code 2)
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('mod-alpha');
        expect(result.stderr).toContain('mod-beta');
        expect(Buffer.byteLength(result.stdout)).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('Bad MCPX_ROOT', () => {
    it('produces exit code 1 and stderr mentions the path', () => {
      const badPath = join(tmpdir(), 'mcpx-nonexistent-root-xyz-12345');

      const result = spawnMcpx(['run', 'any-module'], { MCPX_ROOT: badPath });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(badPath);
      expect(Buffer.byteLength(result.stdout)).toBe(0);
    });
  });

  describe('stdout is always empty for all error scenarios', () => {
    it('verifies stdout is empty across all error types', () => {
      const { root, modulesDir } = createTempRoot();
      try {
        // Setup various error scenarios
        const brokenJsonDir = join(modulesDir, 'broken');
        mkdirSync(brokenJsonDir, { recursive: true });
        writeFileSync(join(brokenJsonDir, 'module.json'), '{invalid json content', 'utf-8');

        const missingRuntimeDir = join(modulesDir, 'no-runtime');
        mkdirSync(missingRuntimeDir, { recursive: true });
        writeFileSync(
          join(missingRuntimeDir, 'module.json'),
          JSON.stringify({ id: 'no-runtime', name: 'No Runtime', entry: 'index.ts' }, null, 2),
          'utf-8',
        );

        const missingEntryDir = join(modulesDir, 'no-entry');
        mkdirSync(missingEntryDir, { recursive: true });
        writeFileSync(
          join(missingEntryDir, 'module.json'),
          JSON.stringify({ id: 'no-entry', name: 'No Entry', runtime: 'shell', entry: 'missing.sh' }, null, 2),
          'utf-8',
        );

        const scenarios = [
          { args: ['run', 'nonexistent-module'], env: { MCPX_ROOT: root }, label: 'module not found' },
          { args: ['run', 'broken'], env: { MCPX_ROOT: root }, label: 'invalid JSON' },
          { args: ['run', 'no-runtime'], env: { MCPX_ROOT: root }, label: 'missing runtime' },
          { args: ['run', 'no-entry'], env: { MCPX_ROOT: root }, label: 'missing entry file' },
          { args: ['run', 'any-module'], env: { MCPX_ROOT: '/tmp/mcpx-does-not-exist-xyz' }, label: 'bad MCPX_ROOT' },
        ];

        for (const scenario of scenarios) {
          const result = spawnMcpx(scenario.args, scenario.env);
          expect(Buffer.byteLength(result.stdout)).toBe(0);
          // All errors should produce non-zero exit code
          expect(result.exitCode).not.toBe(0);
          // All errors should have diagnostic output on stderr
          expect(result.stderr.length).toBeGreaterThan(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
