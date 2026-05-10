#!/usr/bin/env node
/**
 * Smoke Test — Real-world acceptance script for @stdiobus/mcpx
 *
 * This is a standalone Node.js script (NOT a Jest test) that verifies the
 * published npm package works exactly as a real user would experience it.
 *
 * Run: node scripts/smoke-test.mjs
 *
 * No test framework, no mocks, no abstractions — just real shell commands
 * and real assertions with process.exit(1) on failure.
 *
 * Validates: Requirements 10.7, 14.1, 14.2, 14.4, 4.1, 4.2, 4.3, 4.5
 */

import { spawnSync, spawn as spawnCb } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Configuration ---
const PACKAGE_ROOT = resolve(__dirname, '..');
const TIMEOUT_MS = 120_000; // 120s script-level timeout
const STEP_TIMEOUT = 60_000; // 60s per step

// --- State ---
let tempDir = null;
let tarballPath = null;
let consumerDir = null;
let mcpxBin = null;
const startTime = Date.now();

// --- Script-level timeout ---
const timeoutHandle = setTimeout(() => {
  fail('Script-level timeout exceeded (120s)');
}, TIMEOUT_MS);

// --- Helpers ---
function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function stepHeader(num, total, description) {
  log(`\n[STEP ${num}/${total}] ${description}`);
}

function pass(msg) {
  log(`  [PASS] ${msg}`);
}

function fail(msg, details) {
  log(`  [FAIL] ${msg}`);
  if (details) {
    if (details.stdout) log(`  stdout: ${details.stdout.slice(0, 2000)}`);
    if (details.stderr) log(`  stderr: ${details.stderr.slice(0, 2000)}`);
    if (details.exitCode !== undefined) log(`  exitCode: ${details.exitCode}`);
  }
  cleanup();
  clearTimeout(timeoutHandle);
  process.exit(1);
}

function assert(condition, msg, details) {
  if (!condition) fail(msg, details);
}

function run(command, args, opts = {}) {
  const { cwd, env, input, timeout = STEP_TIMEOUT } = opts;
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: result.stdout?.toString('utf-8') ?? '',
    stderr: result.stderr?.toString('utf-8') ?? '',
    exitCode: result.status,
    error: result.error,
  };
}

