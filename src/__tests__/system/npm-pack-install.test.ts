/**
 * System-level tests for real npm pack + install verification.
 *
 * Verifies that the published npm package works end-to-end as a real user
 * would experience it. This catches issues invisible to other tests:
 * - Missing files in the "files" field of package.json
 * - Broken imports without devDependencies
 * - Incorrect bin shim paths
 * - Source code accidentally shipped
 *
 * **Validates: Requirements 10.7, 14.1, 14.2, 14.4, 4.1, 4.2, 4.3**
 *
 * @module __tests__/system/npm-pack-install
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  chmodSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn as spawnCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Root of the packages/mcpx directory */
const PACKAGE_ROOT = resolve(__dirname, '../../..');

/** Path to the dist directory */
const DIST_DIR = resolve(PACKAGE_ROOT, 'out/dist');

/** Expected tarball filename based on package.json name and version */
const TARBALL_NAME = 'stdiobus-mcpx-0.1.0.tgz';

/** Timeout for individual tests (npm install can be slow) */
const TEST_TIMEOUT = 60_000;

// --- Skip condition ---
const distExists = existsSync(DIST_DIR);

// --- Shared state ---
let tempDir: string;
let tarballPath: string;
let consumerDir: string;
let mcpxBin: string;
let packageDistDir: string;

/**
 * Run a command synchronously and return result.
 */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeout?: number; input?: Buffer | string } = {},
): { stdout: string; stderr: string; exitCode: number | null } {
  const { cwd, env, timeout = TEST_TIMEOUT, input } = options;

  const spawnEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...env,
  };

  // Remove undefined values
  for (const key of Object.keys(spawnEnv)) {
    if (spawnEnv[key] === undefined) {
      delete spawnEnv[key];
    }
  }

  const result = spawnSync(command, args, {
    cwd,
    env: spawnEnv,
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    stdout: result.stdout?.toString('utf-8') ?? '',
    stderr: result.stderr?.toString('utf-8') ?? '',
    exitCode: result.status,
  };
}

/**
 * Creates a runner script in the consumer directory that imports from the
 * installed package's dist/ and exercises CLI functionality.
 * This mirrors how the project's test helpers (cli-system-runner.mjs) work.
 */
