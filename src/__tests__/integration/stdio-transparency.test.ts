/**
 * Integration test: Byte-for-byte stdio transparency verification.
 *
 * Creates a shell module that acts as `cat` (reads stdin → writes to stdout unchanged),
 * then spawns the REAL mcpx binary with various payloads and verifies that output
 * matches input exactly — no extra bytes, no corruption, no stdout leakage from mcpx.
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.7**
 *
 * @module __tests__/integration/stdio-transparency
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the stdio-runner.mjs script that exercises the real mcpx exec path.
 * This runner resolves a module, validates its manifest, and calls execModule()
 * which spawns the module with stdio: 'inherit' — providing full stdio transparency.
 */
const STDIO_RUNNER = resolve(__dirname, '../helpers/stdio-runner.mjs');

/**
 * Temp root directory for the test module ecosystem.
 */
let testRoot: string;
let modulesDir: string;

beforeAll(() => {
  // Create a real temp module root with a cat-like shell module
  testRoot = mkdtempSync(join(tmpdir(), 'mcpx-stdio-test-'));
  modulesDir = join(testRoot, 'modules');
  mkdirSync(modulesDir, { recursive: true });

  // Create the "stdio-cat" shell module
  const catModuleDir = join(modulesDir, 'stdio-cat');
  mkdirSync(catModuleDir, { recursive: true });

  // module.json manifest
  const manifest = {
    id: 'stdio-cat',
    name: 'Stdio Cat Module',
    runtime: 'shell',
    entry: 'cat.sh',
  };
  writeFileSync(join(catModuleDir, 'module.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  // cat.sh — reads stdin and writes to stdout unchanged
  const catScript = `#!/bin/sh
cat
`;
  writeFileSync(join(catModuleDir, 'cat.sh'), catScript, 'utf-8');
  chmodSync(join(catModuleDir, 'cat.sh'), 0o755);
});

afterAll(() => {
  if (testRoot) {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

/**
 * Spawns the real mcpx binary with the given stdin payload and returns
 * raw stdout/stderr buffers and exit code.
 */
function spawnMcpxWithPayload(payload: Buffer): {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
} {
  const result = spawnSync('node', [STDIO_RUNNER, 'stdio-cat'], {
    input: payload,
    env: {
      ...process.env,
      MCPX_ROOT: testRoot,
    },
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });

  return {
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    exitCode: result.status,
  };
}

describe('Stdio Transparency — Byte-for-byte verification', () => {
  it('passes empty payload (0 bytes) through unchanged', () => {
    const input = Buffer.alloc(0);
    const { stdout, stderr, exitCode } = spawnMcpxWithPayload(input);

    expect(exitCode).toBe(0);
    expect(stdout.length).toBe(input.length);
    expect(Buffer.compare(input, stdout)).toBe(0);
  });

  it('passes single byte through unchanged', () => {
    const input = Buffer.from([0x42]);
    const { stdout, stderr, exitCode } = spawnMcpxWithPayload(input);

    expect(exitCode).toBe(0);
    expect(stdout.length).toBe(input.length);
    expect(Buffer.compare(input, stdout)).toBe(0);
  });

  it('passes 1KB of random data through unchanged', () => {
    const input = Buffer.from(randomBytes(1024));
    const { stdout, stderr, exitCode } = spawnMcpxWithPayload(input);

    expect(exitCode).toBe(0);
    expect(stdout.length).toBe(input.length);
    expect(Buffer.compare(input, stdout)).toBe(0);
  });

  it('passes 64KB of random data through unchanged', () => {
    const input = Buffer.from(randomBytes(64 * 1024));
    const { stdout, stderr, exitCode } = spawnMcpxWithPayload(input);

    expect(exitCode).toBe(0);
    expect(stdout.length).toBe(input.length);
    expect(Buffer.compare(input, stdout)).toBe(0);
  });

  it('passes JSON-RPC message through unchanged', () => {
    const input = Buffer.from('{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}\n', 'utf-8');
    const { stdout, stderr, exitCode } = spawnMcpxWithPayload(input);

    expect(exitCode).toBe(0);
    expect(stdout.length).toBe(input.length);
    expect(Buffer.compare(input, stdout)).toBe(0);
  });

  it('passes binary with null bytes through unchanged', () => {
    const input = Buffer.from([0x00, 0x01, 0xFF, 0x00, 0x7F]);
    const { stdout, stderr, exitCode } = spawnMcpxWithPayload(input);

    expect(exitCode).toBe(0);
    expect(stdout.length).toBe(input.length);
    expect(Buffer.compare(input, stdout)).toBe(0);
  });

  it('stderr does not leak to stdout — stderr may have [mcpx] logs but stdout is clean', () => {
    // Use a known payload and verify stdout contains ONLY that payload
    const input = Buffer.from('MARKER_PAYLOAD_12345\n', 'utf-8');
    const { stdout, stderr, exitCode } = spawnMcpxWithPayload(input);

    expect(exitCode).toBe(0);

    // stdout must be exactly the input — no extra bytes from mcpx
    expect(stdout.length).toBe(input.length);
    expect(Buffer.compare(input, stdout)).toBe(0);

    // stdout must NOT contain any [mcpx] diagnostic prefix
    const stdoutStr = stdout.toString('utf-8');
    expect(stdoutStr).not.toContain('[mcpx]');

    // stderr MAY contain [mcpx] logs (that's fine — diagnostics go to stderr)
    // We just verify it doesn't appear in stdout
  });

  it('verifies no extra bytes in output for all payload sizes', () => {
    // Test a range of sizes to ensure no off-by-one or buffering issues
    const sizes = [0, 1, 2, 127, 128, 255, 256, 512, 1023, 1024, 4096];

    for (const size of sizes) {
      const input = size === 0 ? Buffer.alloc(0) : Buffer.from(randomBytes(size));
      const { stdout, exitCode } = spawnMcpxWithPayload(input);

      expect(exitCode).toBe(0);
      expect(stdout.length).toBe(input.length);
      expect(Buffer.compare(input, stdout)).toBe(0);
    }
  });
});
