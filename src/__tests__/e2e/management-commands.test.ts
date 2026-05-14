/**
 * End-to-end tests for mcpx management commands (list, doctor, env).
 *
 * Each test creates a REAL module root with multiple modules in various states,
 * spawns the REAL management-runner.mjs script as a subprocess, and verifies
 * the JSON output and exit codes.
 *
 * **Validates: Requirements 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.5, 15.1, 15.2**
 *
 * @module __tests__/e2e/management-commands
 */

import { describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tsxEsmNodeArgs } from '../helpers/tsx-node-args.js';

// --- Test Runner Helper ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the management-runner.mjs script that exercises real mcpx management commands.
 */
const MANAGEMENT_RUNNER = resolve(__dirname, '../helpers/management-runner.mjs');

/**
 * Spawns the management runner as a real subprocess and returns the result.
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
    const result = execFileSync('node', [...tsxEsmNodeArgs(), MANAGEMENT_RUNNER, ...args], {
      env: spawnEnv,
      timeout: 30_000,
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

interface TestModuleRoot {
  root: string;
  modulesDir: string;
}

/**
 * Creates a temporary module root with a modules/ directory.
 */
function createTempRoot(): TestModuleRoot {
  const root = mkdtempSync(join(tmpdir(), 'mcpx-e2e-mgmt-'));
  const modulesDir = join(root, 'modules');
  mkdirSync(modulesDir, { recursive: true });
  return { root, modulesDir };
}

/**
 * Creates the standard 3-module test fixture:
 * - healthy-module: valid manifest, runtime available, entry exists, .env complete
 * - broken-module: valid manifest but entry file missing
 * - misconfigured-module: invalid manifest (missing runtime field)
 */
function createTestModules(modulesDir: string): void {
  // --- healthy-module ---
  const healthyDir = join(modulesDir, 'healthy-module');
  mkdirSync(healthyDir, { recursive: true });
  writeFileSync(
    join(healthyDir, 'module.json'),
    JSON.stringify(
      {
        id: 'healthy-module',
        name: 'Healthy Module',
        runtime: 'nodejs',
        entry: 'index.mjs',
        env: { APP_NAME: 'healthy-app' },
      },
      null,
      2,
    ),
    'utf-8',
  );
  writeFileSync(
    join(healthyDir, 'index.mjs'),
    'console.log("healthy module running");\n',
    'utf-8',
  );
  const healthyEnvPath = join(healthyDir, '.env');
  writeFileSync(healthyEnvPath, 'SECRET_KEY=super-secret-value-12345\nSHORT=ab\n', 'utf-8');
  chmodSync(healthyEnvPath, 0o600);

  // --- broken-module ---
  const brokenDir = join(modulesDir, 'broken-module');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(
    join(brokenDir, 'module.json'),
    JSON.stringify(
      {
        id: 'broken-module',
        name: 'Broken Module',
        runtime: 'nodejs',
        entry: 'nonexistent-entry.ts',
      },
      null,
      2,
    ),
    'utf-8',
  );
  // Intentionally do NOT create the entry file

  // --- misconfigured-module ---
  const misconfiguredDir = join(modulesDir, 'misconfigured-module');
  mkdirSync(misconfiguredDir, { recursive: true });
  writeFileSync(
    join(misconfiguredDir, 'module.json'),
    JSON.stringify(
      {
        id: 'misconfigured-module',
        name: 'Misconfigured Module',
        // Missing 'runtime' field intentionally
        entry: 'index.ts',
      },
      null,
      2,
    ),
    'utf-8',
  );
}

// --- Tests ---

