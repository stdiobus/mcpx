/**
 * `mcpx doctor` command
 *
 * Validates all module manifests, checks runtime availability,
 * verifies environment variables, and reports issues with suggestions.
 *
 * When no modules are found, displays a getting-started message.
 *
 * @module cli/commands/doctor
 * @see Requirement 10.3 — Validate manifests, check runtimes, verify env
 * @see Requirement 10.9 — Provide suggested fix for each issue
 * @see Requirement 11.1–11.8 — Health checks and validation
 * @see Requirement 18.3 — Getting-started message when no modules found
 */

import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import { Logger } from '../../core/logger.js';
import { validateManifest, type ModuleManifest, type Runtime } from '../../core/manifest.js';
import { getPlugin } from '../../runtimes/registry.js';
import { displayNoModulesMessage } from '../../core/degradation.js';
import type { ParsedArgs } from '../parser.js';

/**
 * Result of a single health check.
 */
export interface HealthCheckResult {
  /** The module ID this check applies to (or 'global' for non-module checks). */
  module: string;

  /** The check category (e.g., 'manifest-parse', 'manifest-schema', 'runtime-available', 'entry-file', 'env-resolution'). */
  check: string;

  /** Severity level: 'error' prevents launch, 'warning' may cause issues, 'info' is informational. */
  severity: 'error' | 'warning' | 'info';

  /** Human-readable description of the issue or status. */
  message: string;

  /** Suggested corrective action. */
  suggestion: string;
}

/**
 * Execute the `mcpx doctor` command.
 *
 * Validates all modules in the Module_Root:
 * - Parses and validates manifests
 * - Checks runtime tool availability
 * - Verifies entry files exist
 * - Checks environment variable resolution
 *
 * @param args - Parsed CLI arguments (for --json flag)
 * @param root - The resolved Module_Root directory path
 * @param logger - Logger instance for output
 * @returns Exit code (0 if no errors, 1 if error-severity issues found)
 */
export async function doctorCommand(
  args: ParsedArgs,
  root: string,
  logger: Logger,
): Promise<number> {
  const json = args.flags.json;
  const results: HealthCheckResult[] = [];

  const modulesDir = join(root, 'modules');
  const moduleDirs = discoverModuleDirs(modulesDir);

  if (moduleDirs.length === 0) {
    // No modules found — show getting-started message
    if (json) {
      const noModuleResult: HealthCheckResult = {
        module: 'global',
        check: 'discovery',
        severity: 'warning',
        message: `No modules found in ${modulesDir}`,
        suggestion: `Create a module directory with a module.json manifest in ${modulesDir}`,
      };
      process.stdout.write(JSON.stringify([noModuleResult], null, 2) + '\n');
    } else {
      displayNoModulesMessage(root, logger);
    }
    return 0;
  }

  // Check each module
  for (const { dirName, dirPath } of moduleDirs) {
    const manifestPath = join(dirPath, 'module.json');

    // 1. Parse manifest JSON
    let rawData: unknown;
    try {
      const content = readFileSync(manifestPath, 'utf-8');
      rawData = JSON.parse(content);
    } catch (err) {
      results.push({
        module: dirName,
        check: 'manifest-parse',
        severity: 'error',
        message: `Invalid JSON in module.json: ${(err as Error).message}`,
        suggestion: 'Fix the JSON syntax in module.json',
      });
      continue;
    }

    // 2. Validate manifest schema
    const validation = validateManifest(rawData);
    if (!validation.valid) {
      for (const error of validation.errors) {
        results.push({
          module: dirName,
          check: 'manifest-schema',
          severity: 'error',
          message: `${error.field}: ${error.message}`,
          suggestion: `Fix the "${error.field}" field in module.json`,
        });
      }
      continue;
    }

    const manifest = validation.manifest!;

    // 3. Check runtime availability
    try {
      const plugin = getPlugin(manifest.runtime as Runtime);
      const check = await plugin.checkAvailability();
      if (!check.available) {
        results.push({
          module: manifest.id,
          check: 'runtime-available',
          severity: 'error',
          message: `Runtime tool "${check.tool}" is not available`,
          suggestion: check.suggestion ?? `Install ${check.tool}`,
        });
      } else {
        results.push({
          module: manifest.id,
          check: 'runtime-available',
          severity: 'info',
          message: `${check.tool}${check.version ? ` v${check.version}` : ''} available`,
          suggestion: '',
        });
      }
    } catch (err) {
      results.push({
        module: manifest.id,
        check: 'runtime-available',
        severity: 'error',
        message: `No plugin for runtime: ${manifest.runtime}`,
        suggestion: `Register a plugin for the "${manifest.runtime}" runtime`,
      });
    }

    // 4. Check entry file exists
    const entryPath = join(dirPath, manifest.entry);
    if (!existsSync(entryPath)) {
      results.push({
        module: manifest.id,
        check: 'entry-file',
        severity: 'error',
        message: `Entry file not found: ${manifest.entry}`,
        suggestion: `Create the entry file at ${entryPath}`,
      });
    } else {
      try {
        accessSync(entryPath, constants.R_OK);
      } catch {
        results.push({
          module: manifest.id,
          check: 'entry-file',
          severity: 'error',
          message: `Entry file not readable: ${manifest.entry}`,
          suggestion: `Check permissions on ${entryPath}`,
        });
      }
    }

    // 5. Check environment variable resolution
    if (manifest.env) {
      for (const [key, value] of Object.entries(manifest.env)) {
        if (value === '' && process.env[key] === undefined) {
          results.push({
            module: manifest.id,
            check: 'env-resolution',
            severity: 'warning',
            message: `Environment variable "${key}" is unresolved (empty default, not in system env)`,
            suggestion: `Set ${key} in your .env file or system environment`,
          });
        }
      }
    }
  }

  // Output results
  if (json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    for (const result of results) {
      const prefix = result.severity === 'error' ? '✗' : result.severity === 'warning' ? '!' : '✓';
      logger.info(`  ${prefix} [${result.module}] ${result.check}: ${result.message}`);
      if (result.suggestion && result.severity !== 'info') {
        logger.info(`    → ${result.suggestion}`);
      }
    }
  }

  // Exit code: 1 if any error-severity issues
  const hasErrors = results.some(r => r.severity === 'error');
  return hasErrors ? 1 : 0;
}

/**
 * Discover module directories within the modules/ folder.
 */
function discoverModuleDirs(modulesDir: string): Array<{ dirName: string; dirPath: string }> {
  if (!existsSync(modulesDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(modulesDir);
  } catch {
    return [];
  }

  const dirs: Array<{ dirName: string; dirPath: string }> = [];

  for (const entry of entries) {
    const entryPath = join(modulesDir, entry);
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const manifestPath = join(entryPath, 'module.json');
    if (existsSync(manifestPath)) {
      dirs.push({ dirName: entry, dirPath: entryPath });
    }
  }

  return dirs;
}
