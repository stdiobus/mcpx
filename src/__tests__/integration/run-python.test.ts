/**
 * Integration test: Python runtime real launch.
 *
 * Spawns a REAL mcpx process with a Python probe module that writes
 * environment, arguments, cwd, and PID to an output file. Verifies
 * that the Python runtime plugin correctly selects the interpreter
 * (uv run vs python3 fallback) and passes environment/args/cwd.
 *
 * Tests:
 * - python3 fallback (no pyproject.toml)
 * - uv run path (with pyproject.toml present)
 * - Environment variables loaded from .env
 * - Working directory set to module directory
 *
 * **Validates: Requirements 7.1, 7.2, 7.3**
 *
 * @module __tests__/integration/run-python
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Helpers ---

/**
 * Path to the mcpx-run-module.mjs script that exercises the full pipeline.
 */
const MCPX_RUNNER = resolve(__dirname, '../helpers/mcpx-run-module.mjs');

/**
 * Check if a command is available on the system PATH.
 */
function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const hasPython3 = isCommandAvailable('python3');
const hasUv = isCommandAvailable('uv');

/**
 * Spawns the real mcpx runner and returns stdout, stderr, and exit code.
 */
function spawnMcpxRunner(
  moduleId: string,
  opts: { env?: Record<string, string>; timeout?: number } = {},
): { stdout: string; stderr: string; exitCode: number | null } {
  const { env = {}, timeout = 30_000 } = opts;

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
    const result = execFileSync('node', [MCPX_RUNNER, moduleId], {
      env: spawnEnv,
      timeout,
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
 * The Python probe script that writes JSON output to PROBE_OUTPUT.
 */
const PYTHON_PROBE_SCRIPT = `import os, sys, json
json.dump({
    "pid": os.getpid(),
    "env": dict(os.environ),
    "args": sys.argv,
    "cwd": os.getcwd()
}, open(os.environ["PROBE_OUTPUT"], "w"))
`;

/**
 * Creates a fresh temp root with modules directory and an output file path.
 * Uses realpathSync to resolve symlinks (e.g., /var → /private/var on macOS)
 * so that path comparisons match what Python's os.getcwd() returns.
 */
function setupTempDirs(): { root: string; modulesDir: string; outputFile: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-python-int-')));
  const mDir = join(root, 'modules');
  mkdirSync(mDir, { recursive: true });

  const oDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-python-output-')));
  const outputFile = join(oDir, 'probe-output.json');

  return { root, modulesDir: mDir, outputFile };
}

/**
 * Creates a Python probe module in the given modules directory.
 */
function createPythonProbeModule(
  mDir: string,
  opts: {
    moduleId?: string;
    withPyproject?: boolean;
    moduleEnv?: Record<string, string>;
  } = {},
): string {
  const {
    moduleId = 'probe-python',
    withPyproject = false,
    moduleEnv,
  } = opts;

  const moduleDir = join(mDir, moduleId);
  mkdirSync(moduleDir, { recursive: true });

  // Write module.json
  const manifest = {
    id: moduleId,
    name: 'Python Probe Module',
    runtime: 'python',
    entry: 'probe.py',
  };
  writeFileSync(
    join(moduleDir, 'module.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );

  // Write probe.py
  writeFileSync(join(moduleDir, 'probe.py'), PYTHON_PROBE_SCRIPT, 'utf-8');

  // Write .env if provided
  if (moduleEnv && Object.keys(moduleEnv).length > 0) {
    const envContent = Object.entries(moduleEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const envPath = join(moduleDir, '.env');
    writeFileSync(envPath, envContent + '\n', 'utf-8');
    chmodSync(envPath, 0o600);
  }

  // Write pyproject.toml if requested
  if (withPyproject) {
    const pyprojectContent = `[project]
name = "probe-python"
version = "0.1.0"
requires-python = ">=3.8"
`;
    writeFileSync(join(moduleDir, 'pyproject.toml'), pyprojectContent, 'utf-8');
  }

  return moduleDir;
}

// --- Test Suite ---

const describeIfPython = hasPython3 ? describe : describe.skip;

describeIfPython('Integration: Python runtime real launch', () => {
  beforeAll(() => {
    // Ensure the project is built
    if (!existsSync(resolve(__dirname, '../../../dist/index.js'))) {
      throw new Error(
        'mcpx must be built before running integration tests. Run: npm run build',
      );
    }
  });

  describe('python3 fallback (no pyproject.toml)', () => {
    /**
     * **Validates: Requirement 7.2**
     *
     * When no pyproject.toml exists, mcpx should fall back to python3.
     */
    it('launches Python module with python3 and writes probe output', () => {
      const { root, modulesDir, outputFile } = setupTempDirs();

      try {
        const moduleDir = createPythonProbeModule(modulesDir, {
          withPyproject: false,
          moduleEnv: { PROBE_SECRET: 'python-secret' },
        });

        const result = spawnMcpxRunner('probe-python', {
          env: {
            MCPX_ROOT: root,
            PROBE_OUTPUT: outputFile,
          },
          timeout: 30_000,
        });

        // The process should exit successfully
        expect(result.exitCode).toBe(0);

        // Read the probe output
        expect(existsSync(outputFile)).toBe(true);
        const output = JSON.parse(readFileSync(outputFile, 'utf-8'));

        // Verify PID is a real process ID (not our own)
        expect(output.pid).toBeDefined();
        expect(typeof output.pid).toBe('number');
        expect(output.pid).not.toBe(process.pid);

        // Verify environment variables were passed
        expect(output.env.PROBE_OUTPUT).toBe(outputFile);
        expect(output.env.PROBE_SECRET).toBe('python-secret');

        // Verify working directory is the module directory
        expect(output.cwd).toBe(moduleDir);

        // Verify args — first arg is the script path
        expect(output.args).toBeDefined();
        expect(Array.isArray(output.args)).toBe(true);
        // sys.argv[0] should be the probe.py script path
        expect(output.args[0]).toContain('probe.py');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    /**
     * **Validates: Requirement 7.3**
     *
     * Working directory is set to the module's directory.
     */
    it('sets working directory to module directory', () => {
      const { root, modulesDir, outputFile } = setupTempDirs();

      try {
        const moduleDir = createPythonProbeModule(modulesDir, {
          moduleId: 'probe-cwd-test',
          withPyproject: false,
        });

        const result = spawnMcpxRunner('probe-cwd-test', {
          env: {
            MCPX_ROOT: root,
            PROBE_OUTPUT: outputFile,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(outputFile)).toBe(true);

        const output = JSON.parse(readFileSync(outputFile, 'utf-8'));
        expect(output.cwd).toBe(moduleDir);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('uv run path (with pyproject.toml)', () => {
    const describeIfUv = hasUv ? describe : describe.skip;

    /**
     * **Validates: Requirement 7.1**
     *
     * When pyproject.toml exists and uv is available, mcpx should use `uv run`.
     */
    describeIfUv('when uv is available', () => {
      it('launches Python module with uv run when pyproject.toml present', () => {
        const { root, modulesDir, outputFile } = setupTempDirs();

        try {
          const moduleDir = createPythonProbeModule(modulesDir, {
            moduleId: 'probe-python-uv',
            withPyproject: true,
            moduleEnv: { PROBE_SECRET: 'python-secret' },
          });

          const result = spawnMcpxRunner('probe-python-uv', {
            env: {
              MCPX_ROOT: root,
              PROBE_OUTPUT: outputFile,
            },
            timeout: 30_000,
          });

          // The process should exit successfully
          expect(result.exitCode).toBe(0);

          // Read the probe output
          expect(existsSync(outputFile)).toBe(true);
          const output = JSON.parse(readFileSync(outputFile, 'utf-8'));

          // Verify PID is a real process ID
          expect(output.pid).toBeDefined();
          expect(typeof output.pid).toBe('number');
          expect(output.pid).not.toBe(process.pid);

          // Verify environment variables were passed
          expect(output.env.PROBE_OUTPUT).toBe(outputFile);
          expect(output.env.PROBE_SECRET).toBe('python-secret');

          // Verify working directory is the module directory
          expect(output.cwd).toBe(moduleDir);

          // Verify args
          expect(output.args).toBeDefined();
          expect(Array.isArray(output.args)).toBe(true);
          expect(output.args[0]).toContain('probe.py');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });

    /**
     * **Validates: Requirement 7.2**
     *
     * When pyproject.toml exists but uv is NOT available, falls back to python3.
     * We simulate this by removing uv from PATH.
     */
    it('falls back to python3 when pyproject.toml exists but uv is not in PATH', () => {
      const { root, modulesDir, outputFile } = setupTempDirs();

      try {
        const moduleDir = createPythonProbeModule(modulesDir, {
          moduleId: 'probe-python-nouv',
          withPyproject: true,
          moduleEnv: { PROBE_SECRET: 'python-secret' },
        });

        // Remove uv from PATH by filtering it out
        const currentPath = process.env.PATH ?? '';
        const filteredPath = currentPath
          .split(':')
          .filter(p => {
            try {
              return !existsSync(join(p, 'uv'));
            } catch {
              return true;
            }
          })
          .join(':');

        const result = spawnMcpxRunner('probe-python-nouv', {
          env: {
            MCPX_ROOT: root,
            PROBE_OUTPUT: outputFile,
            PATH: filteredPath,
          },
          timeout: 30_000,
        });

        // The process should exit successfully (python3 fallback)
        expect(result.exitCode).toBe(0);

        // Read the probe output
        expect(existsSync(outputFile)).toBe(true);
        const output = JSON.parse(readFileSync(outputFile, 'utf-8'));

        // Verify PID is a real process ID
        expect(output.pid).toBeDefined();
        expect(typeof output.pid).toBe('number');
        expect(output.pid).not.toBe(process.pid);

        // Verify environment variables were passed
        expect(output.env.PROBE_OUTPUT).toBe(outputFile);
        expect(output.env.PROBE_SECRET).toBe('python-secret');

        // Verify working directory is the module directory
        expect(output.cwd).toBe(moduleDir);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
