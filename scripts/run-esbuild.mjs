#!/usr/bin/env node
/**
 * Cross-version Node launcher for esbuild.config.ts.
 *
 * Node >= 18.19.0: use `--import` for the tsx ESM loader.
 * Older Node 18 minors still need `--loader`.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const [majorS, minorS] = process.versions.node.split('.');
const major = Number(majorS || 0);
const minor = Number(minorS || 0);
const configPath = resolve(process.cwd(), 'esbuild.config.ts');

const supportsImportFlag = major >= 20 || major === 19 || (major === 18 && minor >= 19);
const nodeArgs = supportsImportFlag ? ['--import', 'tsx/esm'] : ['--experimental-loader', 'tsx/esm'];
const extraArgs = process.argv.slice(2); // e.g. --watch

const result = spawnSync(process.execPath, [...nodeArgs, configPath, ...extraArgs], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
