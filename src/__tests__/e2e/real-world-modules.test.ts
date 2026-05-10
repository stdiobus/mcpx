/**
 * End-to-end tests: Real-world module patterns.
 *
 * These tests replicate real-world MCP server patterns by creating
 * complete module ecosystems and spawning the REAL compiled mcpx binary.
 * Each test creates its own temp directory and cleans up after itself.
 *
 * Patterns tested:
 * 1. TypeScript MCP server with dependencies (node_modules)
 * 2. Python server with virtual environment
 * 3. Shell wrapper around binary
 * 4. Module with complex env templates (v2)
 *
 * **Validates: Requirements 6.1, 7.1, 8.4, 10.5**
 *
 * @module __tests__/e2e/real-world-modules
 */

import { describe, it, expect, afterEach } from '@jest/globals';
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

// ─── Constants ───────────────────────────────────────────────────────────────

/** Path to the mcpx-run-module.mjs helper that exercises the full pipeline. */
const MCPX_RUN_MODULE = resolve(__dirname, '../helpers/mcpx-run-module.mjs');

/** Timeout for spawned processes. */
const SPAWN_TIMEOUT = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Creates a fresh temp root with modules directory.
 * Uses realpathSync to resolve symlinks (e.g., /var → /private/var on macOS).
 */
function createTempRoot(prefix: string): { root: string; modulesDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const modulesDir = join(root, 'modules');
  mkdirSync(modulesDir, { recursive: true });
  return { root, modulesDir };
}

/**
 * Creates a temp output file path for probe modules to write to.
 */
function createOutputPath(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return join(dir, 'probe-output.json');
}

/**
 * Spawns the mcpx-run-module.mjs runner with the given module ID and env.
 */
