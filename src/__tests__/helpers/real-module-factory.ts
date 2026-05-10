/**
 * Shared test helpers for property-based and integration tests.
 *
 * These helpers create REAL filesystem structures and spawn REAL mcpx processes.
 * No mocking — all operations use actual temp directories, real files, and real child processes.
 *
 * @module __tests__/helpers/real-module-factory
 */

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import type { ModuleManifest } from '../../core/manifest.js';

/**
 * Configuration for creating a real module root directory.
 */
export interface ModuleRootConfig {
  /** Environment variables to write to the root .env file. */
  rootEnv?: Record<string, string>;
  /** Whether to create the modules/ subdirectory (default: true). */
  createModulesDir?: boolean;
}

/**
 * Result of creating a real module root.
 */
export interface ModuleRootResult {
  /** Absolute path to the created temp root directory. */
  root: string;
  /** Absolute path to the modules/ subdirectory. */
  modulesDir: string;
}

/**
 * Creates a real temporary directory structure mimicking a Module_Root.
 *
 * Creates:
 * - A temp directory as the root
 * - A `modules/` subdirectory (unless disabled)
 * - A root `.env` file (if rootEnv is provided)
 *
 * @param config - Configuration for the module root
 * @returns Paths to the created root and modules directory
 *
 * @example
 * ```typescript
 * const { root, modulesDir } = createRealModuleRoot({
 *   rootEnv: { API_KEY: 'root-secret' },
 * });
 * ```
 */
