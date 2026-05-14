/**
 * End-to-end tests for graceful degradation UX.
 *
 * Each test creates a REAL module root, spawns the REAL compiled mcpx
 * management or run helpers, and verifies that error messages provide
 * helpful guidance for common misconfiguration scenarios.
 *
 * **Validates: Requirements 18.1, 18.2, 18.3, 18.5**
 *
 * @module __tests__/e2e/graceful-degradation
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --- Test Runner Helpers ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the management-runner.mjs for list/doctor commands. */
const MANAGEMENT_RUNNER = resolve(__dirname, '../helpers/management-runner.mjs');

/** Path to the mcpx-run-module.mjs for run commands. */
const MCPX_RUN_MODULE = resolve(__dirname, '../helpers/mcpx-run-module.mjs');

/** Timeout for spawned processes. */
const SPAWN_TIMEOUT = 30_000;

/**
 * Spawns the management runner as a real subprocess and returns the result.
 * Uses spawnSync to always capture both stdout and stderr regardless of exit code.
 */
function spawnManagement(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number | null } {
  const spawnEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...env,
  };

  for (const key of Object.keys(spawnEnv)) {
    if (spawnEnv[key] === undefined) {
      delete spawnEnv[key];
    }
  }

  const result = spawnSync('node', ['--import', 'tsx/esm', MANAGEMENT_RUNNER, ...args], {
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
 * Spawns the mcpx-run-module runner as a real subprocess and returns the result.
 * Uses spawnSync to always capture both stdout and stderr regardless of exit code.
 */
function spawnRun(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number | null } {
  const spawnEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...env,
  };

  for (const key of Object.keys(spawnEnv)) {
    if (spawnEnv[key] === undefined) {
      delete spawnEnv[key];
    }
  }

  const result = spawnSync('node', ['--import', 'tsx/esm', MCPX_RUN_MODULE, ...args], {
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

// --- Filesystem Helpers ---

/**
 * Creates a temporary module root with a modules/ directory.
 */
function createTempRoot(): { root: string; modulesDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'mcpx-e2e-degrade-'));
  const modulesDir = join(root, 'modules');
  mkdirSync(modulesDir, { recursive: true });
  return { root, modulesDir };
}

// --- Cleanup ---

const dirsToCleanup: string[] = [];

afterEach(() => {
  for (const dir of dirsToCleanup) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  dirsToCleanup.length = 0;
});

// --- Tests ---

describe('E2E: Graceful Degradation', () => {
  describe('No modules found', () => {
    it('displays getting-started guidance with Module_Root path', () => {
      const { root, modulesDir } = createTempRoot();
      dirsToCleanup.push(root);

      // modules/ directory exists but is empty — no subdirectories with module.json
      const result = spawnManagement(['list'], { MCPX_ROOT: root });

      // list command exits 0 even when no modules found
      expect(result.exitCode).toBe(0);

      // stderr should contain getting-started guidance
      const output = result.stderr;
      expect(output).toContain('No modules found');
      expect(output).toContain('Getting started');
      expect(output).toContain(root);
      expect(output).toContain('module.json');
    });
  });

  describe('Missing .env file', () => {
    it('reports unresolved variables and expected .env path via doctor', () => {
      const { root, modulesDir } = createTempRoot();
      dirsToCleanup.push(root);

      // Create a module that references env vars with empty defaults (unresolved)
      const moduleDir = join(modulesDir, 'env-needy');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify(
          {
            id: 'env-needy',
            name: 'Env Needy Module',
            runtime: 'nodejs',
            entry: 'index.mjs',
            env: {
              API_KEY: '',
              SECRET_TOKEN: '',
            },
          },
          null,
          2,
        ),
        'utf-8',
      );
      // Create the entry file so it passes entry-file check
      writeFileSync(join(moduleDir, 'index.mjs'), 'console.log("hello");\n', 'utf-8');
      // Intentionally do NOT create a .env file

      const result = spawnManagement(['doctor', '--json'], { MCPX_ROOT: root });

      // Parse the JSON output
      const issues = JSON.parse(result.stdout) as Array<{
        module: string;
        check: string;
        severity: string;
        message: string;
        suggestion: string;
      }>;

      // Should have env-resolution warnings for the unresolved variables
      const envIssues = issues.filter(
        (i) => i.module === 'env-needy' && i.check === 'env-resolution',
      );
      expect(envIssues.length).toBeGreaterThan(0);

      // Check that unresolved variable names are mentioned
      const allMessages = envIssues.map((i) => i.message).join(' ');
      expect(allMessages).toContain('API_KEY');
      expect(allMessages).toContain('SECRET_TOKEN');

      // Suggestions should mention .env file
      const allSuggestions = envIssues.map((i) => i.suggestion).join(' ');
      expect(allSuggestions).toContain('.env');
    });
  });

  describe('Early exit detection', () => {
    it('captures and reports module stderr on immediate crash', () => {
      const { root, modulesDir } = createTempRoot();
      dirsToCleanup.push(root);

      // Create a module that exits immediately with an error message on stderr
      const moduleDir = join(modulesDir, 'crash-module');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify(
          {
            id: 'crash-module',
            name: 'Crash Module',
            runtime: 'nodejs',
            entry: 'crash.mjs',
          },
          null,
          2,
        ),
        'utf-8',
      );
      // Create an entry file that writes to stderr and exits with code 1
      writeFileSync(
        join(moduleDir, 'crash.mjs'),
        `process.stderr.write("FATAL: config missing\\n");
process.exit(1);
`,
        'utf-8',
      );

      const result = spawnRun(['crash-module'], { MCPX_ROOT: root });

      // Should exit with non-zero code
      expect(result.exitCode).not.toBe(0);

      // stderr should contain the module's error output
      expect(result.stderr).toContain('FATAL: config missing');
    });
  });

  describe('Missing runtime tool', () => {
    it('reports install suggestion for unavailable runtime', () => {
      const { root, modulesDir } = createTempRoot();
      dirsToCleanup.push(root);

      // Create a module with runtime=go
      const moduleDir = join(modulesDir, 'go-module');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify(
          {
            id: 'go-module',
            name: 'Go Module',
            runtime: 'go',
            entry: 'main.go',
          },
          null,
          2,
        ),
        'utf-8',
      );
      writeFileSync(join(moduleDir, 'main.go'), 'package main\nfunc main() {}\n', 'utf-8');

      // Spawn doctor with a restricted PATH that excludes go but includes node.
      // Some CI images (notably Ubuntu) may have `go` preinstalled in /usr/bin,
      // so we intentionally keep PATH minimal to make this test deterministic.
      const nodeBinDir = dirname(process.execPath);
      const restrictedPath = `${nodeBinDir}`;
      const result = spawnManagement(['doctor', '--json'], {
        MCPX_ROOT: root,
        PATH: restrictedPath,
      });

      // Parse the JSON output
      const issues = JSON.parse(result.stdout) as Array<{
        module: string;
        check: string;
        severity: string;
        message: string;
        suggestion: string;
      }>;

      // Should have a runtime-available error for go-module
      const runtimeIssues = issues.filter(
        (i) => i.module === 'go-module' && i.check === 'runtime-available' && i.severity === 'error',
      );
      expect(runtimeIssues.length).toBeGreaterThan(0);

      // The suggestion should include an install hint
      const suggestion = runtimeIssues[0].suggestion;
      expect(suggestion.toLowerCase()).toMatch(/install|brew|apt|go/);
    });
  });
});