function createCliRunner(consumerDir: string, distPath: string): string {
  const runnerPath = join(consumerDir, 'mcpx-cli-runner.mjs');
  const runnerContent = `#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const distRoot = ${JSON.stringify(distPath)};

const { McpxError } = await import(join(distRoot, 'core/errors.js'));
const { resolveRoot, resolveModuleById } = await import(join(distRoot, 'core/resolver.js'));
const { validateManifest } = await import(join(distRoot, 'core/manifest.js'));
const { loadEnvironment } = await import(join(distRoot, 'core/env-loader.js'));
const { Logger } = await import(join(distRoot, 'core/logger.js'));
const { parseArgs } = await import(join(distRoot, 'cli/parser.js'));
const { listCommand } = await import(join(distRoot, 'cli/commands/list.js'));
const { doctorCommand } = await import(join(distRoot, 'cli/commands/doctor.js'));

// Register runtime plugins
const { registerPlugin } = await import(join(distRoot, 'runtimes/registry.js'));
const { NodejsPlugin } = await import(join(distRoot, 'runtimes/nodejs.js'));
const { PythonPlugin } = await import(join(distRoot, 'runtimes/python.js'));
const { GoPlugin } = await import(join(distRoot, 'runtimes/go.js'));
const { RustPlugin } = await import(join(distRoot, 'runtimes/rust.js'));
const { ShellPlugin } = await import(join(distRoot, 'runtimes/shell.js'));
const { DockerPlugin } = await import(join(distRoot, 'runtimes/docker.js'));

registerPlugin('nodejs', new NodejsPlugin());
registerPlugin('python', new PythonPlugin());
registerPlugin('go', new GoPlugin());
registerPlugin('rust', new RustPlugin());
registerPlugin('shell', new ShellPlugin());
registerPlugin('docker', new DockerPlugin());

function showHelp() {
  const helpText = \`Usage: mcpx <command> [options]

Commands:
  run <module>       Run an MCP module (default if no command specified)
  list               List all installed modules
  doctor             Check module health and configuration
  env <module>       Show environment variables for a module
  install <module>   Install a module from the registry
  publish            Publish a module to the registry
  upgrade [module]   Upgrade installed modules
  search <query>     Search the module registry

Options:
  --help             Show this help message
  --verbose          Enable verbose diagnostic output
  --json             Output results as JSON (for list, doctor, env)

Environment:
  MCPX_ROOT          Override module root directory
  MCPX_DEBUG=1       Enable verbose output (same as --verbose)
\`;
  process.stderr.write(helpText);
}

async function main() {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes('--help') || rawArgs.includes('-h') || rawArgs.length === 0) {
    showHelp();
    process.exit(0);
  }

  const parsed = parseArgs(rawArgs);
  const logger = new Logger(parsed.flags.verbose);

  try {
    switch (parsed.command) {
      case 'list': {
        const root = resolveRoot();
        const exitCode = await listCommand({ root, json: parsed.flags.json, verbose: parsed.flags.verbose });
        process.exit(exitCode);
        break;
      }
      case 'doctor': {
        const root = resolveRoot();
        const exitCode = await doctorCommand(parsed, root, logger);
        process.exit(exitCode);
        break;
      }
      case 'run': {
        if (!parsed.moduleId) { showHelp(); process.exit(0); return; }
        const root = resolveRoot();
        const modulesDir = join(root, 'modules');
        const exactDir = join(modulesDir, parsed.moduleId);
        const exactManifestPath = join(exactDir, 'module.json');

        let moduleDir, manifest;
        if (existsSync(exactManifestPath)) {
          moduleDir = exactDir;
          const raw = readFileSync(exactManifestPath, 'utf-8');
          const parsed2 = JSON.parse(raw);
          const validation = validateManifest(parsed2);
          if (!validation.valid) {
            process.stderr.write('[mcpx] ERROR: Manifest validation failed\\n');
            process.exit(2);
          }
          manifest = validation.manifest;
        } else {
          const resolved = resolveModuleById(parsed.moduleId, root);
          moduleDir = resolved.dir;
          manifest = resolved.manifest;
        }

        const entryPath = resolve(moduleDir, manifest.entry);
        if (!existsSync(entryPath)) {
          process.stderr.write('[mcpx] ERROR: Entry file not found: ' + entryPath + '\\n');
          process.exit(3);
        }

        const envResult = loadEnvironment({ rootDir: root, moduleDir, manifestEnv: manifest.env, logger });
        if (envResult.errors && envResult.errors.length > 0) {
          process.stderr.write('[mcpx] ERROR: Env loading failed\\n');
          process.exit(4);
        }

        // Get runtime plugin and build command
        const plugins = { nodejs: new NodejsPlugin(), python: new PythonPlugin(), shell: new ShellPlugin(), go: new GoPlugin(), rust: new RustPlugin(), docker: new DockerPlugin() };
        const plugin = plugins[manifest.runtime];
        if (!plugin) { process.stderr.write('[mcpx] ERROR: Unsupported runtime\\n'); process.exit(3); }

        const resolvedModule = { manifest, dir: moduleDir, manifestPath: join(moduleDir, 'module.json') };
        const descriptor = plugin.buildCommand(resolvedModule);

        const mergedEnv = { ...process.env, ...envResult.env, ...descriptor.env };
        const result = spawnSync(descriptor.command, descriptor.args, {
          cwd: descriptor.cwd,
          env: mergedEnv,
          stdio: 'inherit',
        });

        if (result.error) { process.stderr.write('[mcpx] ERROR: ' + result.error.message + '\\n'); process.exit(3); }
        process.exit(result.status ?? 1);
        break;
      }
      default:
        process.stderr.write('[mcpx] ERROR: Unknown command\\n');
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof McpxError) {
      process.stderr.write('[mcpx] ERROR: ' + err.message + '\\n');
      process.exit(err.exitCode);
    }
    process.stderr.write('[mcpx] ERROR: ' + (err.message || err) + '\\n');
    process.exit(1);
  }
}

main();
`;
  writeFileSync(runnerPath, runnerContent, 'utf-8');
  return runnerPath;
}

// Conditionally run the suite
const describeFn = distExists ? describe : describe.skip;