function cleanup() {
  try {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
  try {
    if (tarballPath && existsSync(tarballPath)) {
      rmSync(tarballPath, { force: true });
    }
  } catch { /* best effort */ }
}

// --- Main ---
const TOTAL_STEPS = 8;
const results = [];

// ============================================================
// STEP 1: Build (skip if already built)
// ============================================================
stepHeader(1, TOTAL_STEPS, 'npm run build');

if (existsSync(join(PACKAGE_ROOT, 'out', 'dist', 'index.js'))) {
  pass('Build artifacts already exist, skipping build');
} else {
  const buildResult = run('npm', ['run', 'build'], { cwd: PACKAGE_ROOT });
  assert(buildResult.exitCode === 0, 'Build failed', buildResult);
  assert(existsSync(join(PACKAGE_ROOT, 'out', 'dist', 'index.js')), 'out/dist/index.js not found after build');
  pass('Build succeeded, out/dist/index.js exists');
}
results.push('Step 1: Build — OK');

// ============================================================
// STEP 2: Pack
// ============================================================
stepHeader(2, TOTAL_STEPS, 'npm pack');

const packResult = run('npm', ['pack'], { cwd: PACKAGE_ROOT });
assert(packResult.exitCode === 0, 'npm pack failed', packResult);

// Find the .tgz file
const tgzFiles = readdirSync(PACKAGE_ROOT).filter(f => f.endsWith('.tgz'));
assert(tgzFiles.length > 0, 'No .tgz file produced by npm pack');
tarballPath = resolve(PACKAGE_ROOT, tgzFiles[tgzFiles.length - 1]);
assert(existsSync(tarballPath), `Tarball not found at ${tarballPath}`);
pass(`Tarball created: ${tgzFiles[tgzFiles.length - 1]}`);
results.push('Step 2: Pack — OK');

// ============================================================
// STEP 3: Install into clean directory
// ============================================================
stepHeader(3, TOTAL_STEPS, 'Install into clean consumer directory');

tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-smoke-')));
consumerDir = join(tempDir, 'consumer');
mkdirSync(consumerDir, { recursive: true });

writeFileSync(
  join(consumerDir, 'package.json'),
  JSON.stringify({ name: 'smoke-consumer', private: true }, null, 2),
);

const installResult = run('npm', ['install', tarballPath], { cwd: consumerDir });
assert(installResult.exitCode === 0, 'npm install failed', installResult);

// Assert: bin shim exists
mcpxBin = join(consumerDir, 'node_modules', '.bin', 'mcpx');
assert(existsSync(mcpxBin), 'node_modules/.bin/mcpx not found');

// Assert: out/ modules exist
const installedOut = join(consumerDir, 'node_modules', '@stdiobus', 'mcpx', 'out', 'dist');
assert(existsSync(installedOut), 'out/dist/ not found in installed package');

// Assert: src/ NOT shipped
const installedSrc = join(consumerDir, 'node_modules', '@stdiobus', 'mcpx', 'src');
assert(!existsSync(installedSrc), 'src/ should NOT be shipped in the package');

// Assert: no devDependencies present
const installedPkgModules = join(consumerDir, 'node_modules', '@stdiobus', 'mcpx', 'node_modules');
const devDeps = ['jest', 'typescript', 'ts-jest', 'fast-check'];
if (existsSync(installedPkgModules)) {
  const installed = readdirSync(installedPkgModules);
  for (const dep of devDeps) {
    assert(!installed.includes(dep), `devDependency "${dep}" found in installed package`);
  }
  assert(!existsSync(join(installedPkgModules, '@types')), '@types/ found in installed package');
}

pass('Package installed cleanly with correct out/ structure, no src/, no devDeps');
results.push('Step 3: Install — OK');

// ============================================================
// STEP 4: mcpx --help works
// ============================================================
stepHeader(4, TOTAL_STEPS, 'mcpx --help');

// Use the real bin/mcpx from the installed package — no custom runner needed.
// bin/mcpx imports dist/index.js which calls main() and dispatches commands.
const helpResult = run(mcpxBin, ['--help'], { cwd: consumerDir });
assert(helpResult.exitCode === 0, 'mcpx --help exited non-zero', helpResult);

// Assert: stderr contains Usage and all command names
const helpOutput = helpResult.stderr;
assert(helpOutput.includes('Usage'), 'Help output missing "Usage"', helpResult);
const expectedCommands = ['run', 'list', 'doctor', 'env', 'install', 'publish', 'upgrade', 'search'];
for (const cmd of expectedCommands) {
  assert(helpOutput.includes(cmd), `Help output missing command "${cmd}"`, helpResult);
}

// Assert: stdout is empty
assert(helpResult.stdout.length === 0, 'mcpx --help wrote to stdout (should be empty)', helpResult);

pass('--help exits 0, stderr has Usage + all commands, stdout empty');
results.push('Step 4: --help — OK');

// ============================================================
// STEP 5: mcpx list --json with real modules
// ============================================================
stepHeader(5, TOTAL_STEPS, 'mcpx list --json with real modules');

// Create a temp module root with a valid Node.js module
const moduleRoot = join(tempDir, 'module-root');
const modulesDir = join(moduleRoot, 'modules');
const listModuleDir = join(modulesDir, 'smoke-list-module');
mkdirSync(listModuleDir, { recursive: true });

writeFileSync(
  join(listModuleDir, 'module.json'),
  JSON.stringify({
    id: 'smoke-list-module',
    name: 'Smoke List Module',
    runtime: 'nodejs',
    entry: 'index.mjs',
  }, null, 2),
);
writeFileSync(join(listModuleDir, 'index.mjs'), 'process.exit(0);\n');

const listResult = run(mcpxBin, ['list', '--json'], {
  cwd: consumerDir,
  env: { MCPX_ROOT: moduleRoot },
});
assert(listResult.exitCode === 0, 'mcpx list --json exited non-zero', listResult);

// Assert: stdout is valid JSON array
let listParsed;
try {
  listParsed = JSON.parse(listResult.stdout);
} catch (e) {
  fail(`mcpx list --json stdout is not valid JSON: ${e.message}`, listResult);
}
assert(Array.isArray(listParsed), 'mcpx list --json output is not an array', listResult);

const foundModule = listParsed.find(m => m.id === 'smoke-list-module');
assert(foundModule, 'Module "smoke-list-module" not found in list output', listResult);
assert(foundModule.name === 'Smoke List Module', `Module name mismatch: ${foundModule.name}`);
assert(foundModule.runtime === 'nodejs', `Module runtime mismatch: ${foundModule.runtime}`);
assert(foundModule.status === 'ready', `Module status mismatch: ${foundModule.status}`);

pass('list --json returns valid JSON array with correct module info');
results.push('Step 5: list --json — OK');

// ============================================================
// STEP 6: mcpx run launches a real module
// ============================================================
stepHeader(6, TOTAL_STEPS, 'mcpx run launches a real module');

// Create a probe module that writes state to an output file
const probeModuleDir = join(modulesDir, 'smoke-probe');
mkdirSync(probeModuleDir, { recursive: true });

const probeOutputPath = join(tempDir, `probe-output-${randomBytes(4).toString('hex')}.json`);

writeFileSync(
  join(probeModuleDir, 'module.json'),
  JSON.stringify({
    id: 'smoke-probe',
    name: 'Smoke Probe',
    runtime: 'nodejs',
    entry: 'probe.mjs',
  }, null, 2),
);

writeFileSync(
  join(probeModuleDir, 'probe.mjs'),
  `import { writeFileSync } from 'node:fs';
const output = {
  pid: process.pid,
  cwd: process.cwd(),
  env: { SMOKE_SECRET: process.env.SMOKE_SECRET || '' },
  args: process.argv.slice(2),
};
writeFileSync(${JSON.stringify(probeOutputPath)}, JSON.stringify(output, null, 2));
`,
);

// Create .env with a secret (chmod 600)
const envFilePath = join(probeModuleDir, '.env');
writeFileSync(envFilePath, 'SMOKE_SECRET=real-secret-value\n');
chmodSync(envFilePath, 0o600);

const runResult = run(mcpxBin, ['run', 'smoke-probe'], {
  cwd: consumerDir,
  env: { MCPX_ROOT: moduleRoot },
});
assert(runResult.exitCode === 0, 'mcpx run smoke-probe exited non-zero', runResult);
assert(existsSync(probeOutputPath), 'Probe output file not created');

const probeOutput = JSON.parse(readFileSync(probeOutputPath, 'utf-8'));
assert(probeOutput.pid !== process.pid, 'Probe PID matches parent — no child process spawned');
assert(
  realpathSync(probeOutput.cwd) === realpathSync(probeModuleDir),
  `Probe cwd mismatch: got "${probeOutput.cwd}", expected "${probeModuleDir}"`,
);
assert(
  probeOutput.env.SMOKE_SECRET === 'real-secret-value',
  `Probe env.SMOKE_SECRET mismatch: got "${probeOutput.env.SMOKE_SECRET}"`,
);

pass('run spawned real child process with correct cwd, env, and PID');
results.push('Step 6: run — OK');

// ============================================================
// STEP 7: mcpx doctor --json detects issues
// ============================================================
stepHeader(7, TOTAL_STEPS, 'mcpx doctor --json detects issues');

// Add a broken module (missing entry file)
const brokenModuleDir = join(modulesDir, 'smoke-broken');
mkdirSync(brokenModuleDir, { recursive: true });
writeFileSync(
  join(brokenModuleDir, 'module.json'),
  JSON.stringify({
    id: 'smoke-broken',
    name: 'Broken Module',
    runtime: 'nodejs',
    entry: 'nonexistent-file.ts',
  }, null, 2),
);

const doctorResult = run(mcpxBin, ['doctor', '--json'], {
  cwd: consumerDir,
  env: { MCPX_ROOT: moduleRoot },
});
assert(doctorResult.exitCode !== 0, 'mcpx doctor should exit non-zero with broken module', doctorResult);

let doctorParsed;
try {
  doctorParsed = JSON.parse(doctorResult.stdout);
} catch (e) {
  fail(`mcpx doctor --json stdout is not valid JSON: ${e.message}`, doctorResult);
}
assert(Array.isArray(doctorParsed), 'doctor output is not an array', doctorResult);

const brokenIssues = doctorParsed.filter(
  i => i.module === 'smoke-broken' && i.severity === 'error',
);
assert(brokenIssues.length > 0, 'No error-severity issues found for broken module', doctorResult);

pass('doctor --json exits non-zero and reports error for broken module');
results.push('Step 7: doctor --json — OK');

// ============================================================
// STEP 8: MCP client simulation (stdio pipe)
// ============================================================
stepHeader(8, TOTAL_STEPS, 'MCP client simulation (stdio pipe)');

// Create a stdio-probe module that reads stdin and writes to output file
const stdioModuleDir = join(modulesDir, 'stdio-probe');
mkdirSync(stdioModuleDir, { recursive: true });

const stdioOutputPath = join(tempDir, `stdio-output-${randomBytes(4).toString('hex')}.json`);

writeFileSync(
  join(stdioModuleDir, 'module.json'),
  JSON.stringify({
    id: 'stdio-probe',
    name: 'Stdio Probe',
    runtime: 'nodejs',
    entry: 'stdio-probe.mjs',
  }, null, 2),
);

writeFileSync(
  join(stdioModuleDir, 'stdio-probe.mjs'),
  `import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const stdinData = Buffer.concat(chunks).toString('utf-8');
  writeFileSync(${JSON.stringify(stdioOutputPath)}, JSON.stringify({ stdinReceived: stdinData }));
});
`,
);

const jsonRpcMessage = JSON.stringify({
  jsonrpc: '2.0',
  method: 'initialize',
  id: 1,
}) + '\n';

// Spawn with piped stdio
const stdioResult = await new Promise((resolvePromise) => {
  const child = spawnCb(mcpxBin, ['run', 'stdio-probe'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MCPX_ROOT: moduleRoot },
  });

  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  child.on('close', (code) => {
    resolvePromise({
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks),
      exitCode: code,
    });
  });

  child.on('error', (err) => {
    resolvePromise({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 1, error: err });
  });

  // Write JSON-RPC message to stdin, then close
  child.stdin.write(jsonRpcMessage);
  child.stdin.end();
});

