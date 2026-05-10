/**
 * Property-based tests for environment variable loading precedence.
 *
 * These tests verify the invariants of the env loading precedence chain:
 *   1. System environment (process.env) — never overridden
 *   2. Module-level .env ({moduleDir}/.env)
 *   3. Root-level .env ({rootDir}/.env)
 *   4. Manifest defaults (module.json env field)
 *
 * All tests use REAL filesystem operations and REAL process.env manipulation.
 * No mocking — each iteration creates real temp directories and .env files.
 *
 * **Validates: Requirements 5.3, 5.4, 5.5**
 *
 * @module __tests__/properties/env-precedence-properties
 */

import { describe, it, afterEach } from '@jest/globals';
import * as fc from 'fast-check';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnvironment } from '../../core/env-loader.js';
import { Logger } from '../../core/logger.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Prefix for all test env vars to avoid collisions with real system vars. */
const TEST_PREFIX = 'MCPX_PBT_';

/** Generate a valid env var name with test prefix and random suffix. */
const envVarNameArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,8}$/).map(
  (s) => `${TEST_PREFIX}${s}`
);

/**
 * Generate a safe env var value that survives dotenv round-trip.
 * Must not have leading/trailing whitespace (trimmed by parser for unquoted values),
 * must not be empty, and must not start with quote chars or contain newlines.
 */
const envVarValueArb = fc.stringMatching(/^[A-Za-z0-9_\-.:/][A-Za-z0-9_\-.:/]*$/).filter(
  (s) => s.length >= 1 && s.length <= 50
);

/** Create a fresh temp directory for a test iteration. */
function createTempRoot(): { rootDir: string; moduleDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), 'mcpx-pbt-env-'));
  const moduleDir = join(rootDir, 'modules', 'test-mod');
  mkdirSync(moduleDir, { recursive: true });
  return { rootDir, moduleDir };
}

/** Write a .env file from a record of key-value pairs. */
function writeEnvFile(dir: string, vars: Record<string, string>): void {
  const content = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const envPath = join(dir, '.env');
  writeFileSync(envPath, content + '\n', 'utf-8');
  chmodSync(envPath, 0o600);
}

/** Track env vars set during a test iteration for cleanup. */
const envVarsToClean: string[] = [];

afterEach(() => {
  for (const key of envVarsToClean) {
    delete process.env[key];
  }
  envVarsToClean.length = 0;
});