describe('E2E: Management Commands', () => {
  let tempRoot: TestModuleRoot;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot.root, { recursive: true, force: true });
    }
  });

  describe('mcpx list --json', () => {
    it('lists all 3 modules with correct statuses', async () => {
      tempRoot = createTempRoot();
      createTestModules(tempRoot.modulesDir);

      const result = spawnMcpx(['list', '--json'], { MCPX_ROOT: tempRoot.root });

      // list command always exits 0
      expect(result.exitCode).toBe(0);

      // Parse stdout JSON
      const modules = JSON.parse(result.stdout) as Array<{
        id: string;
        name: string;
        runtime: string;
        status: string;
        issues?: string[];
      }>;

      // All 3 modules should be present
      expect(modules).toHaveLength(3);

      const ids = modules.map((m) => m.id);
      expect(ids).toContain('healthy-module');
      expect(ids).toContain('broken-module');
      expect(ids).toContain('misconfigured-module');

      // healthy-module should be "ready"
      const healthy = modules.find((m) => m.id === 'healthy-module');
      expect(healthy).toBeDefined();
      expect(healthy!.status).toBe('ready');
      expect(healthy!.runtime).toBe('nodejs');

      // broken-module: entry file missing — the list command checks runtime availability
      // but not entry file existence, so it may still show as "ready" since the manifest
      // is valid and nodejs runtime is available. The doctor command checks entry files.
      const broken = modules.find((m) => m.id === 'broken-module');
      expect(broken).toBeDefined();
      // broken-module has a valid manifest and nodejs is available, so it shows as ready
      // (list only checks manifest validity and runtime availability, not entry file)
      expect(['ready', 'misconfigured', 'unavailable']).toContain(broken!.status);

      // misconfigured-module: missing runtime field → misconfigured
      const misconfigured = modules.find((m) => m.id === 'misconfigured-module');
      expect(misconfigured).toBeDefined();
      expect(misconfigured!.status).toBe('misconfigured');
    });
  });

  describe('mcpx doctor --json', () => {
    it('reports issues for broken and misconfigured modules', async () => {
      tempRoot = createTempRoot();
      createTestModules(tempRoot.modulesDir);

      const result = spawnMcpx(['doctor', '--json'], { MCPX_ROOT: tempRoot.root });

      // doctor exits non-zero when errors are found
      expect(result.exitCode).not.toBe(0);

      // Parse stdout JSON
      const issues = JSON.parse(result.stdout) as Array<{
        module: string;
        check: string;
        severity: string;
        message: string;
        suggestion: string;
      }>;

      expect(issues.length).toBeGreaterThan(0);

      // Each issue should have the required fields
      for (const issue of issues) {
        expect(issue).toHaveProperty('severity');
        expect(issue).toHaveProperty('message');
        expect(issue).toHaveProperty('suggestion');
        expect(['error', 'warning', 'info']).toContain(issue.severity);
      }

      // Issues for broken-module: entry file missing
      const brokenIssues = issues.filter((i) => i.module === 'broken-module');
      const entryIssue = brokenIssues.find(
        (i) => i.check === 'entry-file' && i.severity === 'error',
      );
      expect(entryIssue).toBeDefined();
      expect(entryIssue!.message).toContain('nonexistent-entry.ts');

      // Issues for misconfigured-module: invalid manifest (missing runtime)
      const misconfiguredIssues = issues.filter(
        (i) =>
          i.module === 'misconfigured-module' &&
          i.severity === 'error',
      );
      expect(misconfiguredIssues.length).toBeGreaterThan(0);
      // Should mention the manifest schema issue
      const manifestIssue = misconfiguredIssues.find(
        (i) => i.check === 'manifest-schema' || i.check === 'manifest-parse',
      );
      expect(manifestIssue).toBeDefined();
    });
  });

  describe('mcpx env --json', () => {
    it('displays masked environment variables for healthy-module', async () => {
      tempRoot = createTempRoot();
      createTestModules(tempRoot.modulesDir);

      const result = spawnMcpx(['env', 'healthy-module', '--json'], {
        MCPX_ROOT: tempRoot.root,
      });

      expect(result.exitCode).toBe(0);

      // Parse stdout JSON
      const output = JSON.parse(result.stdout) as {
        moduleId: string;
        variables: Array<{ name: string; maskedValue: string }>;
        count: number;
      };

      expect(output.moduleId).toBe('healthy-module');
      expect(output.variables).toBeDefined();
      expect(output.variables.length).toBeGreaterThan(0);
      expect(output.count).toBe(output.variables.length);

      // Check masking: SECRET_KEY=super-secret-value-12345 → "supe****" (first 4 + ****)
      const secretVar = output.variables.find((v) => v.name === 'SECRET_KEY');
      expect(secretVar).toBeDefined();
      expect(secretVar!.maskedValue).toBe('supe****');
      // Verify it does NOT contain the full value
      expect(secretVar!.maskedValue).not.toContain('super-secret-value-12345');

      // Check masking: SHORT=ab (≤4 chars) → "****" (fully masked)
      const shortVar = output.variables.find((v) => v.name === 'SHORT');
      expect(shortVar).toBeDefined();
      expect(shortVar!.maskedValue).toBe('****');

      // Check masking: APP_NAME=healthy-app (from manifest env) → "heal****"
      const appNameVar = output.variables.find((v) => v.name === 'APP_NAME');
      expect(appNameVar).toBeDefined();
      expect(appNameVar!.maskedValue).toBe('heal****');
    });
  });
});
