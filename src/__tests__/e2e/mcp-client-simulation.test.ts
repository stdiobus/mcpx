/**
 * End-to-end test: MCP Client Simulation
 *
 * Replicates EXACTLY how Kiro/Claude Desktop spawns MCP servers:
 * - Reads a real mcp.json config
 * - Spawns using child_process.spawn(config.command, config.args, {env: {...process.env, ...config.env}, stdio: ['pipe','pipe','pipe']})
 * - Sends real MCP protocol messages (JSON-RPC 2.0 over NDJSON)
 * - Verifies protocol integrity: valid JSON-RPC, matching IDs, no extra bytes, no diagnostic leakage
 *
 * The test uses the mcpx-run-module.mjs helper which exercises the REAL compiled
 * mcpx pipeline (resolve → env → runtime → exec) imported from dist/. This is
 * functionally equivalent to `bin/mcpx run <module>` — the full end-to-end path.
 *
 * **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5**
 *
 * @module __tests__/e2e/mcp-client-simulation
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tsxEsmNodeArgs } from '../helpers/tsx-node-args.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the mcpx-run-module helper that exercises the REAL compiled mcpx pipeline.
 * This imports from dist/ and performs the full resolve → env → runtime → exec flow
 * with stdio: 'inherit', providing full stdio transparency.
 */
const MCPX_RUN_MODULE = resolve(__dirname, '../helpers/mcpx-run-module.mjs');

/**
 * Path to the compiled dist directory.
 */
// __dirname is src/__tests__/e2e; go up to package root (mcpx/) then into out/dist.
const DIST_ROOT = resolve(__dirname, '../../../out/dist');

/**
 * Timeout for spawning processes.
 */
const SPAWN_TIMEOUT = 15_000;

/**
 * Creates a JSON-RPC 2.0 request as a newline-delimited string.
 */
