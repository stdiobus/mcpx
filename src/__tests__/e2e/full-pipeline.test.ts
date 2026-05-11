/**
 * End-to-end test: Complete mcpx lifecycle.
 *
 * This test creates a REAL module ecosystem and spawns the REAL compiled
 * mcpx binary to verify the full pipeline works end-to-end:
 *
 * 1. Full run pipeline — JSON-RPC request/response through a Node.js echo server
 * 2. Environment reaches the module — root .env vars propagated correctly
 * 3. Arguments reach the module in correct order — manifest + CLI args
 *
 * Each test creates its own temp directory and cleans up after itself.
 *
 * **Validates: Requirements 4.1, 4.5, 5.6, 17.4, 14.1**
 *
 * @module __tests__/e2e/full-pipeline
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Constants ───────────────────────────────────────────────────────────────

/** Path to the stdio runner that provides full stdio transparency (stdin/stdout passthrough). */
const STDIO_RUNNER = resolve(__dirname, '../helpers/stdio-runner.mjs');

/** Path to the shell integration runner that handles env loading + args + exec. */
const SHELL_RUNNER = resolve(__dirname, '../helpers/shell-integration-runner.mjs');

/** Path to the mcpx-run-module runner that handles the full pipeline for any runtime. */
const MCPX_RUN_MODULE = resolve(__dirname, '../helpers/mcpx-run-module.mjs');

/** Timeout for spawned processes. */
const SPAWN_TIMEOUT = 30_000;

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Creates a temp directory and registers it for cleanup.
 */
function createTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirsToCleanup.push(dir);
  return dir;
}

/**
 * Creates a module root with a modules/ directory and optional root .env.
 */
