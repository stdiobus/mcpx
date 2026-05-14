/**
 * Integration test: Shell runtime real launch.
 *
 * Creates a REAL temp module with a shell entry script, spawns a REAL
 * mcpx process that resolves the module, loads environment variables,
 * and executes the shell script. Verifies args ordering, env layering,
 * and working directory.
 *
 * Requirements validated:
 * - 8.4: Shell runtime executes entry file using /bin/sh
 * - 17.1: Manifest args passed as ordered array
 * - 17.2: CLI args after -- appended after manifest args
 * - 17.4: Argument ordering: manifest args first, then CLI args
 *
 * @module __tests__/integration/run-shell
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tsxEsmNodeArgs } from '../helpers/tsx-node-args.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the integration runner script that performs the full
 * resolve → env-load → exec flow for shell modules.
 */
const SHELL_RUNNER = resolve(__dirname, '../helpers/mcpx-runner.mjs');

/**
 * Path to the dist directory containing compiled mcpx modules.
 */
const DIST_ROOT = resolve(__dirname, '../../../out/dist');

/**
 * Creates a temporary module root with the probe-shell module.
 *
 * Structure:
 *   root/
 *     .env              → ROOT_VAR=root-val
 *     modules/
 *       probe-shell/
 *         module.json   → {id, runtime: "shell", entry: "probe.sh", args: [...]}
 *         .env          → MOD_VAR=mod-val
 *         probe.sh      → writes env, args, cwd, PID to output file
 */
function createShellProbeModule(): {
  root: string;
  moduleDir: string;
  outputPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'mcpx-shell-integ-'));
  const modulesDir = join(root, 'modules');
  const moduleDir = join(modulesDir, 'probe-shell');
  mkdirSync(moduleDir, { recursive: true });

  // Output file path in a separate temp dir
  const outputDir = mkdtempSync(join(tmpdir(), 'mcpx-shell-output-'));
  const outputPath = join(outputDir, 'probe-output.json');

  // Root .env
  writeFileSync(join(root, '.env'), 'ROOT_VAR=root-val\n', 'utf-8');
  chmodSync(join(root, '.env'), 0o600);

  // Module .env
  writeFileSync(join(moduleDir, '.env'), 'MOD_VAR=mod-val\n', 'utf-8');
  chmodSync(join(moduleDir, '.env'), 0o600);

  // module.json
  const manifest = {
    id: 'probe-shell',
    name: 'Shell Probe Module',
    runtime: 'shell',
    entry: 'probe.sh',
    args: ['--flag', 'value'],
  };
  writeFileSync(
    join(moduleDir, 'module.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );

  // probe.sh — writes JSON output with env, args, cwd, PID
  // Uses a heredoc-free approach for portability
  const probeScript = `#!/bin/sh
# Shell probe: dumps env, args, cwd, PID to output file
OUTPUT_FILE="${outputPath}"

# Capture all args as a single string separated by spaces
ARGS_STR="$*"

# Capture specific env vars we care about
ROOT_VAR_VAL="\${ROOT_VAR:-}"
MOD_VAR_VAL="\${MOD_VAR:-}"

# Write JSON output
printf '{\\n' > "$OUTPUT_FILE"
printf '  "pid": %s,\\n' "$$" >> "$OUTPUT_FILE"
printf '  "args": "%s",\\n' "$ARGS_STR" >> "$OUTPUT_FILE"
printf '  "cwd": "%s",\\n' "$(pwd)" >> "$OUTPUT_FILE"
printf '  "root_var": "%s",\\n' "$ROOT_VAR_VAL" >> "$OUTPUT_FILE"
printf '  "mod_var": "%s",\\n' "$MOD_VAR_VAL" >> "$OUTPUT_FILE"
printf '  "env_keys": "%s"\\n' "$(env | cut -d= -f1 | sort | tr '\\n' ',')" >> "$OUTPUT_FILE"
printf '}\\n' >> "$OUTPUT_FILE"
`;

  writeFileSync(join(moduleDir, 'probe.sh'), probeScript, 'utf-8');
  chmodSync(join(moduleDir, 'probe.sh'), 0o755);

  return { root, moduleDir, outputPath };
}

/**
 * Spawns the shell integration runner that performs the full
 * resolve → env-load → exec flow.
 */
function spawnShellRunner(
  args: string[],
  env: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number | null } {
  const runnerScript = resolve(__dirname, '../helpers/shell-integration-runner.mjs');

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
    const result = execFileSync('node', [...tsxEsmNodeArgs(), runnerScript, ...args], {
      env: spawnEnv,
      timeout: 30_000,
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

describe('Integration: Shell runtime real launch', () => {
  let root: string;
  let moduleDir: string;
  let outputPath: string;

  beforeAll(() => {
    const setup = createShellProbeModule();
    root = setup.root;
    moduleDir = setup.moduleDir;
    outputPath = setup.outputPath;
  });

  it('should launch shell module and produce output file', () => {
    const result = spawnShellRunner(
      ['run', 'probe-shell', '--', '--extra', 'arg'],
      { MCPX_ROOT: root },
    );

    // The runner should exit successfully
    expect(result.exitCode).toBe(0);

    // Output file should exist
    expect(existsSync(outputPath)).toBe(true);

    const output = JSON.parse(readFileSync(outputPath, 'utf-8'));

    // Verify PID is a number (process actually ran)
    expect(typeof output.pid).toBe('number');
    expect(output.pid).toBeGreaterThan(0);
  });

  it('should pass args in correct order: manifest first, then CLI', () => {
    const result = spawnShellRunner(
      ['run', 'probe-shell', '--', '--extra', 'arg'],
      { MCPX_ROOT: root },
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(outputPath)).toBe(true);

    const output = JSON.parse(readFileSync(outputPath, 'utf-8'));

    // Args should be: manifest args (--flag value) followed by CLI args (--extra arg)
    // The shell script captures $* which joins all args with spaces
    expect(output.args).toBe('--flag value --extra arg');
  });

  it('should load both ROOT_VAR and MOD_VAR from .env files', () => {
    const result = spawnShellRunner(
      ['run', 'probe-shell', '--', '--extra', 'arg'],
      { MCPX_ROOT: root },
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(outputPath)).toBe(true);

    const output = JSON.parse(readFileSync(outputPath, 'utf-8'));

    // Env should contain both root and module .env values
    expect(output.root_var).toBe('root-val');
    expect(output.mod_var).toBe('mod-val');
  });

  it('should set cwd to the module directory', () => {
    const result = spawnShellRunner(
      ['run', 'probe-shell', '--', '--extra', 'arg'],
      { MCPX_ROOT: root },
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(outputPath)).toBe(true);

    const output = JSON.parse(readFileSync(outputPath, 'utf-8'));

    // Cwd should be the module directory (resolve symlinks for macOS /var → /private/var)
    expect(output.cwd).toBe(realpathSync(moduleDir));
  });
});
