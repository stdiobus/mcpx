/**
 * System-level tests for real CLI output verification.
 *
 * Spawns the REAL compiled mcpx CLI runner for each command and verifies
 * actual output content, exit codes, and output stream routing (stdout vs stderr).
 *
 * Tests cover:
 * - Help output (--help and no args)
 * - Verbose mode (--verbose flag and MCPX_DEBUG=1 env var)
 * - JSON output mode (list --json, doctor --json)
 *
 * **Validates: Requirements 16.1, 16.2, 16.3, 16.5, 11.5**
 *
 * @module __tests__/system/cli-output
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tsxEsmNodeArgs } from '../helpers/tsx-node-args.js';

// --- Constants ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the CLI system runner that provides full CLI behavior. */
const CLI_RUNNER = resolve(__dirname, '../helpers/cli-system-runner.mjs');

/** Timeout for spawned processes. */
const SPAWN_TIMEOUT = 30_000;

/** All expected command names that should appear in help output. */
const EXPECTED_COMMANDS = ['run', 'list', 'doctor', 'env', 'install', 'publish', 'upgrade', 'search'];

// --- Helpers ---

/**
 * Spawns the CLI system runner as a real subprocess and returns the result.
 * Uses spawnSync to always capture both stdout and stderr regardless of exit code.
 */
function spawnCli(
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

  const result = spawnSync('node', [...tsxEsmNodeArgs(), CLI_RUNNER, ...args], {
    env: spawnEnv,
    timeout: SPAWN_TIMEOUT,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });

  return {
    stdout: result.stdout?.toString('utf-8') ?? '',
    stderr: result.stderr?.toString('utf-8') ?? '',
    exitCode: result.status,
  };
}

/**
 * Creates a temporary module root with a modules/ directory.
 * Uses realpathSync to resolve symlinks (e.g., /var → /private/var on macOS).
 */
function createTempRoot(): { root: string; modulesDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-sys-cli-')));
  const modulesDir = join(root, 'modules');
  mkdirSync(modulesDir, { recursive: true });
  return { root, modulesDir };
}

/**
 * Creates a simple valid Node.js module in the given modules directory.
 */
function createSimpleModule(
  modulesDir: string,
  id: string = 'test-module',
): string {
  const moduleDir = join(modulesDir, id);
  mkdirSync(moduleDir, { recursive: true });

  writeFileSync(
    join(moduleDir, 'module.json'),
    JSON.stringify(
      {
        id,
        name: `Test Module ${id}`,
        runtime: 'nodejs',
        entry: 'index.mjs',
        env: { APP_NAME: 'test-app' },
      },
      null,
      2,
    ),
    'utf-8',
  );

  writeFileSync(
    join(moduleDir, 'index.mjs'),
    'process.exit(0);\n',
    'utf-8',
  );

  const envPath = join(moduleDir, '.env');
  writeFileSync(envPath, 'MODULE_SECRET=secret-value-12345\n', 'utf-8');
  chmodSync(envPath, 0o600);

  return moduleDir;
}

// --- Tests ---

