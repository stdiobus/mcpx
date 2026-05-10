/**
 * A real MCP server using @modelcontextprotocol/sdk.
 *
 * This is NOT a test harness — it's a genuine MCP server that registers
 * a tool called "echo" which returns whatever input it receives.
 * This is the kind of module a real user would write and launch with mcpx.
 *
 * Used by: scripts/smoke-mcp-e2e.mjs
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'echo-server',
  version: '1.0.0',
});

server.registerTool('echo', {
  description: 'Echoes back the input message',
  inputSchema: { message: z.string() },
}, async ({ message }) => {
  return {
    content: [{ type: 'text', text: message }],
  };
});

server.registerTool('get_env', {
  description: 'Returns the value of an environment variable',
  inputSchema: { name: z.string() },
}, async ({ name }) => {
  return {
    content: [{ type: 'text', text: process.env[name] ?? '' }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
