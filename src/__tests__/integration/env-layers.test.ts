/**
 * Integration test: Real environment layering with all 4 precedence levels.
 *
 * This test creates a REAL module ecosystem with all 4 env layers:
 *   1. System env (set via spawn env — highest precedence)
 *   2. Module .env ({module_dir}/.env)
 *   3. Root .env ({Module_Root}/.env)
 *   4. Manifest defaults (module.json env field — lowest precedence)
 *
 * A shell probe module dumps its environment to a JSON file on execution.
 * The test spawns a REAL process that loads env using the compiled mcpx
 * env-loader and then executes the shell module.
 *
 * Tests 15+ variables across layers to verify precedence with no edge cases.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6**
 *
 * @module __tests__/integration/env-layers
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

// ─── Constants ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the env-layers runner script that exercises real env loading + exec. */
const ENV_LAYERS_RUNNER = resolve(__dirname, '../helpers/env-layers-runner.mjs');

/** Timeout for spawned processes (shell modules should be fast). */
const SPAWN_TIMEOUT = 15_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Spawns the env-layers runner as a real subprocess.
 *
 * @param moduleId - The module ID to run
 * @param env - Environment variables to set for the spawned process
 * @returns Object with stdout, stderr, and exitCode
 */
function spawnEnvRunner(
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
    const result = execFileSync('node', [ENV_LAYERS_RUNNER, moduleId], {
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
 * Write a .env file from a record of key-value pairs.
 */
function writeEnvFile(dir: string, vars: Record<string, string>): void {
  const content = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const envPath = join(dir, '.env');
  writeFileSync(envPath, content + '\n', 'utf-8');
  chmodSync(envPath, 0o600);
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Integration: Real Environment Layering', () => {
  let tempRoot: string;
  let modulesDir: string;
  let moduleDir: string;
  let outputPath: string;

  // Shell probe script that dumps all env vars to a JSON file
  const probeScript = `#!/bin/sh
# Dump all environment variables as JSON to the output file
OUTPUT_FILE="$ENV_PROBE_OUTPUT"
# Use node to produce proper JSON from env
node -e "
const fs = require('fs');
const output = JSON.stringify(process.env, null, 2);
fs.writeFileSync(process.env.ENV_PROBE_OUTPUT, output);
"
`;

  beforeAll(() => {
    // Create temp directory structure
    tempRoot = mkdtempSync(join(tmpdir(), 'mcpx-env-layers-'));
    modulesDir = join(tempRoot, 'modules');
    moduleDir = join(modulesDir, 'env-probe');
    mkdirSync(moduleDir, { recursive: true });

    // Create output file path
    const outputDir = mkdtempSync(join(tmpdir(), 'mcpx-env-output-'));
    outputPath = join(outputDir, 'env-output.json');
  });

  afterAll(() => {
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    // Clean up output dir
    const outputDir = dirname(outputPath);
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  describe('Full 4-layer precedence verification', () => {
    it('verifies system env > module .env > root .env > manifest defaults with 15+ variables', () => {
      // ── Layer 4 (lowest): Manifest defaults ──
      const manifestEnv: Record<string, string> = {
        LAYER_TEST: 'manifest-val',
        MOD_ONLY: 'manifest-val',
        ROOT_ONLY: 'manifest-val',
        MANIFEST_ONLY: 'manifest-only-val',
        SHARED_ALL: 'manifest-shared',
        MANIFEST_A: 'manifest-a-val',
        MANIFEST_B: 'manifest-b-val',
        MANIFEST_C: 'manifest-c-val',
        PRECEDENCE_1: 'manifest-p1',
        PRECEDENCE_2: 'manifest-p2',
        PRECEDENCE_3: 'manifest-p3',
        PRECEDENCE_4: 'manifest-p4',
        NUMERIC_VAR: '100',
        PATH_LIKE_VAR: '/manifest/path/value',
        SPECIAL_CHARS: 'manifest-special_chars.test',
        EMPTY_OVERRIDE: 'manifest-empty-override',
      };

      // ── Layer 3: Root .env ──
      const rootEnvVars: Record<string, string> = {
        LAYER_TEST: 'root-val',
        MOD_ONLY: 'root-val',
        ROOT_ONLY: 'root-only-val',
        SHARED_ALL: 'root-shared',
        ROOT_A: 'root-a-val',
        ROOT_B: 'root-b-val',
        PRECEDENCE_1: 'root-p1',
        PRECEDENCE_2: 'root-p2',
        PRECEDENCE_3: 'root-p3',
        NUMERIC_VAR: '200',
        PATH_LIKE_VAR: '/root/path/value',
        SPECIAL_CHARS: 'root-special_chars.test',
        EMPTY_OVERRIDE: 'root-empty-override',
      };

      // ── Layer 2: Module .env ──
      const moduleEnvVars: Record<string, string> = {
        LAYER_TEST: 'module-val',
        MOD_ONLY: 'mod-only-val',
        SHARED_ALL: 'module-shared',
        MODULE_A: 'module-a-val',
        MODULE_B: 'module-b-val',
        PRECEDENCE_1: 'module-p1',
        PRECEDENCE_2: 'module-p2',
        NUMERIC_VAR: '300',
        PATH_LIKE_VAR: '/module/path/value',
        SPECIAL_CHARS: 'module-special_chars.test',
        EMPTY_OVERRIDE: 'module-empty-override',
      };

      // ── Layer 1 (highest): System env (passed via spawn) ──
      const systemEnv: Record<string, string> = {
        LAYER_TEST: 'system-wins',
        SHARED_ALL: 'system-shared',
        SYSTEM_ONLY: 'system-only-val',
        PRECEDENCE_1: 'system-p1',
        NUMERIC_VAR: '400',
        PATH_LIKE_VAR: '/system/path/value',
      };

      // Write module.json with manifest env defaults
      const manifest = {
        id: 'env-probe',
        name: 'Environment Probe',
        runtime: 'shell',
        entry: 'probe.sh',
        env: manifestEnv,
      };
      writeFileSync(join(moduleDir, 'module.json'), JSON.stringify(manifest, null, 2) + '\n');

      // Write probe shell script
      writeFileSync(join(moduleDir, 'probe.sh'), probeScript, { mode: 0o755 });

      // Write root .env
      writeEnvFile(tempRoot, rootEnvVars);

      // Write module .env
      writeEnvFile(moduleDir, moduleEnvVars);

      // Spawn the runner with system env vars
      const result = spawnEnvRunner('env-probe', {
        MCPX_ROOT: tempRoot,
        ENV_PROBE_OUTPUT: outputPath,
        ...systemEnv,
      });

      // The runner should exit successfully
      expect(result.exitCode).toBe(0);

      // Read the probe output
      expect(existsSync(outputPath)).toBe(true);
      const envOutput: Record<string, string> = JSON.parse(
        readFileSync(outputPath, 'utf-8'),
      );

      // ── Verify precedence with real values ──

      // System env wins over all (Layer 1 > Layer 2, 3, 4)
      expect(envOutput['LAYER_TEST']).toBe('system-wins');
      expect(envOutput['SHARED_ALL']).toBe('system-shared');
      expect(envOutput['SYSTEM_ONLY']).toBe('system-only-val');
      expect(envOutput['PRECEDENCE_1']).toBe('system-p1');
      expect(envOutput['NUMERIC_VAR']).toBe('400');
      expect(envOutput['PATH_LIKE_VAR']).toBe('/system/path/value');

      // Module .env wins over root .env and manifest (Layer 2 > Layer 3, 4)
      expect(envOutput['MOD_ONLY']).toBe('mod-only-val');
      expect(envOutput['MODULE_A']).toBe('module-a-val');
      expect(envOutput['MODULE_B']).toBe('module-b-val');
      expect(envOutput['PRECEDENCE_2']).toBe('module-p2');
      expect(envOutput['SPECIAL_CHARS']).toBe('module-special_chars.test');
      expect(envOutput['EMPTY_OVERRIDE']).toBe('module-empty-override');

      // Root .env wins over manifest (Layer 3 > Layer 4)
      expect(envOutput['ROOT_ONLY']).toBe('root-only-val');
      expect(envOutput['ROOT_A']).toBe('root-a-val');
      expect(envOutput['ROOT_B']).toBe('root-b-val');
      expect(envOutput['PRECEDENCE_3']).toBe('root-p3');

      // Manifest defaults apply when nothing else provides (Layer 4 only)
      expect(envOutput['MANIFEST_ONLY']).toBe('manifest-only-val');
      expect(envOutput['MANIFEST_A']).toBe('manifest-a-val');
      expect(envOutput['MANIFEST_B']).toBe('manifest-b-val');
      expect(envOutput['MANIFEST_C']).toBe('manifest-c-val');
      expect(envOutput['PRECEDENCE_4']).toBe('manifest-p4');
    });
  });

  describe('Edge cases across layers', () => {
    it('variables defined only in one layer resolve correctly', () => {
      // Reset module structure for this test
      const testRoot = mkdtempSync(join(tmpdir(), 'mcpx-env-edge-'));
      const testModulesDir = join(testRoot, 'modules');
      const testModuleDir = join(testModulesDir, 'edge-probe');
      mkdirSync(testModuleDir, { recursive: true });

      const edgeOutputDir = mkdtempSync(join(tmpdir(), 'mcpx-env-edge-out-'));
      const edgeOutputPath = join(edgeOutputDir, 'env-output.json');

      try {
        // Manifest-only vars
        const manifest = {
          id: 'edge-probe',
          name: 'Edge Probe',
          runtime: 'shell',
          entry: 'probe.sh',
          env: {
            ONLY_IN_MANIFEST: 'from-manifest',
            OVERRIDE_BY_ROOT: 'manifest-default',
            OVERRIDE_BY_MODULE: 'manifest-default',
            OVERRIDE_BY_SYSTEM: 'manifest-default',
          },
        };
        writeFileSync(join(testModuleDir, 'module.json'), JSON.stringify(manifest, null, 2) + '\n');
        writeFileSync(join(testModuleDir, 'probe.sh'), probeScript, { mode: 0o755 });

        // Root .env — overrides one manifest var, adds its own
        writeEnvFile(testRoot, {
          OVERRIDE_BY_ROOT: 'from-root',
          ONLY_IN_ROOT: 'from-root-only',
          OVERRIDE_BY_MODULE: 'root-default',
          OVERRIDE_BY_SYSTEM: 'root-default',
        });

        // Module .env — overrides root and manifest, adds its own
        writeEnvFile(testModuleDir, {
          OVERRIDE_BY_MODULE: 'from-module',
          ONLY_IN_MODULE: 'from-module-only',
          OVERRIDE_BY_SYSTEM: 'module-default',
        });

        const result = spawnEnvRunner('edge-probe', {
          MCPX_ROOT: testRoot,
          ENV_PROBE_OUTPUT: edgeOutputPath,
          OVERRIDE_BY_SYSTEM: 'from-system',
          ONLY_IN_SYSTEM: 'from-system-only',
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(edgeOutputPath)).toBe(true);

        const envOutput: Record<string, string> = JSON.parse(
          readFileSync(edgeOutputPath, 'utf-8'),
        );

        // Each layer's exclusive variable is present
        expect(envOutput['ONLY_IN_MANIFEST']).toBe('from-manifest');
        expect(envOutput['ONLY_IN_ROOT']).toBe('from-root-only');
        expect(envOutput['ONLY_IN_MODULE']).toBe('from-module-only');
        expect(envOutput['ONLY_IN_SYSTEM']).toBe('from-system-only');

        // Override chain works correctly
        expect(envOutput['OVERRIDE_BY_ROOT']).toBe('from-root');
        expect(envOutput['OVERRIDE_BY_MODULE']).toBe('from-module');
        expect(envOutput['OVERRIDE_BY_SYSTEM']).toBe('from-system');
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
        rmSync(edgeOutputDir, { recursive: true, force: true });
      }
    });

    it('empty .env files do not interfere with other layers', () => {
      const testRoot = mkdtempSync(join(tmpdir(), 'mcpx-env-empty-'));
      const testModulesDir = join(testRoot, 'modules');
      const testModuleDir = join(testModulesDir, 'empty-probe');
      mkdirSync(testModuleDir, { recursive: true });

      const emptyOutputDir = mkdtempSync(join(tmpdir(), 'mcpx-env-empty-out-'));
      const emptyOutputPath = join(emptyOutputDir, 'env-output.json');

      try {
        const manifest = {
          id: 'empty-probe',
          name: 'Empty Env Probe',
          runtime: 'shell',
          entry: 'probe.sh',
          env: {
            FROM_MANIFEST: 'manifest-value',
            SHARED_VAR: 'manifest-shared',
          },
        };
        writeFileSync(join(testModuleDir, 'module.json'), JSON.stringify(manifest, null, 2) + '\n');
        writeFileSync(join(testModuleDir, 'probe.sh'), probeScript, { mode: 0o755 });

        // Empty root .env
        writeFileSync(join(testRoot, '.env'), '\n# Just a comment\n\n', 'utf-8');
        chmodSync(join(testRoot, '.env'), 0o600);

        // Empty module .env
        writeFileSync(join(testModuleDir, '.env'), '# Empty module env\n', 'utf-8');
        chmodSync(join(testModuleDir, '.env'), 0o600);

        const result = spawnEnvRunner('empty-probe', {
          MCPX_ROOT: testRoot,
          ENV_PROBE_OUTPUT: emptyOutputPath,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(emptyOutputPath)).toBe(true);

        const envOutput: Record<string, string> = JSON.parse(
          readFileSync(emptyOutputPath, 'utf-8'),
        );

        // Manifest defaults still apply when .env files are empty
        expect(envOutput['FROM_MANIFEST']).toBe('manifest-value');
        expect(envOutput['SHARED_VAR']).toBe('manifest-shared');
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
        rmSync(emptyOutputDir, { recursive: true, force: true });
      }
    });

    it('quoted values in .env files are parsed correctly across layers', () => {
      const testRoot = mkdtempSync(join(tmpdir(), 'mcpx-env-quoted-'));
      const testModulesDir = join(testRoot, 'modules');
      const testModuleDir = join(testModulesDir, 'quoted-probe');
      mkdirSync(testModuleDir, { recursive: true });

      const quotedOutputDir = mkdtempSync(join(tmpdir(), 'mcpx-env-quoted-out-'));
      const quotedOutputPath = join(quotedOutputDir, 'env-output.json');

      try {
        const manifest = {
          id: 'quoted-probe',
          name: 'Quoted Env Probe',
          runtime: 'shell',
          entry: 'probe.sh',
          env: {
            QUOTED_VAR: 'manifest-fallback',
          },
        };
        writeFileSync(join(testModuleDir, 'module.json'), JSON.stringify(manifest, null, 2) + '\n');
        writeFileSync(join(testModuleDir, 'probe.sh'), probeScript, { mode: 0o755 });

        // Root .env with double-quoted value
        const rootEnvContent = `DOUBLE_QUOTED="root value with spaces"\nSINGLE_QUOTED='root literal $VAR'\n`;
        writeFileSync(join(testRoot, '.env'), rootEnvContent, 'utf-8');
        chmodSync(join(testRoot, '.env'), 0o600);

        // Module .env with quoted values that override root
        const moduleEnvContent = `DOUBLE_QUOTED="module value with spaces"\nMODULE_QUOTED='module literal'\n`;
        writeFileSync(join(testModuleDir, '.env'), moduleEnvContent, 'utf-8');
        chmodSync(join(testModuleDir, '.env'), 0o600);

        const result = spawnEnvRunner('quoted-probe', {
          MCPX_ROOT: testRoot,
          ENV_PROBE_OUTPUT: quotedOutputPath,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(quotedOutputPath)).toBe(true);

        const envOutput: Record<string, string> = JSON.parse(
          readFileSync(quotedOutputPath, 'utf-8'),
        );

        // Module .env double-quoted value wins over root
        expect(envOutput['DOUBLE_QUOTED']).toBe('module value with spaces');
        // Module-only quoted value
        expect(envOutput['MODULE_QUOTED']).toBe('module literal');
        // Root single-quoted value (not overridden by module)
        expect(envOutput['SINGLE_QUOTED']).toBe('root literal $VAR');
        // Manifest fallback still applies
        expect(envOutput['QUOTED_VAR']).toBe('manifest-fallback');
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
        rmSync(quotedOutputDir, { recursive: true, force: true });
      }
    });
  });
});