describe('System: CLI Output Verification', () => {
  let tempRoot: { root: string; modulesDir: string } | null = null;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot.root, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  describe('Help output', () => {
    it('`--help` flag produces exit code 0 with usage on stderr', () => {
      const result = spawnCli(['--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Usage');
    });

    it('no arguments produces same help output as --help', () => {
      const helpResult = spawnCli(['--help']);
      const noArgsResult = spawnCli([]);

      expect(noArgsResult.exitCode).toBe(0);
      expect(noArgsResult.stderr).toContain('Usage');
      // Both should produce the same help text
      expect(noArgsResult.stderr).toBe(helpResult.stderr);
    });

    it('help output lists all command names', () => {
      const result = spawnCli(['--help']);

      for (const cmd of EXPECTED_COMMANDS) {
        expect(result.stderr).toContain(cmd);
      }
    });

    it('stdout is EMPTY for help output (all output on stderr)', () => {
      const result = spawnCli(['--help']);

      expect(result.stdout).toBe('');
    });

    it('no args: stdout is EMPTY (all output on stderr)', () => {
      const result = spawnCli([]);

      expect(result.stdout).toBe('');
    });
  });

  describe('Verbose mode', () => {
    it('`--verbose run <module>` produces stderr with [mcpx] prefix debug lines', () => {
      tempRoot = createTempRoot();
      createSimpleModule(tempRoot.modulesDir);

      const result = spawnCli(['--verbose', 'run', 'test-module'], {
        MCPX_ROOT: tempRoot.root,
      });

      // The process may exit 0 or non-zero depending on module execution,
      // but stderr should contain verbose resolution steps
      expect(result.stderr).toContain('[mcpx]');
      // Verbose output should contain resolution step information
      expect(result.stderr).toMatch(/\[mcpx\].*\[.*\]/); // [mcpx] [step] message pattern
    });

    it('MCPX_DEBUG=1 produces same verbose output as --verbose', () => {
      tempRoot = createTempRoot();
      createSimpleModule(tempRoot.modulesDir);

      const verboseResult = spawnCli(['--verbose', 'run', 'test-module'], {
        MCPX_ROOT: tempRoot.root,
      });

      const debugEnvResult = spawnCli(['run', 'test-module'], {
        MCPX_ROOT: tempRoot.root,
        MCPX_DEBUG: '1',
      });

      // Both should contain [mcpx] debug lines
      expect(verboseResult.stderr).toContain('[mcpx]');
      expect(debugEnvResult.stderr).toContain('[mcpx]');

      // Both should contain resolution step markers
      expect(verboseResult.stderr).toMatch(/\[mcpx\].*\[.*\]/);
      expect(debugEnvResult.stderr).toMatch(/\[mcpx\].*\[.*\]/);
    });

    it('without verbose flag, debug lines are ABSENT from stderr', () => {
      tempRoot = createTempRoot();
      createSimpleModule(tempRoot.modulesDir);

      const result = spawnCli(['run', 'test-module'], {
        MCPX_ROOT: tempRoot.root,
        MCPX_DEBUG: '0', // Explicitly disable
      });

      // Should NOT contain debug-level resolution step lines
      // Debug lines have the pattern: [mcpx] [step] message
      const debugLinePattern = /\[mcpx\] \[(resolver|cli|manifest|env-loader|runtime)\]/;
      expect(result.stderr).not.toMatch(debugLinePattern);
    });
  });

  describe('JSON output mode', () => {
    it('`list --json` produces valid JSON on stdout', () => {
      tempRoot = createTempRoot();
      createSimpleModule(tempRoot.modulesDir, 'json-test-module');

      const result = spawnCli(['list', '--json'], {
        MCPX_ROOT: tempRoot.root,
      });

      expect(result.exitCode).toBe(0);

      // stdout should be valid JSON
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(result.stdout);
      }).not.toThrow();

      // Should be an array of modules
      expect(Array.isArray(parsed)).toBe(true);
      const modules = parsed as Array<{ id: string; name: string; runtime: string; status: string }>;
      expect(modules.length).toBeGreaterThan(0);

      // Should contain our test module
      const testModule = modules.find((m) => m.id === 'json-test-module');
      expect(testModule).toBeDefined();
      expect(testModule!.runtime).toBe('nodejs');
    });

    it('`doctor --json` produces valid JSON on stdout with expected schema', () => {
      tempRoot = createTempRoot();
      // Create a module with a missing entry file to trigger doctor issues
      const moduleDir = join(tempRoot.modulesDir, 'broken-module');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify(
          {
            id: 'broken-module',
            name: 'Broken Module',
            runtime: 'nodejs',
            entry: 'nonexistent.ts',
          },
          null,
          2,
        ),
        'utf-8',
      );

      const result = spawnCli(['doctor', '--json'], {
        MCPX_ROOT: tempRoot.root,
      });

      // doctor exits non-zero when issues are found
      expect(result.exitCode).not.toBe(0);

      // stdout should be valid JSON
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(result.stdout);
      }).not.toThrow();

      // Should be an array of health check results
      expect(Array.isArray(parsed)).toBe(true);
      const issues = parsed as Array<{
        module: string;
        check: string;
        severity: string;
        message: string;
        suggestion: string;
      }>;

      expect(issues.length).toBeGreaterThan(0);

      // Each issue should have the expected schema fields
      for (const issue of issues) {
        expect(issue).toHaveProperty('module');
        expect(issue).toHaveProperty('check');
        expect(issue).toHaveProperty('severity');
        expect(issue).toHaveProperty('message');
        expect(issue).toHaveProperty('suggestion');
        expect(['error', 'warning', 'info']).toContain(issue.severity);
      }
    });
  });
});
