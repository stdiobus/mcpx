/**
 * E2E test: Cross-module isolation verification.
 *
 * Creates 5 modules in the same root, each with different .env files
 * containing unique secrets. Verifies that:
 *
 * 1. Environment isolation: module A's secrets do NOT appear in module B's env dump
 * 2. Working directory isolation: each module's cwd is its own directory
 * 3. Sequential execution doesn't leak state: artifacts from module A don't appear in module B
 *
 * Each test spawns a REAL mcpx process via the shell-integration-runner.mjs helper,
 * exercising the full resolve → env-load → exec pipeline.
 *
 * **Validates: Requirements 3.1, 5.3, 6.3, 7.3, 8.3**
 *
 * @module __tests__/e2e/cross-module-isolation
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

// ─── Constants ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the mcpx bin shim (real CLI). */
const MCPX_BIN = resolve(__dirname, '../../../bin/mcpx');

/** Timeout for spawned processes. */
const SPAWN_TIMEOUT = 30_000;

/** Module names for the 5 test modules. */
const MODULE_NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ModuleSetup {
  root: string;
  moduleDirs: Record<string, string>;
  outputDir: string;
  secrets: Record<string, Record<string, string>>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Creates a module root with 5 modules, each having unique secrets in their .env files.
 * Also creates a root-level .env with shared variables.
 */
function createIsolatedModules(): ModuleSetup {
  const root = mkdtempSync(join(tmpdir(), 'mcpx-isolation-'));
  const modulesDir = join(root, 'modules');
  mkdirSync(modulesDir, { recursive: true });

  const outputDir = mkdtempSync(join(tmpdir(), 'mcpx-isolation-output-'));

  const moduleDirs: Record<string, string> = {};
  const secrets: Record<string, Record<string, string>> = {};

  // Root .env with shared variables
  writeFileSync(
    join(root, '.env'),
    'ROOT_SHARED_VAR=shared-root-value\nROOT_API_KEY=root-key-12345\n',
    'utf-8',
  );
  chmodSync(join(root, '.env'), 0o600);

  // Create 5 modules, each with unique secrets
  for (const name of MODULE_NAMES) {
    const moduleDir = join(modulesDir, name);
    mkdirSync(moduleDir, { recursive: true });
    moduleDirs[name] = moduleDir;

    // Unique secrets for this module
    const moduleSecrets: Record<string, string> = {
      [`${name.toUpperCase()}_SECRET`]: `secret-${name}-${Date.now()}`,
      [`${name.toUpperCase()}_API_KEY`]: `api-key-${name}-unique`,
      [`${name.toUpperCase()}_TOKEN`]: `token-${name}-private`,
    };
    secrets[name] = moduleSecrets;

    // Write module .env with unique secrets
    const envContent = Object.entries(moduleSecrets)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    writeFileSync(join(moduleDir, '.env'), envContent + '\n', 'utf-8');
    chmodSync(join(moduleDir, '.env'), 0o600);

    // Write module.json
    const manifest = {
      id: name,
      name: `Module ${name}`,
      runtime: 'nodejs',
      entry: 'probe.mjs',
    };
    writeFileSync(
      join(moduleDir, 'module.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf-8',
    );

    // Write probe.mjs — dumps env, cwd, and creates an artifact file (cross-platform)
    const outputPath = join(outputDir, `${name}-output.json`);
    const artifactPath = join(moduleDir, `${name}-artifact.txt`);
    const probeScript = `
import { writeFileSync, existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';

// Create an artifact file to test state leakage
writeFileSync(${JSON.stringify(artifactPath)}, 'artifact-from-' + ${JSON.stringify(name)});

// Check for artifacts from other modules
const cwd = process.cwd();
const otherArtifacts = [];
const moduleNames = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
for (const m of moduleNames) {
  if (m === ${JSON.stringify(name)}) continue;
  const artifactFile = joinPath(cwd, m + '-artifact.txt');
  if (existsSync(artifactFile)) otherArtifacts.push(m);
}

const output = {
  module: ${JSON.stringify(name)},
  pid: process.pid,
  cwd,
  env: process.env,
  otherArtifactsInCwd: otherArtifacts,
};

writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(output, null, 2));
`;
    writeFileSync(join(moduleDir, 'probe.mjs'), probeScript, 'utf-8');
  }

  return { root, moduleDirs, outputDir, secrets };
}

/**
 * Spawns the shell integration runner for a specific module.
 */
function spawnModule(
  moduleId: string,
  env: Record<string, string>,
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
    const result = execFileSync('node', [MCPX_BIN, 'run', moduleId], {
      env: spawnEnv,
      timeout: SPAWN_TIMEOUT,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
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

/**
 * Reads the output JSON file for a given module.
 */
function readModuleOutput(outputDir: string, moduleName: string): {
  module: string;
  pid: number;
  cwd: string;
  env: Record<string, string>;
  otherArtifactsInCwd: string[];
} {
  const outputPath = join(outputDir, `${moduleName}-output.json`);
  expect(existsSync(outputPath)).toBe(true);
  return JSON.parse(readFileSync(outputPath, 'utf-8'));
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('E2E: Cross-module isolation', () => {
  let setup: ModuleSetup;

  beforeAll(() => {
    setup = createIsolatedModules();
  });

  afterAll(() => {
    if (setup?.root && existsSync(setup.root)) {
      rmSync(setup.root, { recursive: true, force: true });
    }
    if (setup?.outputDir && existsSync(setup.outputDir)) {
      rmSync(setup.outputDir, { recursive: true, force: true });
    }
  });

  describe('Environment isolation', () => {
    it('each module only sees its own secrets and root shared vars, not other modules secrets', () => {
      // Run each module sequentially
      for (const name of MODULE_NAMES) {
        const result = spawnModule(name, { MCPX_ROOT: setup.root });
        expect(result.exitCode).toBe(0);
      }

      // Now verify isolation for each module
      for (const name of MODULE_NAMES) {
        const output = readModuleOutput(setup.outputDir, name);

        // Module should see its OWN secrets
        for (const [key, value] of Object.entries(setup.secrets[name])) {
          expect(output.env[key]).toBe(value);
        }

        // Module should see root shared vars
        expect(output.env['ROOT_SHARED_VAR']).toBe('shared-root-value');
        expect(output.env['ROOT_API_KEY']).toBe('root-key-12345');

        // Module should NOT see OTHER modules' secrets
        for (const otherName of MODULE_NAMES) {
          if (otherName === name) continue;
          for (const key of Object.keys(setup.secrets[otherName])) {
            expect(output.env[key]).toBeUndefined();
          }
        }
      }
    });

    it('only root .env vars are shared across all modules', () => {
      // Run all modules
      for (const name of MODULE_NAMES) {
        const result = spawnModule(name, { MCPX_ROOT: setup.root });
        expect(result.exitCode).toBe(0);
      }

      // Verify root vars are present in ALL modules
      for (const name of MODULE_NAMES) {
        const output = readModuleOutput(setup.outputDir, name);
        expect(output.env['ROOT_SHARED_VAR']).toBe('shared-root-value');
        expect(output.env['ROOT_API_KEY']).toBe('root-key-12345');
      }
    });
  });

  describe('Working directory isolation', () => {
    it('each module cwd is its own directory, not another modules directory', () => {
      for (const name of MODULE_NAMES) {
        const result = spawnModule(name, { MCPX_ROOT: setup.root });
        expect(result.exitCode).toBe(0);

        const output = readModuleOutput(setup.outputDir, name);

        // Resolve symlinks for comparison (macOS /var → /private/var)
        const expectedDir = realpathSync(setup.moduleDirs[name]);
        expect(output.cwd).toBe(expectedDir);

        // Verify it's NOT another module's directory
        for (const otherName of MODULE_NAMES) {
          if (otherName === name) continue;
          const otherDir = realpathSync(setup.moduleDirs[otherName]);
          expect(output.cwd).not.toBe(otherDir);
        }
      }
    });
  });

  describe('Sequential execution does not leak state', () => {
    it('module B does not see artifacts from module A execution', () => {
      // Create a fresh setup for this test to ensure clean state
      const freshSetup = createIsolatedModules();

      try {
        // Run modules in sequence: alpha → bravo → charlie → delta → echo
        for (const name of MODULE_NAMES) {
          const result = spawnModule(name, { MCPX_ROOT: freshSetup.root });
          expect(result.exitCode).toBe(0);
        }

        // Each module should NOT see artifacts from other modules in its cwd
        // (artifacts are created in each module's own directory, so they shouldn't
        // appear in another module's cwd)
        for (const name of MODULE_NAMES) {
          const output = readModuleOutput(freshSetup.outputDir, name);

          // The probe script checks for artifact files from other modules in its cwd
          // Since each module runs in its own directory, it should not find other modules' artifacts
          expect(output.otherArtifactsInCwd).toEqual([]);
        }
      } finally {
        if (freshSetup.root && existsSync(freshSetup.root)) {
          rmSync(freshSetup.root, { recursive: true, force: true });
        }
        if (freshSetup.outputDir && existsSync(freshSetup.outputDir)) {
          rmSync(freshSetup.outputDir, { recursive: true, force: true });
        }
      }
    });

    it('running module A then module B — B env is clean of A state', () => {
      const freshSetup = createIsolatedModules();

      try {
        // Run alpha first
        const resultA = spawnModule('alpha', { MCPX_ROOT: freshSetup.root });
        expect(resultA.exitCode).toBe(0);

        // Then run bravo
        const resultB = spawnModule('bravo', { MCPX_ROOT: freshSetup.root });
        expect(resultB.exitCode).toBe(0);

        const outputB = readModuleOutput(freshSetup.outputDir, 'bravo');

        // Bravo should NOT have alpha's secrets
        for (const key of Object.keys(freshSetup.secrets['alpha'])) {
          expect(outputB.env[key]).toBeUndefined();
        }

        // Bravo should have its own secrets
        for (const [key, value] of Object.entries(freshSetup.secrets['bravo'])) {
          expect(outputB.env[key]).toBe(value);
        }

        // Bravo should not see alpha's artifact in its cwd
        expect(outputB.otherArtifactsInCwd).toEqual([]);
      } finally {
        if (freshSetup.root && existsSync(freshSetup.root)) {
          rmSync(freshSetup.root, { recursive: true, force: true });
        }
        if (freshSetup.outputDir && existsSync(freshSetup.outputDir)) {
          rmSync(freshSetup.outputDir, { recursive: true, force: true });
        }
      }
    });
  });
});