function createModuleRoot(rootEnv?: Record<string, string>): {
  root: string;
  modulesDir: string;
} {
  const root = createTempDir('mcpx-e2e-');
  const modulesDir = join(root, 'modules');
  mkdirSync(modulesDir, { recursive: true });

  if (rootEnv) {
    const content = Object.entries(rootEnv)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const envPath = join(root, '.env');
    writeFileSync(envPath, content + '\n', 'utf-8');
    chmodSync(envPath, 0o600);
  }

  return { root, modulesDir };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('E2E: Full mcpx lifecycle', () => {
  /**
   * Test 1: Full run pipeline — JSON-RPC through a Node.js echo server.
   *
   * Spawns a real Node.js MCP server stub that reads JSON-RPC from stdin
   * and responds on stdout. Verifies:
   * - Valid JSON-RPC response is returned
   * - No mcpx output mixed into the JSON-RPC stream
   *
   * **Validates: Requirements 4.1, 4.5**
   */
  it('full run pipeline: JSON-RPC request through echo-server produces valid response', () => {
    const { root, modulesDir } = createModuleRoot();

    // Create the echo-server module (nodejs runtime)
    const moduleDir = join(modulesDir, 'echo-server');
    mkdirSync(moduleDir, { recursive: true });

    // module.json
    const manifest = {
      id: 'echo-server',
      name: 'Echo MCP Server',
      runtime: 'nodejs',
      entry: 'server.mjs',
    };
    writeFileSync(
      join(moduleDir, 'module.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf-8',
    );

    // server.mjs — a real MCP server stub that reads JSON-RPC from stdin
    // and responds with a valid JSON-RPC response on stdout
    const serverScript = `
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  try {
    const request = JSON.parse(line);
    // Respond with a valid JSON-RPC response
    const response = {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [
          { name: 'echo', description: 'Echoes input back' }
        ]
      }
    };
    process.stdout.write(JSON.stringify(response) + '\\n');
    // Close after first response for test purposes
    rl.close();
  } catch (err) {
    const errorResponse = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    };
    process.stdout.write(JSON.stringify(errorResponse) + '\\n');
    rl.close();
  }
});

rl.on('close', () => {
  process.exit(0);
});
`;
    writeFileSync(join(moduleDir, 'server.mjs'), serverScript, 'utf-8');

    // Spawn using the stdio runner for full stdin/stdout transparency
    // The stdio runner uses execModule which provides stdio: 'inherit'
    // But for this test we need to pipe stdin/stdout, so we use mcpx-run-module
    // which uses spawnSync with stdio options we can control.
    //
    // Actually, we need a custom approach: spawn the integration runner
    // with piped stdio so we can write JSON-RPC to stdin and read from stdout.
    const jsonRpcRequest = '{"jsonrpc":"2.0","method":"tools/list","id":1}\n';

    const result = spawnSync(
      'node',
      ['--import', 'tsx/esm', MCPX_RUN_MODULE, 'echo-server'],
      {
        input: Buffer.from(jsonRpcRequest, 'utf-8'),
        env: {
          ...process.env,
          MCPX_ROOT: root,
        },
        timeout: SPAWN_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    // Process should exit successfully
    expect(result.status).toBe(0);

    // Parse stdout as JSON-RPC response
    const stdout = result.stdout?.toString('utf-8') ?? '';
    expect(stdout.trim().length).toBeGreaterThan(0);

    // Verify it's valid JSON-RPC
    const response = JSON.parse(stdout.trim());
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
    expect(response.result.tools).toBeDefined();
    expect(Array.isArray(response.result.tools)).toBe(true);

    // Verify no mcpx output mixed into the JSON-RPC stream
    // stdout should contain ONLY the JSON-RPC response (one line)
    const stdoutLines = stdout.trim().split('\n');
    expect(stdoutLines.length).toBe(1);

    // Each line in stdout must be valid JSON (no [mcpx] prefixed lines)
    for (const line of stdoutLines) {
      expect(line).not.toContain('[mcpx]');
      // Verify it parses as JSON
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // stderr may contain [mcpx] diagnostics — that's fine
    const stderr = result.stderr?.toString('utf-8') ?? '';
    // But stdout must be clean
    expect(stdout).not.toContain('[mcpx]');
  }, SPAWN_TIMEOUT + 5000);

  /**
   * Test 2: Environment reaches the module.
   *
   * Creates a root .env with ROOT_API_KEY, spawns a shell module that
   * dumps env to a file, and verifies the key is present with correct value.
   *
   * **Validates: Requirements 5.6, 14.1**
   */
  it('environment reaches the module: ROOT_API_KEY from root .env is available', () => {
    const { root, modulesDir } = createModuleRoot({
      ROOT_API_KEY: 'sk-root-12345',
    });

    // Create the env-dumper module (shell runtime)
    const moduleDir = join(modulesDir, 'env-dumper');
    mkdirSync(moduleDir, { recursive: true });

    // Output file for the env dump
    const outputDir = createTempDir('mcpx-e2e-env-output-');
    const outputPath = join(outputDir, 'env-dump.json');

    // module.json
    const manifest = {
      id: 'env-dumper',
      name: 'Environment Dumper',
      runtime: 'shell',
      entry: 'dump.sh',
    };
    writeFileSync(
      join(moduleDir, 'module.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf-8',
    );

    // dump.sh — dumps all env vars to a JSON file using node
    const dumpScript = `#!/bin/sh
node -e "
const fs = require('fs');
const output = JSON.stringify(process.env, null, 2);
fs.writeFileSync('${outputPath.replace(/'/g, "\\'")}', output);
"
`;
    writeFileSync(join(moduleDir, 'dump.sh'), dumpScript, 'utf-8');
    chmodSync(join(moduleDir, 'dump.sh'), 0o755);

    // Spawn using the shell integration runner
    const result = spawnSync(
      'node',
      ['--import', 'tsx/esm', SHELL_RUNNER, 'run', 'env-dumper'],
      {
        env: {
          ...process.env,
          MCPX_ROOT: root,
        },
        timeout: SPAWN_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    // Process should exit successfully
    expect(result.status).toBe(0);

    // Read the output file
    expect(existsSync(outputPath)).toBe(true);
    const envOutput: Record<string, string> = JSON.parse(
      readFileSync(outputPath, 'utf-8'),
    );

    // Verify ROOT_API_KEY is present with correct value
    expect(envOutput['ROOT_API_KEY']).toBe('sk-root-12345');
  }, SPAWN_TIMEOUT + 5000);

  /**
   * Test 3: Arguments reach the module in correct order.
   *
   * Module manifest has args: ["--mode", "production"].
   * Spawns with extra args: run arg-printer -- --override true
   * Verifies output: args are ["--mode", "production", "--override", "true"]
   *
   * **Validates: Requirements 17.4, 14.1**
   */
  it('arguments reach the module in correct order: manifest args then CLI args', () => {
    const { root, modulesDir } = createModuleRoot();

    // Create the arg-printer module (shell runtime, since python may not be available)
    // Using shell to avoid python dependency issues in CI
    const moduleDir = join(modulesDir, 'arg-printer');
    mkdirSync(moduleDir, { recursive: true });

    // Output file for the args dump
    const outputDir = createTempDir('mcpx-e2e-args-output-');
    const outputPath = join(outputDir, 'args-dump.json');

    // module.json with manifest args
    const manifest = {
      id: 'arg-printer',
      name: 'Argument Printer',
      runtime: 'shell',
      entry: 'print-args.sh',
      args: ['--mode', 'production'],
    };
    writeFileSync(
      join(moduleDir, 'module.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf-8',
    );

    // print-args.sh — writes received args as JSON array to output file
    // Uses node to produce proper JSON from shell args
    const printArgsScript = `#!/bin/sh
# Collect all arguments into a JSON array using node
node -e "
const fs = require('fs');
const args = process.argv.slice(1);
fs.writeFileSync('${outputPath.replace(/'/g, "\\'")}', JSON.stringify(args, null, 2));
" -- "$@"
`;
    writeFileSync(join(moduleDir, 'print-args.sh'), printArgsScript, 'utf-8');
    chmodSync(join(moduleDir, 'print-args.sh'), 0o755);

    // Spawn with extra args after --
    const result = spawnSync(
      'node',
      ['--import', 'tsx/esm', SHELL_RUNNER, 'run', 'arg-printer', '--', '--override', 'true'],
      {
        env: {
          ...process.env,
          MCPX_ROOT: root,
        },
        timeout: SPAWN_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    // Process should exit successfully
    expect(result.status).toBe(0);

    // Read the output file
    expect(existsSync(outputPath)).toBe(true);
    const argsOutput: string[] = JSON.parse(
      readFileSync(outputPath, 'utf-8'),
    );

    // Verify args are in correct order: manifest args first, then CLI args
    expect(argsOutput).toEqual(['--mode', 'production', '--override', 'true']);
  }, SPAWN_TIMEOUT + 5000);
});
