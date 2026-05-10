/**
 * esbuild configuration for @stdiobus/mcpx
 *
 * Enterprise-grade build pipeline producing:
 * - ESM bundle (primary, for modern Node.js consumers)
 * - CJS bundle (compatibility, for legacy require() consumers)
 * - CLI entry point with shebang banner
 * - Source maps for debugging
 * - Tree-shaking for minimal bundle size
 * - External node_modules (peer/runtime deps not bundled)
 *
 * Usage:
 *   npx tsx esbuild.config.ts          # production build
 *   npx tsx esbuild.config.ts --watch   # development watch mode
 *
 * @see tsconfig.build.json for declaration (.d.ts) generation
 */

import { build, type BuildOptions, context } from 'esbuild';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Constants ───────────────────────────────────────────────────────────────

const SRC_DIR = resolve(import.meta.dirname, 'src');
const OUT_DIR = resolve(import.meta.dirname, 'dist');
const IS_WATCH = process.argv.includes('--watch');

/**
 * Node built-in modules to mark as external.
 * esbuild won't bundle these — they resolve at runtime.
 */
const NODE_BUILTINS: string[] = [
  'node:fs',
  'node:path',
  'node:child_process',
  'node:os',
  'node:url',
  'node:util',
  'node:stream',
  'node:events',
  'node:crypto',
  'node:net',
  'node:http',
  'node:https',
  'node:buffer',
  'node:process',
  'node:assert',
  'node:readline',
  'node:tty',
  'node:worker_threads',
  'fs',
  'path',
  'child_process',
  'os',
  'url',
  'util',
  'stream',
  'events',
  'crypto',
  'net',
  'http',
  'https',
  'buffer',
  'process',
  'assert',
  'readline',
  'tty',
  'worker_threads',
];

// ─── Shared Options ──────────────────────────────────────────────────────────

const sharedOptions: BuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  sourcesContent: false,
  treeShaking: true,
  minifySyntax: true,
  minifyWhitespace: false, // keep readable for debugging in production
  keepNames: true, // preserve function/class names for stack traces
  logLevel: 'info',
  external: NODE_BUILTINS,
  // Resolve .ts extensions during bundling
  resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
  // Define compile-time constants
  define: {
    'process.env.MCPX_BUILD_VERSION': JSON.stringify(
      process.env.npm_package_version ?? '0.0.0-dev',
    ),
  },
};

// ─── Build Configurations ────────────────────────────────────────────────────

/**
 * ESM library bundle — primary distribution format.
 * Consumed by modern Node.js (>=18) and bundlers.
 */
const esmLibrary: BuildOptions = {
  ...sharedOptions,
  entryPoints: [resolve(SRC_DIR, 'index.ts')],
  outfile: resolve(OUT_DIR, 'index.js'),
  format: 'esm',
  // Preserve ESM semantics: top-level await, import.meta
  banner: {
    js: '// @stdiobus/mcpx — ESM bundle (auto-generated, do not edit)',
  },
};

/**
 * CJS library bundle — compatibility for legacy consumers.
 * Allows `const mcpx = require("@stdiobus/mcpx")`.
 */
const cjsLibrary: BuildOptions = {
  ...sharedOptions,
  entryPoints: [resolve(SRC_DIR, 'index.ts')],
  outfile: resolve(OUT_DIR, 'index.cjs'),
  format: 'cjs',
  banner: {
    js: '// @stdiobus/mcpx — CJS bundle (auto-generated, do not edit)',
  },
};

/**
 * CLI entry point — standalone executable bundle.
 * Includes shebang for direct execution via `npx mcpx` or global install.
 */
const cliBuild: BuildOptions = {
  ...sharedOptions,
  entryPoints: [resolve(SRC_DIR, 'index.ts')],
  outfile: resolve(OUT_DIR, 'cli.js'),
  format: 'esm',
  banner: {
    js: '#!/usr/bin/env node\n// @stdiobus/mcpx CLI (auto-generated, do not edit)',
  },
};

// ─── Build Execution ─────────────────────────────────────────────────────────

async function cleanDist(): Promise<void> {
  if (existsSync(OUT_DIR)) {
    rmSync(OUT_DIR, { recursive: true, force: true });
  }
}

async function runBuild(): Promise<void> {
  const startTime = performance.now();

  // Clean previous output
  await cleanDist();

  if (IS_WATCH) {
    // Watch mode: rebuild on file changes (development)
    const contexts = await Promise.all([
      context(esmLibrary),
      context(cjsLibrary),
      context(cliBuild),
    ]);

    await Promise.all(contexts.map((ctx) => ctx.watch()));
    process.stderr.write('[esbuild] Watching for changes...\n');
  } else {
    // Production build: all targets in parallel
    await Promise.all([
      build(esmLibrary),
      build(cjsLibrary),
      build(cliBuild),
    ]);

    const elapsed = (performance.now() - startTime).toFixed(0);
    process.stderr.write(`[esbuild] Build complete in ${elapsed}ms\n`);
  }
}

runBuild().catch((err) => {
  process.stderr.write(`[esbuild] Build failed: ${err.message}\n`);
  process.exit(1);
});