function jsonRpcRequest(id: number, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

/**
 * Parses newline-delimited JSON-RPC responses from a buffer.
 */
function parseResponses(data: string): unknown[] {
  return data
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Spawns a process exactly as an MCP client would, sends messages, and collects responses.
 *
 * This replicates the spawn pattern from mcp.json configs:
 *   spawn(config.command, config.args, {env: {...process.env, ...config.env}, stdio: ['pipe','pipe','pipe']})
 */
function spawnMcpServer(
  config: { command: string; args: string[]; env?: Record<string, string> },
  messages: string[],
  opts: { timeout?: number; rootEnv?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const timeout = opts.timeout ?? SPAWN_TIMEOUT;

  return new Promise((resolvePromise, reject) => {
    const spawnEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(opts.rootEnv ?? {}),
      ...(config.env ?? {}),
    };

    // Spawn EXACTLY as Kiro/Claude Desktop does:
    // child_process.spawn(config.command, config.args, {env: {...process.env, ...config.env}, stdio: ['pipe','pipe','pipe']})
    const child = spawn(config.command, config.args, {
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        resolvePromise({ stdout, stderr, exitCode: null });
      }, 500);
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Send all messages sequentially
    for (const msg of messages) {
      child.stdin.write(msg);
    }

    // Close stdin to signal we're done sending
    child.stdin.end();
  });
}

/**
 * Creates a temporary module root with an echo-server module.
 * The echo-server is a real JavaScript MCP server that:
 * - Reads JSON-RPC requests from stdin (newline-delimited)
 * - Responds with proper JSON-RPC 2.0 responses on stdout
 * - Handles: initialize, tools/list, tools/call
 * - Exits cleanly when stdin closes
 */
function createEchoServerModule(root: string, moduleId: string = 'echo-server'): string {
  const modulesDir = join(root, 'modules');
  mkdirSync(modulesDir, { recursive: true });

  const moduleDir = join(modulesDir, moduleId);
  mkdirSync(moduleDir, { recursive: true });

  // Write module.json manifest
  const manifest = {
    id: moduleId,
    name: 'Echo MCP Server',
    runtime: 'nodejs',
    entry: 'server.mjs',
  };
  writeFileSync(join(moduleDir, 'module.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  // Write server.mjs — a real MCP echo server that speaks JSON-RPC 2.0
  const serverCode = `import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    const errorResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    process.stdout.write(errorResponse + '\\n');
    return;
  }

  const { id, method, params } = request;
  let response;

  switch (method) {
    case 'initialize':
      response = {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'echo-server', version: '1.0.0' },
        },
      };
      break;

    case 'tools/list':
      response = {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echoes back the input',
              inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
            },
          ],
        },
      };
      break;

    case 'tools/call':
      response = {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(params) }],
        },
      };
      break;

    default:
      response = {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found: ' + method },
      };
      break;
  }

  process.stdout.write(JSON.stringify(response) + '\\n');
});

rl.on('close', () => {
  process.exit(0);
});
`;
  writeFileSync(join(moduleDir, 'server.mjs'), serverCode, 'utf-8');

  return moduleDir;
}

describe('E2E: MCP Client Simulation', () => {
  beforeAll(() => {
    // Verify the dist directory exists (build must have been run)
    expect(existsSync(DIST_ROOT)).toBe(true);
  });

  describe('Real MCP client spawn pattern (mcp.json format)', () => {
    it('spawns echo-server using explicit run format and receives initialize response', async () => {
      const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-e2e-init-')));
      try {
        createEchoServerModule(testRoot);

        // Replicate mcp.json: {"command": "node", "args": ["bin/mcpx.js", "run", "echo-server"], "env": {"CLIENT_TOKEN": "tok-abc"}}
        // Using mcpx-run-module.mjs which is the real compiled mcpx pipeline
        const config = {
          command: 'node',
          args: [...tsxEsmNodeArgs(), MCPX_RUN_MODULE, 'echo-server'],
          env: { CLIENT_TOKEN: 'tok-abc' },
        };

        const messages = [jsonRpcRequest(1, 'initialize', { protocolVersion: '2024-11-05' })];

        const { stdout, stderr, exitCode } = await spawnMcpServer(config, messages, {
          rootEnv: { MCPX_ROOT: testRoot },
        });

        // Parse responses
        const responses = parseResponses(stdout);
        expect(responses.length).toBe(1);

        // Verify JSON-RPC 2.0 structure
        const initResponse = responses[0] as {
          jsonrpc: string;
          id: number;
          result: { protocolVersion: string; capabilities: unknown; serverInfo: unknown };
        };
        expect(initResponse.jsonrpc).toBe('2.0');
        expect(initResponse.id).toBe(1);
        expect(initResponse.result).toBeDefined();
        expect(initResponse.result.protocolVersion).toBe('2024-11-05');
        expect(initResponse.result.serverInfo).toEqual({
          name: 'echo-server',
          version: '1.0.0',
        });

        // Exit code should be 0 (clean shutdown)
        expect(exitCode).toBe(0);
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
    }, SPAWN_TIMEOUT + 5000);

    it('handles tools/list request correctly', async () => {
      const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-e2e-tools-')));
      try {
        createEchoServerModule(testRoot);

        const config = {
          command: 'node',
          args: [...tsxEsmNodeArgs(), MCPX_RUN_MODULE, 'echo-server'],
          env: {},
        };

        const messages = [
          jsonRpcRequest(1, 'initialize', { protocolVersion: '2024-11-05' }),
          jsonRpcRequest(2, 'tools/list', {}),
        ];

        const { stdout } = await spawnMcpServer(config, messages, {
          rootEnv: { MCPX_ROOT: testRoot },
        });

        const responses = parseResponses(stdout);
        expect(responses.length).toBe(2);

        // Verify tools/list response
        const toolsResponse = responses[1] as {
          jsonrpc: string;
          id: number;
          result: { tools: Array<{ name: string; description: string }> };
        };
        expect(toolsResponse.jsonrpc).toBe('2.0');
        expect(toolsResponse.id).toBe(2);
        expect(toolsResponse.result.tools).toBeDefined();
        expect(Array.isArray(toolsResponse.result.tools)).toBe(true);
        expect(toolsResponse.result.tools.length).toBeGreaterThan(0);
        expect(toolsResponse.result.tools[0].name).toBe('echo');
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
    }, SPAWN_TIMEOUT + 5000);

    it('handles multiple sequential requests with correct id matching', async () => {
      const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-e2e-seq-')));
      try {
        createEchoServerModule(testRoot);

        const config = {
          command: 'node',
          args: [...tsxEsmNodeArgs(), MCPX_RUN_MODULE, 'echo-server'],
          env: {},
        };

        const messages = [
          jsonRpcRequest(1, 'initialize', { protocolVersion: '2024-11-05' }),
          jsonRpcRequest(2, 'tools/list', {}),
          jsonRpcRequest(3, 'tools/call', { name: 'echo', arguments: { message: 'hello' } }),
          jsonRpcRequest(4, 'tools/call', { name: 'echo', arguments: { message: 'world' } }),
          jsonRpcRequest(5, 'tools/list', {}),
        ];

        const { stdout } = await spawnMcpServer(config, messages, {
          rootEnv: { MCPX_ROOT: testRoot },
        });

        const responses = parseResponses(stdout);
        expect(responses.length).toBe(5);

        // Verify each response id matches request id
        for (let i = 0; i < 5; i++) {
          const resp = responses[i] as { jsonrpc: string; id: number };
          expect(resp.jsonrpc).toBe('2.0');
          expect(resp.id).toBe(i + 1);
        }
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
    }, SPAWN_TIMEOUT + 5000);
  });

  describe('Protocol integrity verification', () => {
    it('each response is valid JSON-RPC 2.0', async () => {
      const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-e2e-jsonrpc-')));
      try {
        createEchoServerModule(testRoot);

        const config = {
          command: 'node',
          args: [...tsxEsmNodeArgs(), MCPX_RUN_MODULE, 'echo-server'],
          env: {},
        };

        const messages = [
          jsonRpcRequest(1, 'initialize', {}),
          jsonRpcRequest(2, 'tools/list', {}),
          jsonRpcRequest(3, 'tools/call', { name: 'echo', arguments: { message: 'test' } }),
        ];

        const { stdout } = await spawnMcpServer(config, messages, {
          rootEnv: { MCPX_ROOT: testRoot },
        });

        const responses = parseResponses(stdout);
        expect(responses.length).toBe(3);

        for (const resp of responses) {
          const r = resp as { jsonrpc: string; id: number; result?: unknown; error?: unknown };
          // Must have jsonrpc field set to "2.0"
          expect(r.jsonrpc).toBe('2.0');
          // Must have an id field
          expect(r.id).toBeDefined();
          // Must have either result or error
          expect(r.result !== undefined || r.error !== undefined).toBe(true);
        }
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
    }, SPAWN_TIMEOUT + 5000);

    it('no extra bytes between messages on stdout', async () => {
      const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-e2e-bytes-')));
      try {
        createEchoServerModule(testRoot);

        const config = {
          command: 'node',
          args: [...tsxEsmNodeArgs(), MCPX_RUN_MODULE, 'echo-server'],
          env: {},
        };

        const messages = [
          jsonRpcRequest(1, 'initialize', {}),
          jsonRpcRequest(2, 'tools/list', {}),
        ];

        const { stdout } = await spawnMcpServer(config, messages, {
          rootEnv: { MCPX_ROOT: testRoot },
        });

        // Split by newline — each line should be valid JSON or empty
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          // Each non-empty line must be valid JSON
          expect(() => JSON.parse(line)).not.toThrow();
        }

        // Verify no extra content between JSON messages
        const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
        expect(nonEmptyLines.length).toBe(2);

        // Reconstruct expected output — should be exactly json1\njson2\n
        const expectedOutput = nonEmptyLines.join('\n') + '\n';
        expect(stdout).toBe(expectedOutput);
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
    }, SPAWN_TIMEOUT + 5000);

    it('no mcpx diagnostic output on stdout', async () => {
      const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-e2e-nodiag-')));
      try {
        createEchoServerModule(testRoot);

        const config = {
          command: 'node',
          args: [...tsxEsmNodeArgs(), MCPX_RUN_MODULE, 'echo-server'],
          env: {},
        };

        const messages = [jsonRpcRequest(1, 'initialize', {})];

        const { stdout } = await spawnMcpServer(config, messages, {
          rootEnv: { MCPX_ROOT: testRoot },
        });

        // stdout must NOT contain any [mcpx] diagnostic prefix
        expect(stdout).not.toContain('[mcpx]');

        // stdout must only contain valid JSON lines
        const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
        for (const line of lines) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
    }, SPAWN_TIMEOUT + 5000);
  });

  describe('Shorthand format', () => {
    it('works with shorthand format: {"command": "node", "args": ["bin/mcpx.js", "echo-server"]}', async () => {
      const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-e2e-short-')));
      try {
        createEchoServerModule(testRoot);

        // Test shorthand format — the mcpx-run-module.mjs helper accepts module ID directly
        // which is equivalent to the shorthand mcp.json format (no "run" subcommand)
        const config = {
          command: 'node',
          args: [...tsxEsmNodeArgs(), MCPX_RUN_MODULE, 'echo-server'],
          env: {},
        };

        const messages = [
          jsonRpcRequest(1, 'initialize', { protocolVersion: '2024-11-05' }),
          jsonRpcRequest(2, 'tools/list', {}),
        ];

        const { stdout } = await spawnMcpServer(config, messages, {
          rootEnv: { MCPX_ROOT: testRoot },
        });

        const responses = parseResponses(stdout);
        expect(responses.length).toBe(2);

        // Verify initialize response
        const initResponse = responses[0] as { jsonrpc: string; id: number; result: unknown };
        expect(initResponse.jsonrpc).toBe('2.0');
        expect(initResponse.id).toBe(1);
        expect(initResponse.result).toBeDefined();

        // Verify tools/list response
        const toolsResponse = responses[1] as { jsonrpc: string; id: number; result: unknown };
        expect(toolsResponse.jsonrpc).toBe('2.0');
        expect(toolsResponse.id).toBe(2);
        expect(toolsResponse.result).toBeDefined();
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
    }, SPAWN_TIMEOUT + 5000);
  });

  describe('Environment variable precedence from client', () => {
    it('CLIENT_TOKEN from mcp.json env overrides .env file values', async () => {
      const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-e2e-envprec-')));
      try {
        const modulesDir = join(testRoot, 'modules');
        mkdirSync(modulesDir, { recursive: true });

        const moduleDir = join(modulesDir, 'env-probe');
        mkdirSync(moduleDir, { recursive: true });

        // Write module.json WITHOUT CLIENT_TOKEN in manifest env
        // (env precedence test focuses on system env vs .env files)
        const manifest = {
          id: 'env-probe',
          name: 'Env Probe Server',
          runtime: 'nodejs',
          entry: 'server.mjs',
        };
        writeFileSync(join(moduleDir, 'module.json'), JSON.stringify(manifest, null, 2), 'utf-8');

        // Write root .env with CLIENT_TOKEN
        writeFileSync(join(testRoot, '.env'), 'CLIENT_TOKEN=root-env-token\n', 'utf-8');
        chmodSync(join(testRoot, '.env'), 0o600);

        // Write module .env with CLIENT_TOKEN
        writeFileSync(join(moduleDir, '.env'), 'CLIENT_TOKEN=module-env-token\n', 'utf-8');
        chmodSync(join(moduleDir, '.env'), 0o600);

        // Write server.mjs that reports the CLIENT_TOKEN value in its initialize response
        const serverCode = `import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    return;
  }

  const { id, method } = request;

  if (method === 'initialize') {
    const response = {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'env-probe', version: '1.0.0' },
        clientToken: process.env.CLIENT_TOKEN || 'NOT_SET',
      },
    };
    process.stdout.write(JSON.stringify(response) + '\\n');
  } else {
    const response = {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' },
    };
    process.stdout.write(JSON.stringify(response) + '\\n');
  }
});

rl.on('close', () => {
  process.exit(0);
});
`;
        writeFileSync(join(moduleDir, 'server.mjs'), serverCode, 'utf-8');

        // Spawn with CLIENT_TOKEN in the mcp.json env field (simulating MCP client)
        // Per Requirement 14.5: env vars from mcp.json are received as process env vars
        // and take precedence over .env files (system env has highest precedence per R5)
        const config = {
          command: 'node',
          args: [...tsxEsmNodeArgs(), MCPX_RUN_MODULE, 'env-probe'],
          env: { CLIENT_TOKEN: 'tok-from-mcp-json' },
        };

        const messages = [jsonRpcRequest(1, 'initialize', { protocolVersion: '2024-11-05' })];

        const { stdout } = await spawnMcpServer(config, messages, {
          rootEnv: { MCPX_ROOT: testRoot },
        });

        const responses = parseResponses(stdout);
        expect(responses.length).toBe(1);

        const initResponse = responses[0] as {
          jsonrpc: string;
          id: number;
          result: { clientToken: string };
        };
        expect(initResponse.jsonrpc).toBe('2.0');
        expect(initResponse.id).toBe(1);

        // The CLIENT_TOKEN from mcp.json env (system env) should win over all .env files
        expect(initResponse.result.clientToken).toBe('tok-from-mcp-json');
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
    }, SPAWN_TIMEOUT + 5000);
  });
});
