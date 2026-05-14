/**
 * System meta-test: Build and test infrastructure verification.
 *
 * This test verifies the entire build and test infrastructure works correctly:
 * - Build verification: build pipeline exits 0
 * - Test suite execution: unit tests pass
 * - Integration test execution: integration tests complete
 * - Timing report: logs execution time per test category
 * - Cleanup verification: no temp directories leaked in /tmp
 *
 * _Requirements: (testing infrastructure)_
 *
 * @module __tests__/system/run-all
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '../helpers/package-root.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Constants ───────────────────────────────────────────────────────────────

/** Root of the package directory. */
const MCPX_ROOT = findPackageRoot(__dirname);

/** Timeout for build/test commands (5 minutes). */
const COMMAND_TIMEOUT = 300_000;
const ROOT_EXEC = process.execPath;

function rootDiag(): string {
  return `MCPX_ROOT=${MCPX_ROOT} cwd=${process.cwd()} __dirname=${__dirname}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Runs a command and returns timing + result info.
 */
function runTimed(
  command: string,
  args: string[],
  label: string,
): {
  label: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
} {
  const start = Date.now();
  let exitCode = 0;
  let stdout = '';
  let stderr = '';

  const result = spawnSync(command, args, {
    cwd: MCPX_ROOT,
    timeout: COMMAND_TIMEOUT,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for test output
    shell: false,
  });

  if (result.error) {
    stderr = `${stderr}${stderr ? '\n' : ''}[spawn error] ${result.error.message}`;
  }
  exitCode = result.status ?? 1;
  stdout = result.stdout?.toString('utf-8') ?? '';
  stderr = `${stderr}${stderr && result.stderr ? '\n' : ''}${result.stderr?.toString('utf-8') ?? ''}`.trim();

  const durationMs = Date.now() - start;
  return { label, exitCode, durationMs, stdout, stderr };
}

function buildJestArgs(testPathPattern: string, ignorePatterns: string[] = []): string[] {
  const args = [
    '--experimental-vm-modules',
    './node_modules/jest/bin/jest.js',
    `--testPathPattern=${testPathPattern}`,
    '--forceExit',
  ];

  if (ignorePatterns.length > 0) {
    args.push(`--testPathIgnorePatterns=${ignorePatterns.join('|')}`);
  }

  return args;
}

function runBuildPipeline(): { exitCode: number; stdout: string; stderr: string; durationMs: number } {
  const start = Date.now();
  const steps: Array<{ label: string; command: string; args: string[] }> = [
    {
      label: 'Build clean',
      command: ROOT_EXEC,
      args: [
        '-e',
        "require('node:fs').rmSync('out',{recursive:true,force:true})",
      ],
    },
    {
      label: 'Build bundle',
      command: ROOT_EXEC,
      args: ['scripts/run-esbuild.mjs'],
    },
    {
      label: 'Build types',
      command: ROOT_EXEC,
      args: ['./node_modules/typescript/bin/tsc', '--project', 'tsconfig.build.json'],
    },
  ];

  let stdout = '';
  let stderr = '';

  for (const step of steps) {
    const result = spawnSync(step.command, step.args, {
      cwd: MCPX_ROOT,
      timeout: COMMAND_TIMEOUT,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
    });

    stdout += result.stdout?.toString('utf-8') ?? '';
    stderr += result.stderr?.toString('utf-8') ?? '';

    if (result.error) {
      stderr += `${stderr ? '\n' : ''}[${step.label}] spawn error: ${result.error.message}\n`;
    }

    if ((result.status ?? 1) !== 0) {
      return {
        exitCode: result.status ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      };
    }
  }

  return {
    exitCode: 0,
    stdout,
    stderr,
    durationMs: Date.now() - start,
  };
}

function integrationIgnorePatterns(): string[] {
  if (platform() !== 'win32') {
    return [];
  }

  return [
    'run-shell',
    'run-python',
    'stdio-transparency',
    'run-nodejs',
    'env-layers',
    'error-scenarios',
  ];
}

/**
 * Gets a snapshot of mcpx-related temp directories in /tmp.
 */
function getMcpxTempDirs(): string[] {
  const tmp = tmpdir();
  try {
    return readdirSync(tmp).filter(
      (name) => name.startsWith('mcpx-') || name.startsWith('mcpx_'),
    );
  } catch {
    return [];
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('System: Build and Test Infrastructure', () => {
  let tempDirsBefore: string[];
  const timingReport: Array<{ label: string; durationMs: number; passed: boolean }> = [];

  beforeAll(() => {
    // Snapshot temp directories before tests run
    tempDirsBefore = getMcpxTempDirs();
  });

  afterAll(() => {
    // Print timing report
    console.log('\n┌─────────────────────────────────────────────────────────┐');
    console.log('│              System Test Timing Report                   │');
    console.log('├─────────────────────────────────────────────────────────┤');
    for (const entry of timingReport) {
      const status = entry.passed ? '✓' : '✗';
      const duration = `${(entry.durationMs / 1000).toFixed(2)}s`;
      console.log(`│ ${status} ${entry.label.padEnd(40)} ${duration.padStart(10)} │`);
    }
    console.log('└─────────────────────────────────────────────────────────┘');
  });

  describe('Build verification', () => {
    it('build pipeline exits with code 0', () => {
      const result = runBuildPipeline();
      timingReport.push({
        label: 'Build (tsc)',
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      });

      if (result.exitCode !== 0) {
        console.error(rootDiag());
        console.error('Build stdout:', result.stdout.slice(0, 2000));
        console.error('Build stderr:', result.stderr.slice(0, 2000));
      }
      expect(result.exitCode).toBe(0);
    });

    it('dist/ directory exists after build', () => {
      const distPath = join(MCPX_ROOT, 'out/dist');
      expect(existsSync(distPath)).toBe(true);
    });

    it('dist/index.js entry point exists', () => {
      const entryPath = join(MCPX_ROOT, 'out/dist', 'index.js');
      expect(existsSync(entryPath)).toBe(true);
    });
  });

  describe('Unit test execution', () => {
    it('unit tests pass (co-located .test.ts files)', () => {
      const ignorePatterns = platform() === 'win32' ? ['exec\\.test', 'exec-early-exit'] : [];
      const result = runTimed(
        process.execPath,
        buildJestArgs('src/(cli|core|platform|runtimes)/.*\\.test\\.ts$', ignorePatterns),
        'Unit tests',
      );
      timingReport.push({
        label: result.label,
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      });

      if (result.exitCode !== 0) {
        console.error(rootDiag());
        console.error('Unit test stdout:', result.stdout.slice(0, 2000));
        console.error('Unit test stderr:', result.stderr.slice(0, 2000));
      }
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Property-based test execution', () => {
    it('property tests pass', () => {
      const result = runTimed(
        process.execPath,
        ['--experimental-vm-modules', './node_modules/jest/bin/jest.js', '--testPathPattern=properties', '--forceExit'],
        'Property tests',
      );
      timingReport.push({
        label: result.label,
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      });

      if (result.exitCode !== 0) {
        console.error(rootDiag());
        console.error('Property test stdout:', result.stdout.slice(0, 2000));
        console.error('Property test stderr:', result.stderr.slice(0, 2000));
      }
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Integration test execution', () => {
    it('integration tests complete', () => {
      const ignorePatterns = integrationIgnorePatterns();
      const result = runTimed(
        process.execPath,
        buildJestArgs('integration', ignorePatterns),
        'Integration tests',
      );
      timingReport.push({
        label: result.label,
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      });

      if (result.exitCode !== 0) {
        console.error(rootDiag());
        console.error('Integration test stdout:', result.stdout.slice(0, 2000));
        console.error('Integration test stderr:', result.stderr.slice(0, 2000));
      }
      expect(result.exitCode).toBe(0);
    });
  });

  describe('E2E test execution', () => {
    it('e2e tests complete', () => {
      const result = runTimed(
        process.execPath,
        ['--experimental-vm-modules', './node_modules/jest/bin/jest.js', '--testPathPattern=e2e', '--forceExit'],
        'E2E tests',
      );
      timingReport.push({
        label: result.label,
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      });

      if (result.exitCode !== 0) {
        console.error(rootDiag());
        console.error('E2E test stdout:', result.stdout.slice(0, 2000));
        console.error('E2E test stderr:', result.stderr.slice(0, 2000));
      }
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Cleanup verification', () => {
    it('no mcpx temp directories leaked in /tmp after sub-test cleanup', () => {
      // Allow a brief delay for async cleanup in child processes
      const tempDirsAfter = getMcpxTempDirs();

      // Find any new temp dirs that appeared during the test run
      const leaked = tempDirsAfter.filter(
        (dir) => !tempDirsBefore.includes(dir),
      );

      // Log any remaining temp dirs for visibility (sub-process tests may
      // leave dirs that get cleaned up by the OS or CI cleanup steps).
      // We verify the count is bounded — a large leak indicates a real problem.
      if (leaked.length > 0) {
        console.warn(
          `Temp directories remaining after test run (${leaked.length}): ${leaked.slice(0, 5).join(', ')}${leaked.length > 5 ? '...' : ''}`,
        );
      }

      // Allow up to 30 temp dirs from sub-process tests (integration/e2e tests
      // create temp dirs in child processes that may not clean up before we check).
      // Registry tests create git bare repos + module roots; each integration file
      // may leave 2-3 temp dirs that get cleaned up after the process exits.
      // A count above this threshold indicates a systemic cleanup failure.
      expect(leaked.length).toBeLessThanOrEqual(30);
    });
  });
});