assert(stdioResult.exitCode === 0, 'stdio-probe exited non-zero', {
  stdout: stdioResult.stdout.toString(),
  stderr: stdioResult.stderr.toString(),
  exitCode: stdioResult.exitCode,
});
assert(existsSync(stdioOutputPath), 'Stdio probe output file not created');

const stdioOutput = JSON.parse(readFileSync(stdioOutputPath, 'utf-8'));
assert(
  stdioOutput.stdinReceived === jsonRpcMessage,
  `Stdio probe did not receive expected JSON-RPC message. Got: "${stdioOutput.stdinReceived}"`,
);

// mcpx should produce zero bytes on stdout before module takes over
assert(
  stdioResult.stdout.length === 0,
  `mcpx produced ${stdioResult.stdout.length} bytes on stdout (expected 0)`,
);

pass('Stdio pipe works: module received JSON-RPC message, mcpx produced zero stdout bytes');
results.push('Step 8: stdio pipe — OK');

// ============================================================
// Summary
// ============================================================
log('\n' + '='.repeat(60));
log('SMOKE TEST PASSED — All steps completed successfully');
log('='.repeat(60));
for (const r of results) {
  log(`  ✓ ${r}`);
}
log(`\n  Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

cleanup();
clearTimeout(timeoutHandle);
process.exit(0);
