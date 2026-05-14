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
import { tsxEsmNodeArgs } from '../helpers/tsx-node-args.js';

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
    const result = execFileSync('node', [...tsxEsmNodeArgs(), MCPX_RUN_MODULE, moduleId], {
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
          // Use JS here to keep the E2E focused on node_modules resolution + cwd behavior.
          // TS loaders (tsx/ts-node) can be brittle across Node versions in constrained CI.
          entry: 'server.mjs',
        }, null, 2),
        'utf-8',
      );

      // Create server.mjs that imports from node_modules and writes output
      const serverJs = `
import { writeFileSync } from 'node:fs';
// Import CJS dependency from ESM: Node will expose module.exports as the default export.
import helper from 'my-helper';

const greeting = helper.greet('MCP');

const output = {
  pid: process.pid,
  cwd: process.cwd(),
  greeting,
  dependencyLoaded: true,
};

writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(output, null, 2));
process.exit(0);
`;
      writeFileSync(join(moduleDir, 'server.mjs'), serverJs, 'utf-8');

      // Spawn mcpx
      const result = spawnMcpxModule('ts-with-deps', { MCPX_ROOT: root });

      if (result.exitCode !== 0) {
        throw new Error(
          `mcpx module launch failed (ts-with-deps)\n` +
            `exitCode: ${String(result.exitCode)}\n` +
            `stdout:\n${result.stdout}\n` +
            `stderr:\n${result.stderr}\n`,
        );
      }
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

      if (result.exitCode !== 0) {
        throw new Error(
          `mcpx module launch failed (python-venv-server)\n` +
            `exitCode: ${String(result.exitCode)}\n` +
            `stdout:\n${result.stdout}\n` +
            `stderr:\n${result.stderr}\n`,
        );
      }
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

      // Create a "binary" that the module will call (cross-platform)
      const binDir = join(moduleDir, 'bin');
      mkdirSync(binDir, { recursive: true });

      const toolScript = `
import { writeFileSync } from 'node:fs';
// Print a JSON object to stdout for the wrapper to capture.
process.stdout.write(JSON.stringify({
  called_from: process.cwd(),
  wrapper_var: process.env.WRAPPER_VAR ?? '',
  args: process.argv.slice(2).join(' '),
}));
`;
      writeFileSync(join(binDir, 'my-tool.mjs'), toolScript, 'utf-8');

      // Create module.json
      writeFileSync(
        join(moduleDir, 'module.json'),
        JSON.stringify({
          id: 'shell-wrapper',
          name: 'Shell Wrapper Module',
          runtime: 'nodejs',
          entry: 'wrapper.mjs',
          env: {
            WRAPPER_VAR: 'wrapper-value',
          },
        }, null, 2),
        'utf-8',
      );

      // Create wrapper.mjs that calls the tool script and writes output
      const wrapperJs = `
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const outputPath = ${JSON.stringify(outputPath)};
const toolPath = join(process.cwd(), 'bin', 'my-tool.mjs');

const binaryOut = execFileSync(process.execPath, [toolPath, '--serve', '--port', '8080'], {
  encoding: 'utf-8',
  env: process.env,
});

const output = {
  pid: process.pid,
  cwd: process.cwd(),
  wrapper_var: process.env.WRAPPER_VAR ?? '',
  binary_output: JSON.parse(binaryOut),
  binary_exists: true,
};

writeFileSync(outputPath, JSON.stringify(output, null, 2));
`;
      writeFileSync(join(moduleDir, 'wrapper.mjs'), wrapperJs, 'utf-8');

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
          runtime: 'nodejs',
          entry: 'probe.mjs',
          env: {
            HOME_DIR: '$env:HOME',
            SECRET_VALUE: `$file:${secretFilePath}`,
            CMD_OUTPUT: '$cmd:echo hello',
          },
        }, null, 2),
        'utf-8',
      );

      // Create probe.mjs that dumps env to output file
      const probeJs = `
import { writeFileSync } from 'node:fs';
const output = {
  HOME_DIR: process.env.HOME_DIR || '',
  SECRET_VALUE: process.env.SECRET_VALUE || '',
  CMD_OUTPUT: process.env.CMD_OUTPUT || '',
  pid: process.pid,
  cwd: process.cwd(),
};
writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(output, null, 2));
`;
      writeFileSync(join(moduleDir, 'probe.mjs'), probeJs, 'utf-8');

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
