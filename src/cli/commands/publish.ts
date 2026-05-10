/**
 * `mcpx publish` command
 *
 * Validates a module manifest, creates a tarball of the module directory,
 * and submits it to the registry. Aborts with validation errors without
 * contacting the registry if the manifest is invalid.
 *
 * @module cli/commands/publish
 * @see Requirement 12.2 — Validate manifest before submission
 * @see Requirement 12.10 — Abort with validation errors without contacting registry
 */

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Logger } from '../../core/logger.js';
import { validateManifest, type ModuleManifest } from '../../core/manifest.js';
import type { RegistryClient } from '../../registry/client.js';
import { HttpRegistryClient } from '../../registry/client.js';

/**
 * JSON output structure for the publish command.
 */
export interface PublishJsonOutput {
  /** Whether the publish was successful. */
  success: boolean;
  /** The module ID that was published. */
  moduleId: string;
  /** Validation errors if the manifest was invalid. */
  validationErrors?: string[];
  /** Error message if publish failed. */
  error?: string;
}

/**
 * Options for the publishCommand function.
 */
export interface PublishCommandOptions {
  /** The module directory path (defaults to cwd). */
  moduleDir?: string;
  /** Whether to output JSON. */
  json: boolean;
  /** Whether verbose logging is enabled. */
  verbose: boolean;
  /** Registry client (injectable for testing). */
  registryClient?: RegistryClient;
}

/**
 * Patterns to exclude from the module tarball.
 */
const TARBALL_EXCLUDES = [
  '.env',
  '.env.*',
  'node_modules',
  'target',
  'dist',
  '.git',
];

/**
 * Create a tarball of the module directory, excluding build artifacts and secrets.
 *
 * @param moduleDir - Absolute path to the module directory
 * @param logger - Logger instance for diagnostics
 * @returns Buffer containing the gzipped tarball
 */
export function createTarball(moduleDir: string, logger: Logger): Buffer {
  const excludeFlags = TARBALL_EXCLUDES
    .map(pattern => `--exclude='${pattern}'`)
    .join(' ');

  logger.debug('publish', `Creating tarball from ${moduleDir}`);

  const tarball = execSync(
    `tar -czf - ${excludeFlags} .`,
    { cwd: moduleDir, maxBuffer: 50 * 1024 * 1024 },
  );

  return Buffer.from(tarball);
}

/**
 * Execute the `mcpx publish` command.
 *
 * Steps:
 * 1. Locate module.json in the specified directory (or cwd)
 * 2. Validate the manifest against the schema
 * 3. If invalid, report errors to stderr and abort WITHOUT contacting the registry
 * 4. If valid, create a tarball of the module directory
 * 5. Submit the manifest + tarball to the registry
 *
 * @param options - Command options
 * @returns Exit code (0 on success, non-zero on failure)
 */
export async function publishCommand(options: PublishCommandOptions): Promise<number> {
  const { json, verbose, registryClient } = options;
  const logger = new Logger(verbose);

  // Resolve the module directory
  const moduleDir = resolve(options.moduleDir ?? process.cwd());
  const manifestPath = join(moduleDir, 'module.json');

  logger.debug('publish', `Module directory: ${moduleDir}`);

  // Check that module.json exists
  if (!existsSync(manifestPath)) {
    const error = `No module.json found in ${moduleDir}`;
    const suggestion = 'Run this command from a module directory or specify the module path';

    if (json) {
      writeJsonOutput({ success: false, moduleId: '', error });
    } else {
      logger.error(error, suggestion);
    }
    return 1;
  }

  // Parse the manifest JSON
  let rawData: unknown;
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    rawData = JSON.parse(content);
  } catch (err) {
    const error = `Failed to parse module.json: ${(err as Error).message}`;

    if (json) {
      writeJsonOutput({ success: false, moduleId: '', error });
    } else {
      logger.error(error);
    }
    return 2;
  }

  // Validate the manifest
  const validation = validateManifest(rawData);

  if (!validation.valid) {
    // Abort WITHOUT contacting the registry (R12.10)
    const errorMessages = validation.errors.map(e =>
      e.field ? `${e.field}: ${e.message}` : e.message
    );

    if (json) {
      const id = (rawData as Record<string, unknown>)?.id as string ?? '';
      writeJsonOutput({
        success: false,
        moduleId: id,
        validationErrors: errorMessages,
      });
    } else {
      logger.error('Manifest validation failed:');
      for (const msg of errorMessages) {
        process.stderr.write(`[mcpx]   • ${msg}\n`);
      }
    }
    return 2;
  }

  const manifest = validation.manifest!;
  logger.debug('publish', `Validated manifest for module: ${manifest.id}`);

  // Create the tarball
  let tarball: Buffer;
  try {
    tarball = createTarball(moduleDir, logger);
  } catch (err) {
    const error = `Failed to create tarball: ${(err as Error).message}`;

    if (json) {
      writeJsonOutput({ success: false, moduleId: manifest.id, error });
    } else {
      logger.error(error);
    }
    return 1;
  }

  logger.debug('publish', `Tarball created: ${tarball.length} bytes`);

  // Submit to registry
  const client = registryClient ?? new HttpRegistryClient();

  try {
    await client.publish(manifest, tarball);
  } catch (err) {
    const error = `Failed to publish to registry: ${(err as Error).message}`;
    const suggestion = 'Check your network connection and try again';

    if (json) {
      writeJsonOutput({ success: false, moduleId: manifest.id, error });
    } else {
      logger.error(error, suggestion);
    }
    return 1;
  }

  // Success
  if (json) {
    writeJsonOutput({ success: true, moduleId: manifest.id });
  } else {
    logger.info(`Published "${manifest.id}" to registry`);
  }

  return 0;
}

/**
 * Write JSON output to stdout.
 */
function writeJsonOutput(output: PublishJsonOutput): void {
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
