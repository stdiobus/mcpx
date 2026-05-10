#!/usr/bin/env node
/**
 * MCP End-to-End Smoke Test
 *
 * Verifies that mcpx can launch a REAL MCP server (built with
 * @modelcontextprotocol/sdk) and that a REAL MCP client can connect
 * to it, perform the protocol handshake, and call tools.
 *
 * This is the ultimate proof that mcpx works: a real MCP client talks
 * to a real MCP server through mcpx, exactly as Kiro/Claude/Cursor would.
 *
 * Run: node scripts/smoke-mcp-e2e.mjs
 *
 * Requirements tested: 4.1, 4.2, 4.3, 4.5, 14.1, 14.4
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');

// --- Helpers ---
function log(msg) { process.stdout.write(`${msg}\n`); }
function pass(msg) { log(`  [PASS] ${msg}`); }

function fail(msg, details) {
  log(`  [FAIL] ${msg}`);
  if (details) log(`  ${JSON.stringify(details, null, 2).slice(0, 2000)}`);
  cleanup();
  process.exit(1);
}

let tempDir = null;

function cleanup() {
  try {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

// --- Setup ---
log('\n=== MCP E2E Smoke Test ===\n');
log('[SETUP] Creating module root with real MCP server...');

tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-mcp-e2e-')));
const moduleRoot = join(tempDir, 'root');
const modulesDir = join(moduleRoot, 'modules');
const echoModuleDir = join(modulesDir, 'echo-server');
mkdirSync(echoModuleDir, { recursive: true });

// Copy the real MCP server fixture into the module directory
copyFileSync(
  join(__dirname, 'fixtures', 'mcp-echo-server.mjs'),
  join(echoModuleDir, 'server.mjs'),
);

// Create module.json — exactly what a real user would write
// Note: env.TEST_SECRET is set to "" as a manifest default, but the .env file
// provides the real value. This verifies that .env takes precedence over manifest defaults.
writeFileSync(
  join(echoModuleDir, 'module.json'),
  JSON.stringify({
    id: 'echo-server',
    name: 'Echo MCP Server',
    runtime: 'nodejs',
    entry: 'server.mjs',
    env: { TEST_SECRET: '' },
  }, null, 2),
);

// Create .env with a secret
const envFile = join(echoModuleDir, '.env');
writeFileSync(envFile, 'TEST_SECRET=e2e-secret-value\n');
chmodSync(envFile, 0o600);

// Symlink node_modules so the server can import @modelcontextprotocol/sdk
// In a real scenario the module would have its own node_modules,
// but for this test we reuse the package's node_modules.
const serverNodeModules = join(echoModuleDir, 'node_modules');
if (!existsSync(serverNodeModules)) {
  const { symlinkSync } = await import('node:fs');
  symlinkSync(join(PACKAGE_ROOT, 'node_modules'), serverNodeModules, 'dir');
}

// Resolve the mcpx binary
const mcpxBin = join(PACKAGE_ROOT, 'bin', 'mcpx');
if (!existsSync(mcpxBin)) {
  fail('bin/mcpx not found — run npm run build first');
}

log('[SETUP] Done.\n');

// --- Test 1: MCP Client connects through mcpx and initializes ---
log('[TEST 1] MCP Client → mcpx → echo-server: initialize handshake');

const transport = new StdioClientTransport({
  command: mcpxBin,
  args: ['run', 'echo-server'],
  env: {
    MCPX_ROOT: moduleRoot,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_PATH: join(PACKAGE_ROOT, 'node_modules'),
  },
  stderr: 'pipe',
});

const client = new Client({
  name: 'smoke-test-client',
  version: '1.0.0',
});

try {
  await client.connect(transport);
} catch (err) {
  fail(`Client failed to connect: ${err.message}`, { error: err.stack });
}

pass('MCP handshake completed (initialize + initialized)');

// --- Test 2: List tools ---
log('[TEST 2] List available tools');

const toolsResult = await client.listTools();
const toolNames = toolsResult.tools.map(t => t.name);

if (!toolNames.includes('echo')) {
  fail(`"echo" tool not found. Got: ${toolNames.join(', ')}`);
}
if (!toolNames.includes('get_env')) {
  fail(`"get_env" tool not found. Got: ${toolNames.join(', ')}`);
}

pass(`Tools discovered: ${toolNames.join(', ')}`);

// --- Test 3: Call echo tool ---
log('[TEST 3] Call "echo" tool with a message');

const echoResult = await client.callTool({
  name: 'echo',
  arguments: { message: 'hello from mcpx smoke test' },
});

const echoText = echoResult.content?.[0]?.text;
if (echoText !== 'hello from mcpx smoke test') {
  fail(`Echo returned wrong value: "${echoText}"`);
}

pass('echo tool returned correct message');

// --- Test 4: Verify env vars loaded through mcpx ---
log('[TEST 4] Call "get_env" tool to verify .env loading');

const envResult = await client.callTool({
  name: 'get_env',
  arguments: { name: 'TEST_SECRET' },
});

const envText = envResult.content?.[0]?.text;
if (envText !== 'e2e-secret-value') {
  fail(`get_env returned wrong value: "${envText}" (expected "e2e-secret-value")`);
}

pass('.env secret loaded correctly through mcpx');

// --- Test 5: Multiple rapid calls (protocol stability) ---
log('[TEST 5] Rapid sequential tool calls (protocol stability)');

for (let i = 0; i < 10; i++) {
  const result = await client.callTool({
    name: 'echo',
    arguments: { message: `msg-${i}` },
  });
  const text = result.content?.[0]?.text;
  if (text !== `msg-${i}`) {
    fail(`Rapid call ${i} failed: got "${text}", expected "msg-${i}"`);
  }
}

pass('10 rapid sequential calls all returned correct results');

// --- Cleanup ---
await client.close();

log('\n=== MCP E2E PASSED ===');
log('  Real MCP client talked to real MCP server through mcpx.');
log('  Protocol handshake, tool discovery, tool calls, and env loading all work.\n');

cleanup();
process.exit(0);
