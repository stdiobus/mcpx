#!/usr/bin/env node
/**
 * mcpx CLI entry point.
 *
 * Note: This file MUST have an extension in a `"type": "module"` package.
 * Running `node bin/mcpx` (extensionless) fails with ERR_UNKNOWN_FILE_EXTENSION
 * on modern Node versions.
 */
import('../out/dist/cli.js').catch((err) => {
  process.stderr.write(`[mcpx] Fatal: ${err?.message || err}\n`);
  process.exit(1);
});