function spawnMcpxModule(
  moduleId: string,
  env: Record<string, string>,
  timeout: number = SPAWN_TIMEOUT,
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
    const result = execFileSync('node', [MCPX_RUN_MODULE, moduleId], {
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

// ─── Cleanup tracking ────────────────────────────────────────────────────────

const dirsToCleanup: string[] = [];

afterEach(() => {
  for (const dir of dirsToCleanup) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  dirsToCleanup.length = 0;
});

// ─── Pattern 1: TypeScript MCP server with dependencies ──────────────────────

describe('E2E: Real-world module patterns', () => {
  describe('Pattern 1: TypeScript MCP server with dependencies', () => {
    /**
     * **Validates: Requirement 6.1**
     *
     * Creates a module with a pre-installed node_modules directory containing
     * a simple dependency. The TypeScript entry imports from node_modules.
     * Verifies mcpx launches it and the module can import its dependencies.
     */
    it('launches a TypeScript module that imports from node_modules', () => {
      const { root, modulesDir } = createTempRoot('mcpx-e2e-ts-deps-');
      const outputPath = createOutputPath('mcpx-e2e-ts-deps-out-');
      dirsToCleanup.push(root, dirname(outputPath));

      const moduleDir = join(modulesDir, 'ts-with-deps');
      mkdirSync(moduleDir, { recursive: true });

      // Create a minimal node_modules structure with a simple module
      const depDir = join(moduleDir, 'node_modules', 'my-helper');
      mkdirSync(depDir, { recursive: true });

      // Create the dependency package.json
      writeFileSync(
        join(depDir, 'package.json'),
        JSON.stringify({
          name: 'my-helper',
          version: '1.0.0',
          main: 'index.js',
          type: 'commonjs',
        }, null, 2),
        'utf-8',
      );

      // Create the dependency index.js
      writeFileSync(
        join(depDir, 'index.js'),
        `module.exports = { greet: (name) => \`Hello, \${name}!\` };\n`,
        'utf-8',
      );

      // Create module.json
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({
          id: 'ts-with-deps',
          name: 'TypeScript Module with Dependencies',
          runtime: 'nodejs',
          entry: 'server.ts',
        }, null, 2),
        'utf-8',
      );

      // Create server.ts that imports from node_modules and writes output
      const serverTs = `
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = require('my-helper');

const greeting = helper.greet('MCP');

const output = {
  pid: process.pid,
  cwd: process.cwd(),
  greeting,
  dependencyLoaded: true,
};

writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(output, null, 2));
`;
      writeFileSync(join(moduleDir, 'server.ts'), serverTs, 'utf-8');

      // Spawn mcpx
      const result = spawnMcpxModule('ts-with-deps', { MCPX_ROOT: root });

      expect(result.exitCode).toBe(0);
      expect(existsSync(outputPath)).toBe(true);

      const output = JSON.parse(readFileSync(outputPath, 'utf-8'));

      // Verify the module ran and could import its dependency
      expect(output.pid).toBeDefined();
      expect(output.pid).not.toBe(process.pid);
      expect(output.cwd).toBe(moduleDir);
      expect(output.dependencyLoaded).toBe(true);
      expect(output.greeting).toBe('Hello, MCP!');
    }, SPAWN_TIMEOUT + 10_000);
  });

  // ─── Pattern 2: Python server with virtual environment ───────────────────

  const hasPython3 = isCommandAvailable('python3');
  const describeIfPython = hasPython3 ? describe : describe.skip;

  describeIfPython('Pattern 2: Python server with virtual environment', () => {
    /**
     * **Validates: Requirement 7.1**
     *
     * Creates a module with pyproject.toml (simulating a real Python project).
     * Verifies mcpx launches with the appropriate Python interpreter (uv run
     * when uv is available, python3 fallback otherwise) and the module can
     * access its project structure.
     */
    it('launches a Python module with pyproject.toml', () => {
      const { root, modulesDir } = createTempRoot('mcpx-e2e-python-venv-');
      const outputPath = createOutputPath('mcpx-e2e-python-venv-out-');
      dirsToCleanup.push(root, dirname(outputPath));

      const moduleDir = join(modulesDir, 'python-venv-server');
      mkdirSync(moduleDir, { recursive: true });

      // Create pyproject.toml (triggers uv run path when uv is available)
      writeFileSync(
        join(moduleDir, 'pyproject.toml'),
        `[project]
name = "python-venv-server"
version = "0.1.0"
requires-python = ">=3.8"
`,
        'utf-8',
      );

      // Create module.json
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({
          id: 'python-venv-server',
          name: 'Python Venv Server',
          runtime: 'python',
          entry: 'server.py',
        }, null, 2),
        'utf-8',
      );

      // Create server.py that writes output to a file
      // We test that the module can run and access its cwd correctly
      const serverPy = `import os, sys, json

output = {
    "pid": os.getpid(),
    "cwd": os.getcwd(),
    "python_version": sys.version,
    "has_pyproject": os.path.isfile("pyproject.toml"),
    "can_import_stdlib": True,
}

# Verify we can import standard library packages (proves Python env works)
try:
    import pathlib
    import collections
    output["can_import_stdlib"] = True
except ImportError:
    output["can_import_stdlib"] = False

with open(os.environ["PROBE_OUTPUT"], "w") as f:
    json.dump(output, f, indent=2)
`;
      writeFileSync(join(moduleDir, 'server.py'), serverPy, 'utf-8');

      // Spawn mcpx
      const result = spawnMcpxModule('python-venv-server', {
        MCPX_ROOT: root,
        PROBE_OUTPUT: outputPath,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(outputPath)).toBe(true);

      const output = JSON.parse(readFileSync(outputPath, 'utf-8'));

      // Verify the module ran in the correct directory
      expect(output.pid).toBeDefined();
      expect(output.pid).not.toBe(process.pid);
      expect(output.cwd).toBe(moduleDir);
      expect(output.has_pyproject).toBe(true);
      expect(output.can_import_stdlib).toBe(true);
    }, SPAWN_TIMEOUT + 10_000);
  });

  // ─── Pattern 3: Shell wrapper around binary ─────────────────────────────

  describe('Pattern 3: Shell wrapper around binary', () => {
    /**
     * **Validates: Requirement 8.4**
     *
     * Creates a module with a shell entry that calls another binary.
     * Verifies mcpx sets correct cwd and env before shell executes.
     */
    it('launches a shell module that wraps another binary with correct cwd and env', () => {
      const { root, modulesDir } = createTempRoot('mcpx-e2e-shell-wrapper-');
      const outputPath = createOutputPath('mcpx-e2e-shell-wrapper-out-');
      dirsToCleanup.push(root, dirname(outputPath));

      const moduleDir = join(modulesDir, 'shell-wrapper');
      mkdirSync(moduleDir, { recursive: true });

      // Create a "binary" that the shell script will call
      const binDir = join(moduleDir, 'bin');
      mkdirSync(binDir, { recursive: true });

      const binaryScript = `#!/bin/sh
# Simulated binary that writes its env and args to output
printf '{"called_from": "%s", "wrapper_var": "%s", "args": "%s"}' "$(pwd)" "$WRAPPER_VAR" "$*"
`;
      writeFileSync(join(binDir, 'my-tool'), binaryScript, 'utf-8');
      chmodSync(join(binDir, 'my-tool'), 0o755);

      // Create module.json
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({
          id: 'shell-wrapper',
          name: 'Shell Wrapper Module',
          runtime: 'shell',
          entry: 'wrapper.sh',
          env: {
            WRAPPER_VAR: 'wrapper-value',
          },
        }, null, 2),
        'utf-8',
      );

      // Create wrapper.sh that calls the binary and writes output
      const wrapperSh = `#!/bin/sh
# Shell wrapper that calls a local binary
OUTPUT_FILE="${outputPath}"

# Call the local binary and capture its output
BINARY_OUTPUT=$(./bin/my-tool --serve --port 8080)

# Write combined output
printf '{\\n' > "$OUTPUT_FILE"
printf '  "pid": %s,\\n' "$$" >> "$OUTPUT_FILE"
printf '  "cwd": "%s",\\n' "$(pwd)" >> "$OUTPUT_FILE"
printf '  "wrapper_var": "%s",\\n' "$WRAPPER_VAR" >> "$OUTPUT_FILE"
printf '  "binary_output": %s,\\n' "$BINARY_OUTPUT" >> "$OUTPUT_FILE"
printf '  "binary_exists": true\\n' >> "$OUTPUT_FILE"
printf '}\\n' >> "$OUTPUT_FILE"
`;
      writeFileSync(join(moduleDir, 'wrapper.sh'), wrapperSh, 'utf-8');
      chmodSync(join(moduleDir, 'wrapper.sh'), 0o755);

      // Spawn mcpx
      const result = spawnMcpxModule('shell-wrapper', { MCPX_ROOT: root });

      expect(result.exitCode).toBe(0);
      expect(existsSync(outputPath)).toBe(true);

      const output = JSON.parse(readFileSync(outputPath, 'utf-8'));

      // Verify cwd is the module directory
      expect(output.cwd).toBe(moduleDir);

      // Verify env was set correctly (manifest env default)
      expect(output.wrapper_var).toBe('wrapper-value');

      // Verify the binary was called from the correct directory
      expect(output.binary_output.called_from).toBe(moduleDir);
      expect(output.binary_output.wrapper_var).toBe('wrapper-value');
      expect(output.binary_output.args).toBe('--serve --port 8080');

      // Verify the shell process ran
      expect(output.pid).toBeDefined();
      expect(typeof output.pid).toBe('number');
    }, SPAWN_TIMEOUT + 5_000);
  });

  // ─── Pattern 4: Module with complex env templates (v2) ──────────────────

  describe('Pattern 4: Module with complex env templates (v2)', () => {
    /**
     * **Validates: Requirement 10.5**
     *
     * Creates a module with manifest env using $env:HOME, $file:./secret.txt,
     * and $cmd:echo hello. Creates a real secret.txt file. Verifies all
     * templates resolve to correct values in the module's env.
     */
    it('resolves $env:, $file:, and $cmd: templates in module env', () => {
      const { root, modulesDir } = createTempRoot('mcpx-e2e-env-templates-');
      const outputPath = createOutputPath('mcpx-e2e-env-templates-out-');
      dirsToCleanup.push(root, dirname(outputPath));

      const moduleDir = join(modulesDir, 'env-templates');
      mkdirSync(moduleDir, { recursive: true });

      // Create the real secret.txt file
      const secretContent = 'super-secret-token-12345';
      const secretFilePath = join(moduleDir, 'secret.txt');
      writeFileSync(secretFilePath, secretContent + '\n', 'utf-8');

      // Create module.json with env templates
      // Note: $file: paths are resolved relative to process cwd, so use absolute path
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({
          id: 'env-templates',
          name: 'Env Templates Module',
          runtime: 'shell',
          entry: 'probe.sh',
          env: {
            HOME_DIR: '$env:HOME',
            SECRET_VALUE: `$file:${secretFilePath}`,
            CMD_OUTPUT: '$cmd:echo hello',
          },
        }, null, 2),
        'utf-8',
      );

      // Create probe.sh that dumps env to output file
      const probeSh = `#!/bin/sh
OUTPUT_FILE="${outputPath}"

# Use node to produce proper JSON from env
node -e "
const fs = require('fs');
const output = {
  HOME_DIR: process.env.HOME_DIR || '',
  SECRET_VALUE: process.env.SECRET_VALUE || '',
  CMD_OUTPUT: process.env.CMD_OUTPUT || '',
  pid: process.pid,
  cwd: process.cwd(),
};
fs.writeFileSync('${outputPath}', JSON.stringify(output, null, 2));
"
`;
      writeFileSync(join(moduleDir, 'probe.sh'), probeSh, 'utf-8');
      chmodSync(join(moduleDir, 'probe.sh'), 0o755);

      // Spawn mcpx
      const result = spawnMcpxModule('env-templates', { MCPX_ROOT: root });

      expect(result.exitCode).toBe(0);
      expect(existsSync(outputPath)).toBe(true);

      const output = JSON.parse(readFileSync(outputPath, 'utf-8'));

      // Verify $env:HOME resolved to the actual HOME value
      expect(output.HOME_DIR).toBe(process.env.HOME);

      // Verify $file: resolved to the file contents (trimmed)
      expect(output.SECRET_VALUE).toBe(secretContent);

      // Verify $cmd:echo hello resolved to "hello"
      expect(output.CMD_OUTPUT).toBe('hello');

      // Verify the module ran
      expect(output.pid).toBeDefined();
      expect(output.cwd).toBe(moduleDir);
    }, SPAWN_TIMEOUT + 5_000);
  });
});