export function createRealModuleRoot(config: ModuleRootConfig = {}): ModuleRootResult {
  const { rootEnv, createModulesDir = true } = config;

  const root = mkdtempSync(join(tmpdir(), 'mcpx-test-'));
  const modulesDir = join(root, 'modules');

  if (createModulesDir) {
    mkdirSync(modulesDir, { recursive: true });
  }

  if (rootEnv && Object.keys(rootEnv).length > 0) {
    const envContent = Object.entries(rootEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const envPath = join(root, '.env');
    writeFileSync(envPath, envContent + '\n', 'utf-8');
    chmodSync(envPath, 0o600);
  }

  return { root, modulesDir };
}

/**
 * Configuration for creating a real module within a module root.
 */
export interface CreateModuleConfig {
  /** The module manifest to write as module.json. */
  manifest: ModuleManifest;
  /** Content for the entry file (if provided, creates the file). */
  entryContent?: string;
  /** Environment variables to write to the module's .env file. */
  moduleEnv?: Record<string, string>;
  /** Additional files to create in the module directory (path relative to module dir → content). */
  extraFiles?: Record<string, string>;
}

/**
 * Result of creating a real module.
 */
export interface CreateModuleResult {
  /** Absolute path to the module directory. */
  moduleDir: string;
  /** Absolute path to the module.json file. */
  manifestPath: string;
  /** Absolute path to the entry file (if created). */
  entryPath?: string;
}

/**
 * Creates a real module directory with manifest, entry file, and optional .env.
 *
 * @param modulesDir - The modules/ directory to create the module in
 * @param config - Configuration for the module
 * @returns Paths to the created module directory and files
 *
 * @example
 * ```typescript
 * const { moduleDir } = createRealModule(modulesDir, {
 *   manifest: { id: 'test-mod', name: 'Test', runtime: 'nodejs', entry: 'index.ts' },
 *   entryContent: 'console.log("hello");',
 *   moduleEnv: { SECRET: 'module-secret' },
 * });
 * ```
 */
export function createRealModule(modulesDir: string, config: CreateModuleConfig): CreateModuleResult {
  const { manifest, entryContent, moduleEnv, extraFiles } = config;

  const moduleDir = join(modulesDir, manifest.id);
  mkdirSync(moduleDir, { recursive: true });

  // Write module.json
  const manifestPath = join(moduleDir, 'module.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  // Write entry file if content provided
  let entryPath: string | undefined;
  if (entryContent !== undefined) {
    entryPath = join(moduleDir, manifest.entry);
    // Ensure parent directories exist for nested entry paths
    const entryDir = join(moduleDir, manifest.entry, '..');
    mkdirSync(resolve(entryDir), { recursive: true });
    writeFileSync(entryPath, entryContent, 'utf-8');
  }

  // Write module .env if provided
  if (moduleEnv && Object.keys(moduleEnv).length > 0) {
    const envContent = Object.entries(moduleEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const envPath = join(moduleDir, '.env');
    writeFileSync(envPath, envContent + '\n', 'utf-8');
    chmodSync(envPath, 0o600);
  }

  // Write extra files
  if (extraFiles) {
    for (const [relativePath, content] of Object.entries(extraFiles)) {
      const filePath = join(moduleDir, relativePath);
      const fileDir = join(filePath, '..');
      mkdirSync(resolve(fileDir), { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
    }
  }

  return { moduleDir, manifestPath, entryPath };
}

/**
 * Options for spawning the mcpx binary.
 */
export interface SpawnMcpxOptions {
  /** Environment variables to set for the spawned process. */
  env?: Record<string, string>;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Data to write to stdin of the spawned process. */
  stdin?: string | Buffer;
  /** Timeout in milliseconds (default: 30000). */
  timeout?: number;
}

/**
 * Result of spawning the mcpx binary.
 */
export interface SpawnMcpxResult {
  /** Stdout output as a string. */
  stdout: string;
  /** Stderr output as a string. */
  stderr: string;
  /** Process exit code (null if killed by signal). */
  exitCode: number | null;
}

/**
 * Spawns the REAL compiled mcpx binary as a child process.
 *
 * Uses the bin/mcpx shim at the package root, which invokes `node dist/index.js`.
 * The binary must be built (`npm run build`) before calling this.
 *
 * @param args - Command-line arguments to pass to mcpx
 * @param opts - Spawn options (env, cwd, stdin, timeout)
 * @returns The stdout, stderr, and exit code of the process
 *
 * @example
 * ```typescript
 * const result = spawnMcpx(['run', 'my-module'], {
 *   env: { MCPX_ROOT: '/tmp/test-root' },
 *   timeout: 15000,
 * });
 * expect(result.exitCode).toBe(0);
 * ```
 */
export function spawnMcpx(args: string[], opts: SpawnMcpxOptions = {}): SpawnMcpxResult {
  const { env, cwd, stdin, timeout = 30_000 } = opts;

  const mcpxBin = resolve(__dirname, '../../../bin/mcpx');

  // Merge environment: inherit current process env, overlay with provided env
  const spawnEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...env,
  };

  // Remove undefined values
  for (const key of Object.keys(spawnEnv)) {
    if (spawnEnv[key] === undefined) {
      delete spawnEnv[key];
    }
  }

  let result: SpawnSyncReturns<Buffer>;
  try {
    result = execFileSync('node', [mcpxBin, ...args], {
      env: spawnEnv,
      cwd: cwd || process.cwd(),
      input: stdin,
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }) as unknown as SpawnSyncReturns<Buffer>;

    // execFileSync returns stdout directly on success
    return {
      stdout: (result as unknown as Buffer).toString('utf-8'),
      stderr: '',
      exitCode: 0,
    };
  } catch (error: unknown) {
    // execFileSync throws on non-zero exit code
    const spawnError = error as {
      stdout?: Buffer;
      stderr?: Buffer;
      status?: number | null;
      signal?: string | null;
    };
    return {
      stdout: spawnError.stdout?.toString('utf-8') ?? '',
      stderr: spawnError.stderr?.toString('utf-8') ?? '',
      exitCode: spawnError.status ?? null,
    };
  }
}

/**
 * Runtime type for probe modules.
 */
export type ProbeRuntime = 'nodejs' | 'python' | 'shell';

/**
 * Result of creating a probe module.
 */
export interface ProbeModuleResult {
  /** The module manifest used. */
  manifest: ModuleManifest;
  /** Absolute path to the module directory. */
  moduleDir: string;
  /** Absolute path to the output file where the probe writes its data. */
  outputPath: string;
}

/**
 * Creates a "probe" module that dumps environment, arguments, cwd, and PID
 * to an output file when executed.
 *
 * The probe writes a JSON file containing:
 * - `pid`: The process ID
 * - `env`: All environment variables (process.env or os.environ)
 * - `args`: Command-line arguments (process.argv or sys.argv)
 * - `cwd`: Current working directory
 *
 * @param modulesDir - The modules/ directory to create the probe in
 * @param runtime - The runtime to use for the probe ('nodejs', 'python', or 'shell')
 * @returns The manifest, module directory, and output file path
 *
 * @example
 * ```typescript
 * const { manifest, outputPath } = createProbeModule(modulesDir, 'nodejs');
 * spawnMcpx(['run', manifest.id], { env: { MCPX_ROOT: root } });
 * const output = JSON.parse(readFileSync(outputPath, 'utf-8'));
 * expect(output.pid).toBeDefined();
 * ```
 */
export function createProbeModule(modulesDir: string, runtime: ProbeRuntime): ProbeModuleResult {
  const outputPath = join(mkdtempSync(join(tmpdir(), 'mcpx-probe-output-')), 'probe-output.json');

  let entry: string;
  let entryContent: string;

  switch (runtime) {
    case 'nodejs': {
      entry = 'probe.mjs';
      entryContent = `
import { writeFileSync } from 'node:fs';
const output = {
  pid: process.pid,
  env: { ...process.env },
  args: process.argv.slice(2),
  cwd: process.cwd(),
};
writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(output, null, 2));
`;
      break;
    }
    case 'python': {
      entry = 'probe.py';
      entryContent = `
import os, sys, json
output = {
    "pid": os.getpid(),
    "env": dict(os.environ),
    "args": sys.argv[1:],
    "cwd": os.getcwd(),
}
with open(${JSON.stringify(outputPath)}, "w") as f:
    json.dump(output, f, indent=2)
`;
      break;
    }
    case 'shell': {
      entry = 'probe.sh';
      entryContent = `#!/bin/sh
# Write probe output as JSON
OUTPUT_FILE=${JSON.stringify(outputPath)}
cat > "$OUTPUT_FILE" << PROBE_EOF
{
  "pid": $$,
  "args": "$(echo "$@")",
  "cwd": "$(pwd)",
  "env_keys": "$(env | cut -d= -f1 | tr '\\n' ',')"
}
PROBE_EOF
`;
      break;
    }
  }

  const manifest: ModuleManifest = {
    id: `probe-${runtime}`,
    name: `Probe Module (${runtime})`,
    runtime,
    entry,
  };

  const { moduleDir } = createRealModule(modulesDir, {
    manifest,
    entryContent,
  });

  return { manifest, moduleDir, outputPath };
}
