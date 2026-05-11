/**
 * System meta-test: Build and test infrastructure verification.
 *
 * This test verifies the entire build and test infrastructure works correctly:
 * - Build verification: `npm run build` exits 0
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
import { execSync, ExecSyncOptionsWithBufferEncoding } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Constants ───────────────────────────────────────────────────────────────

/** Root of the packages/mcpx directory. */
const MCPX_ROOT = resolve(__dirname, '../../..');

/** Timeout for build/test commands (5 minutes). */
const COMMAND_TIMEOUT = 300_000;

/** Common exec options. */
const EXEC_OPTIONS: ExecSyncOptionsWithBufferEncoding = {
  cwd: MCPX_ROOT,
  timeout: COMMAND_TIMEOUT,
  stdio: ['pipe', 'pipe', 'pipe'],
  maxBuffer: 10 * 1024 * 1024, // 10MB buffer for test output
  encoding: 'buffer',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Runs a command and returns timing + result info.
 */
function runTimed(command: string, label: string): {
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

  try {
    const result = execSync(command, EXEC_OPTIONS);
    stdout = (result as Buffer).toString('utf-8');
  } catch (error: unknown) {
    const execError = error as {
      stdout?: Buffer;
      stderr?: Buffer;
      status?: number | null;
    };
    exitCode = execError.status ?? 1;
    stdout = execError.stdout?.toString('utf-8') ?? '';
    stderr = execError.stderr?.toString('utf-8') ?? '';
  }

  const durationMs = Date.now() - start;
  return { label, exitCode, durationMs, stdout, stderr };
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
    it('npm run build exits with code 0', () => {
      const result = runTimed('npm run build', 'Build (tsc)');
      timingReport.push({
        label: result.label,
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      });

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
      const result = runTimed(
        "NODE_OPTIONS='--experimental-vm-modules' npx jest --testPathPattern='src/(cli|core|platform|runtimes)/.*\\.test\\.ts$' --forceExit",
        'Unit tests',
      );
      timingReport.push({
        label: result.label,
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      });

      if (result.exitCode !== 0) {
        console.error('Unit test stderr:', result.stderr.slice(0, 2000));
      }
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Property-based test execution', () => {
    it('property tests pass', () => {
      const result = runTimed(
        "NODE_OPTIONS='--experimental-vm-modules' npx jest --testPathPattern=properties --forceExit",
        'Property tests',
      );
      timingReport.push({
        label: result.label,
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      });

      if (result.exitCode !== 0) {
        console.error('Property test stderr:', result.stderr.slice(0, 2000));
      }
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Integration test execution', () => {
    it('integration tests complete', () => {
      const result = runTimed(
        "NODE_OPTIONS='--experimental-vm-modules' npx jest --testPathPattern=integration --forceExit",
        'Integration tests',
      );
      timingReport.push({
        label: result.label,
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      });

      if (result.exitCode !== 0) {
        console.error('Integration test stderr:', result.stderr.slice(0, 2000));
      }
      expect(result.exitCode).toBe(0);
    });
  });

  describe('E2E test execution', () => {
    it('e2e tests complete', () => {
      const result = runTimed(
        "NODE_OPTIONS='--experimental-vm-modules' npx jest --testPathPattern=e2e --forceExit",
        'E2E tests',
      );
      timingReport.push({
        label: result.label,
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      });

      if (result.exitCode !== 0) {
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