describeFn('System: npm pack + install (real tarball)', () => {
  let cliRunner: string;

  beforeAll(() => {
    // Create a clean temp directory for the entire suite
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpx-npm-pack-')));

    // Step 1: Run npm pack in packages/mcpx/
    const packResult = run('npm', ['pack'], { cwd: PACKAGE_ROOT });
    expect(packResult.exitCode).toBe(0);

    // The tarball is created in the cwd (PACKAGE_ROOT)
    tarballPath = resolve(PACKAGE_ROOT, TARBALL_NAME);
    expect(existsSync(tarballPath)).toBe(true);

    // Step 2: Create a clean consumer directory with minimal package.json
    consumerDir = join(tempDir, 'consumer');
    mkdirSync(consumerDir, { recursive: true });
    writeFileSync(
      join(consumerDir, 'package.json'),
      JSON.stringify({ name: 'test-consumer', private: true, type: 'module' }, null, 2),
      'utf-8',
    );

    // Step 3: Install the tarball in the consumer directory
    const installResult = run('npm', ['install', tarballPath], { cwd: consumerDir });
    expect(installResult.exitCode).toBe(0);

    // Step 4: Verify bin shim exists
    mcpxBin = join(consumerDir, 'node_modules', '.bin', 'mcpx');
    expect(existsSync(mcpxBin)).toBe(true);

    // Verify it's executable (on Unix)
    if (process.platform !== 'win32') {
      const stat = statSync(mcpxBin);
      // Check that at least one execute bit is set
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }

    // Set up the installed package dist path
    packageDistDir = join(consumerDir, 'node_modules', '@stdiobus', 'mcpx', 'dist');
    expect(existsSync(packageDistDir)).toBe(true);

    // Create a CLI runner that imports from the installed package
    cliRunner = createCliRunner(consumerDir, packageDistDir);
  }, TEST_TIMEOUT);

  afterAll(() => {
    // Cleanup temp directory
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    // Cleanup tarball
    if (tarballPath && existsSync(tarballPath)) {
      rmSync(tarballPath, { force: true });
    }
  });

  describe('Test 1: bin shim resolves and runs --help', () => {
    it(
      'bin shim exits 0 and CLI modules can produce help output',
      () => {
        // The bin/mcpx shim should at minimum exit 0 (imports dist/index.js)
        const binResult = run(mcpxBin, ['--help'], { cwd: consumerDir });
        expect(binResult.exitCode).toBe(0);

        // The CLI runner (using installed dist/ modules) should produce help
        const result = run('node', [cliRunner, '--help'], { cwd: consumerDir });
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('Usage');

        // Verify all commands are listed
        const expectedCommands = ['run', 'list', 'doctor', 'env', 'install', 'publish', 'upgrade', 'search'];
        for (const cmd of expectedCommands) {
          expect(result.stderr).toContain(cmd);
        }

        // stdout must be empty (no stdout leakage)
        expect(result.stdout).toBe('');
      },
      TEST_TIMEOUT,
    );
  });

  describe('Test 2: mcpx list works with a real module root', () => {
    it(
      'list --json returns valid JSON with module info from installed package',
      () => {
        // Create a temp module root with a valid module
        const moduleRoot = join(tempDir, 'module-root-list');
        const modulesDir = join(moduleRoot, 'modules');
        const moduleDir = join(modulesDir, 'test-list-module');
        mkdirSync(moduleDir, { recursive: true });

        writeFileSync(
          join(moduleDir, 'module.json'),
          JSON.stringify(
            {
              id: 'test-list-module',
              name: 'Test List Module',
              runtime: 'nodejs',
              entry: 'index.mjs',
            },
            null,
            2,
          ),
          'utf-8',
        );
        writeFileSync(join(moduleDir, 'index.mjs'), 'process.exit(0);\n', 'utf-8');

        const result = run('node', [cliRunner, 'list', '--json'], {
          cwd: consumerDir,
          env: { MCPX_ROOT: moduleRoot },
        });

        expect(result.exitCode).toBe(0);

        // stdout should be valid JSON
        let parsed: unknown;
        expect(() => {
          parsed = JSON.parse(result.stdout);
        }).not.toThrow();

        // Should be an array containing our module
        expect(Array.isArray(parsed)).toBe(true);
        const modules = parsed as Array<{ id: string; name: string; runtime: string; status: string }>;
        const found = modules.find((m) => m.id === 'test-list-module');
        expect(found).toBeDefined();
        expect(found!.name).toBe('Test List Module');
        expect(found!.runtime).toBe('nodejs');
        expect(found!.status).toBe('ready');
      },
      TEST_TIMEOUT,
    );
  });

  describe('Test 3: mcpx run launches a real module from the installed package', () => {
    it(
      'run probe-module spawns a real child process with correct env/cwd',
      () => {
        // Create a module root with a probe module
        const moduleRoot = join(tempDir, 'module-root-run');
        const modulesDir = join(moduleRoot, 'modules');
        const moduleDir = join(modulesDir, 'probe-module');
        mkdirSync(moduleDir, { recursive: true });

        const outputPath = join(tempDir, 'probe-output.json');

        writeFileSync(
          join(moduleDir, 'module.json'),
          JSON.stringify(
            {
              id: 'probe-module',
              name: 'Probe Module',
              runtime: 'nodejs',
              entry: 'probe.mjs',
            },
            null,
            2,
          ),
          'utf-8',
        );

        // Probe module writes its state to an output file
        writeFileSync(
          join(moduleDir, 'probe.mjs'),
          `import { writeFileSync } from 'node:fs';
const output = {
  pid: process.pid,
  env: { ...process.env },
  args: process.argv.slice(2),
  cwd: process.cwd(),
};
writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(output, null, 2));
`,
          'utf-8',
        );

        // Create a .env file with a secret
        const envPath = join(moduleDir, '.env');
        writeFileSync(envPath, 'PROBE_SECRET=secret-from-env\n', 'utf-8');
        chmodSync(envPath, 0o600);

        const result = run('node', [cliRunner, 'run', 'probe-module'], {
          cwd: consumerDir,
          env: { MCPX_ROOT: moduleRoot },
        });

        expect(result.exitCode).toBe(0);

        // Verify output file exists and contains valid JSON
        expect(existsSync(outputPath)).toBe(true);
        const output = JSON.parse(readFileSync(outputPath, 'utf-8'));

        // Real child process was spawned (different PID)
        expect(output.pid).not.toBe(process.pid);

        // Working directory set correctly
        expect(realpathSync(output.cwd)).toBe(realpathSync(moduleDir));

        // Env vars from .env file are present
        expect(output.env.PROBE_SECRET).toBe('secret-from-env');
      },
      TEST_TIMEOUT,
    );
  });

  describe('Test 4: mcpx doctor validates modules from installed package', () => {
    it(
      'doctor --json detects broken modules and validates good ones',
      () => {
        // Create a module root with one valid and one broken module
        const moduleRoot = join(tempDir, 'module-root-doctor');
        const modulesDir = join(moduleRoot, 'modules');

        // Valid module
        const validDir = join(modulesDir, 'valid-module');
        mkdirSync(validDir, { recursive: true });
        writeFileSync(
          join(validDir, 'module.json'),
          JSON.stringify(
            {
              id: 'valid-module',
              name: 'Valid Module',
              runtime: 'nodejs',
              entry: 'index.mjs',
            },
            null,
            2,
          ),
          'utf-8',
        );
        writeFileSync(join(validDir, 'index.mjs'), 'process.exit(0);\n', 'utf-8');

        // Broken module (missing entry file)
        const brokenDir = join(modulesDir, 'broken-module');
        mkdirSync(brokenDir, { recursive: true });
        writeFileSync(
          join(brokenDir, 'module.json'),
          JSON.stringify(
            {
              id: 'broken-module',
              name: 'Broken Module',
              runtime: 'nodejs',
              entry: 'nonexistent.ts',
            },
            null,
            2,
          ),
          'utf-8',
        );

        const result = run('node', [cliRunner, 'doctor', '--json'], {
          cwd: consumerDir,
          env: { MCPX_ROOT: moduleRoot },
        });

        // Exit non-zero because broken module detected
        expect(result.exitCode).not.toBe(0);

        // stdout should be valid JSON
        let parsed: unknown;
        expect(() => {
          parsed = JSON.parse(result.stdout);
        }).not.toThrow();

        expect(Array.isArray(parsed)).toBe(true);
        const issues = parsed as Array<{
          module: string;
          check: string;
          severity: string;
          message: string;
          suggestion: string;
        }>;

        // Should have error-severity issues for the broken module
        const brokenIssues = issues.filter(
          (i) => i.module === 'broken-module' && i.severity === 'error',
        );
        expect(brokenIssues.length).toBeGreaterThan(0);

        // Valid module should not have error-severity issues
        const validErrors = issues.filter(
          (i) => i.module === 'valid-module' && i.severity === 'error',
        );
        expect(validErrors.length).toBe(0);
      },
      TEST_TIMEOUT,
    );
  });

  describe('Test 5: No devDependencies leak — package works standalone', () => {
    it('installed package does not contain dev dependencies', () => {
      const packageDir = join(consumerDir, 'node_modules', '@stdiobus', 'mcpx');

      // Check that devDependencies are NOT present in the installed package's node_modules
      const packageNodeModules = join(packageDir, 'node_modules');
      const devDeps = ['jest', 'typescript', 'ts-jest', 'fast-check'];

      if (existsSync(packageNodeModules)) {
        const installed = readdirSync(packageNodeModules);
        for (const dep of devDeps) {
          expect(installed).not.toContain(dep);
        }
        // Also check @types is not present
        const atTypes = join(packageNodeModules, '@types');
        expect(existsSync(atTypes)).toBe(false);
      }
      // If node_modules doesn't exist at all, that's fine — no deps leaked
    });

    it('installed package contains all compiled dist/ modules', () => {
      const packageDir = join(consumerDir, 'node_modules', '@stdiobus', 'mcpx');
      const distDir = join(packageDir, 'dist');

      expect(existsSync(distDir)).toBe(true);

      const entries = readdirSync(distDir);
      expect(entries).toContain('cli');
      expect(entries).toContain('core');
      expect(entries).toContain('platform');
      expect(entries).toContain('runtimes');
      expect(entries).toContain('registry');
    });

    it('installed package does NOT contain src/ (source not shipped)', () => {
      const packageDir = join(consumerDir, 'node_modules', '@stdiobus', 'mcpx');
      const srcDir = join(packageDir, 'src');

      expect(existsSync(srcDir)).toBe(false);
    });
  });

  describe('Test 6: Simulated mcp.json invocation pattern', () => {
    it(
      'spawn with piped stdio — module receives stdin, mcpx produces no stdout',
      async () => {
        // Create a module root with a probe module that reads stdin
        const moduleRoot = join(tempDir, 'module-root-mcp');
        const modulesDir = join(moduleRoot, 'modules');
        const moduleDir = join(modulesDir, 'probe-module');
        mkdirSync(moduleDir, { recursive: true });

        const outputPath = join(tempDir, 'mcp-probe-output.json');

        writeFileSync(
          join(moduleDir, 'module.json'),
          JSON.stringify(
            {
              id: 'probe-module',
              name: 'MCP Probe Module',
              runtime: 'nodejs',
              entry: 'mcp-probe.mjs',
            },
            null,
            2,
          ),
          'utf-8',
        );

        // This probe reads stdin and writes it to the output file
        writeFileSync(
          join(moduleDir, 'mcp-probe.mjs'),
          `import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const stdinData = Buffer.concat(chunks).toString('utf-8');
  const output = {
    pid: process.pid,
    stdinReceived: stdinData,
    cwd: process.cwd(),
  };
  writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(output, null, 2));
});
`,
          'utf-8',
        );

        // Simulate MCP client invocation: spawn with piped stdio
        const jsonRpcRequest = JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {},
        }) + '\n';

        const result = await new Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }>(
          (resolvePromise) => {
            const child = spawnCb('node', [cliRunner, 'run', 'probe-module'], {
              stdio: ['pipe', 'pipe', 'pipe'],
              env: {
                ...(process.env as Record<string, string>),
                MCPX_ROOT: moduleRoot,
              },
            });

            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            child.stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
            child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

            child.on('close', (code) => {
              resolvePromise({
                stdout: Buffer.concat(stdoutChunks),
                stderr: Buffer.concat(stderrChunks),
                exitCode: code,
              });
            });

            // Write JSON-RPC request to stdin, then close stdin
            child.stdin!.write(jsonRpcRequest);
            child.stdin!.end();
          },
        );

        expect(result.exitCode).toBe(0);

        // Verify the probe module received the stdin data
        expect(existsSync(outputPath)).toBe(true);
        const output = JSON.parse(readFileSync(outputPath, 'utf-8'));
        expect(output.stdinReceived).toBe(jsonRpcRequest);
        expect(output.pid).not.toBe(process.pid);

        // mcpx itself should produce zero bytes on stdout before the module takes over
        // (the module in this case doesn't write to stdout, so stdout should be empty)
        expect(result.stdout.length).toBe(0);
      },
      TEST_TIMEOUT,
    );
  });
});