const logger = new Logger(false);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Environment Loading Precedence Properties', () => {
  /**
   * Property: System env ALWAYS wins over all other sources.
   *
   * For every variable that exists in process.env, the resolved value
   * from loadEnvironment() must equal the system env value, regardless
   * of what module .env, root .env, or manifest defaults specify.
   *
   * **Validates: Requirements 5.4**
   */
  it('system env ALWAYS wins over all other sources', () => {
    fc.assert(
      fc.property(
        fc.array(envVarNameArb, { minLength: 1, maxLength: 5 }),
        envVarValueArb,
        envVarValueArb,
        envVarValueArb,
        envVarValueArb,
        (names, sysVal, modVal, rootVal, manifestVal) => {
          // Deduplicate names
          const uniqueNames = [...new Set(names)];
          if (uniqueNames.length === 0) return;

          const { rootDir, moduleDir } = createTempRoot();

          try {
            // Set up all 4 layers with different values
            const manifestEnv: Record<string, string> = {};
            const rootEnvVars: Record<string, string> = {};
            const moduleEnvVars: Record<string, string> = {};

            for (const name of uniqueNames) {
              // Layer 1: System env (highest precedence)
              process.env[name] = sysVal;
              envVarsToClean.push(name);

              // Layer 2: Module .env
              moduleEnvVars[name] = modVal;

              // Layer 3: Root .env
              rootEnvVars[name] = rootVal;

              // Layer 4: Manifest defaults (lowest precedence)
              manifestEnv[name] = manifestVal;
            }

            writeEnvFile(moduleDir, moduleEnvVars);
            writeEnvFile(rootDir, rootEnvVars);

            // Call REAL loadEnvironment
            const result = loadEnvironment({
              rootDir,
              moduleDir,
              manifestEnv,
              logger,
            });

            // Verify: system env value wins for every variable
            for (const name of uniqueNames) {
              if (result.env[name] !== sysVal) {
                return false;
              }
            }
            return true;
          } finally {
            rmSync(rootDir, { recursive: true, force: true });
            for (const name of uniqueNames) {
              delete process.env[name];
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * Property: Module .env ALWAYS wins over root .env and manifest defaults.
   *
   * When a variable is defined in the module .env file and NOT in system env,
   * the resolved value must equal the module .env value, regardless of what
   * root .env or manifest defaults specify.
   *
   * **Validates: Requirements 5.3**
   */
  it('module .env ALWAYS wins over root .env and manifest defaults', () => {
    fc.assert(
      fc.property(
        fc.array(envVarNameArb, { minLength: 1, maxLength: 5 }),
        envVarValueArb,
        envVarValueArb,
        envVarValueArb,
        (names, modVal, rootVal, manifestVal) => {
          const uniqueNames = [...new Set(names)];
          if (uniqueNames.length === 0) return;

          const { rootDir, moduleDir } = createTempRoot();

          try {
            const manifestEnv: Record<string, string> = {};
            const rootEnvVars: Record<string, string> = {};
            const moduleEnvVars: Record<string, string> = {};

            for (const name of uniqueNames) {
              // Ensure NOT in system env
              delete process.env[name];

              // Layer 2: Module .env (should win)
              moduleEnvVars[name] = modVal;

              // Layer 3: Root .env
              rootEnvVars[name] = rootVal;

              // Layer 4: Manifest defaults
              manifestEnv[name] = manifestVal;
            }

            writeEnvFile(moduleDir, moduleEnvVars);
            writeEnvFile(rootDir, rootEnvVars);

            const result = loadEnvironment({
              rootDir,
              moduleDir,
              manifestEnv,
              logger,
            });

            // Verify: module .env value wins for every variable
            for (const name of uniqueNames) {
              if (result.env[name] !== modVal) {
                return false;
              }
            }
            return true;
          } finally {
            rmSync(rootDir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * Property: Manifest defaults only apply when no other source provides the value.
   *
   * When a variable is defined ONLY in manifest defaults (not in system env,
   * not in module .env, not in root .env), the resolved value must equal
   * the manifest default value.
   *
   * **Validates: Requirements 5.5**
   */
  it('manifest defaults only apply when no other source provides the value', () => {
    fc.assert(
      fc.property(
        fc.array(envVarNameArb, { minLength: 1, maxLength: 5 }),
        envVarValueArb,
        (names, manifestVal) => {
          const uniqueNames = [...new Set(names)];
          if (uniqueNames.length === 0) return;

          const { rootDir, moduleDir } = createTempRoot();

          try {
            const manifestEnv: Record<string, string> = {};

            for (const name of uniqueNames) {
              // Ensure NOT in system env
              delete process.env[name];

              // Only in manifest defaults — no .env files define these
              manifestEnv[name] = manifestVal;
            }

            // No .env files written — only manifest defaults exist

            const result = loadEnvironment({
              rootDir,
              moduleDir,
              manifestEnv,
              logger,
            });

            // Verify: manifest default value is used
            for (const name of uniqueNames) {
              if (result.env[name] !== manifestVal) {
                return false;
              }
            }
            return true;
          } finally {
            rmSync(rootDir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * Property: Never-override invariant — pre-set env vars are never changed by loadEnvironment().
   *
   * If a variable is already set in process.env before calling loadEnvironment(),
   * the value in process.env must remain unchanged after the call returns.
   * loadEnvironment() must never mutate process.env.
   *
   * **Validates: Requirements 5.4**
   */
  it('pre-set env vars are never changed by loadEnvironment()', () => {
    fc.assert(
      fc.property(
        fc.array(envVarNameArb, { minLength: 1, maxLength: 5 }),
        envVarValueArb,
        envVarValueArb,
        envVarValueArb,
        envVarValueArb,
        (names, sysVal, modVal, rootVal, manifestVal) => {
          const uniqueNames = [...new Set(names)];
          if (uniqueNames.length === 0) return;

          const { rootDir, moduleDir } = createTempRoot();

          try {
            const manifestEnv: Record<string, string> = {};
            const rootEnvVars: Record<string, string> = {};
            const moduleEnvVars: Record<string, string> = {};

            for (const name of uniqueNames) {
              // Pre-set in system env
              process.env[name] = sysVal;
              envVarsToClean.push(name);

              // All other layers have different values
              moduleEnvVars[name] = modVal;
              rootEnvVars[name] = rootVal;
              manifestEnv[name] = manifestVal;
            }

            writeEnvFile(moduleDir, moduleEnvVars);
            writeEnvFile(rootDir, rootEnvVars);

            // Call loadEnvironment
            loadEnvironment({
              rootDir,
              moduleDir,
              manifestEnv,
              logger,
            });

            // Verify: process.env values are UNCHANGED
            for (const name of uniqueNames) {
              if (process.env[name] !== sysVal) {
                return false;
              }
            }
            return true;
          } finally {
            rmSync(rootDir, { recursive: true, force: true });
            for (const name of uniqueNames) {
              delete process.env[name];
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
