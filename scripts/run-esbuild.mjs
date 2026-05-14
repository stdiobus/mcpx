#!/usr/bin/env node
/**
 * Cross-version Node launcher for esbuild.config.ts.
 *
 * Node >= 20: supports `--import`.
 * Node <= 18: use `--loader` for the tsx ESM loader.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const major = Number(process.versions.node.split('.')[0] || 0);
const configPath = resolve(process.cwd(), 'esbuild.config.ts');

const nodeArgs = major >= 20 ? ['--import', 'tsx/esm'] : ['--experimental-loader', 'tsx/esm'];
const extraArgs = process.argv.slice(2); // e.g. --watch

const result = spawnSync(process.execPath, [...nodeArgs, configPath, ...extraArgs], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
