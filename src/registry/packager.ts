/**
 * Module packager for creating publishable tarballs.
 *
 * Packages a module directory into a gzipped tarball suitable for
 * submission to the registry. Validates the manifest before packaging
 * and excludes sensitive files (.env), dependencies (node_modules),
 * and build artifacts from the output.
 *
 * @module registry/packager
 * @see Requirement 12.2 — Validate manifest and submit to registry
 * @see Requirement 15.3 — Exclude .env files from published packages
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { validateManifest, type ModuleManifest, type ManifestValidationResult } from '../core/manifest.js';
import { Logger } from '../core/logger.js';

/**
 * Patterns to exclude from the module tarball.
 *
 * These patterns prevent secrets, dependencies, and build artifacts
 * from being included in published packages.
 */
export const EXCLUDE_PATTERNS: readonly string[] = [
  '.env',
  '.env.*',
  'node_modules',
  'target',
  'dist',
  '__pycache__',
  '.git',
  '.DS_Store',
] as const;

/**
 * Result of a packaging operation.
 */
export interface PackageResult {
  /** Whether packaging succeeded. */
  success: boolean;

  /** The tarball buffer (only present on success). */
  tarball?: Buffer;

  /** The validated manifest (only present on success). */
  manifest?: ModuleManifest;

  /** Error message if packaging failed. */
  error?: string;

  /** Manifest validation errors (if manifest was invalid). */
  validationErrors?: string[];
}

/**
 * Options for the package operation.
 */
export interface PackageOptions {
  /** Absolute path to the module directory. */
  moduleDir: string;

  /** Logger instance for diagnostics. */
  logger?: Logger;

  /** Whether to skip manifest validation (default: false). */
  skipValidation?: boolean;
}

/**
 * Checks whether a filename matches any of the exclusion patterns.
 *
 * Matches exact names and glob-style prefix patterns (e.g. `.env.*`).
 *
 * @param filename - The filename (not full path) to check.
 * @returns true if the file should be excluded.
 */
export function shouldExclude(filename: string): boolean {
  for (const pattern of EXCLUDE_PATTERNS) {
    // Exact match
    if (filename === pattern) {
      return true;
    }

    // Glob-style prefix match: `.env.*` matches `.env.local`, `.env.production`, etc.
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1); // Remove the '*' → '.env.'
      if (filename.startsWith(prefix)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Collects all files in a module directory that should be included in the tarball.
 *
 * Recursively walks the directory tree, excluding files and directories
 * that match the exclusion patterns.
 *
 * @param moduleDir - Absolute path to the module directory.
 * @returns Array of relative file paths to include.
 */
export function collectFiles(moduleDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (shouldExclude(entry.name)) {
        continue;
      }

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = relative(moduleDir, fullPath);
        files.push(relativePath);
      }
    }
  }

  walk(moduleDir);
  return files.sort();
}

/**
 * Reads and validates the module manifest from a directory.
 *
 * @param moduleDir - Absolute path to the module directory.
 * @returns The validation result including the parsed manifest if valid.
 */
export function readAndValidateManifest(moduleDir: string): ManifestValidationResult & { rawError?: string } {
  const manifestPath = join(moduleDir, 'module.json');

  if (!existsSync(manifestPath)) {
    return {
      valid: false,
      errors: [{ field: '', message: `No module.json found in ${moduleDir}` }],
      rawError: `No module.json found in ${moduleDir}`,
    };
  }

  let rawData: unknown;
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    rawData = JSON.parse(content);
  } catch (err) {
    return {
      valid: false,
      errors: [{ field: '', message: `Failed to parse module.json: ${(err as Error).message}` }],
      rawError: `Failed to parse module.json: ${(err as Error).message}`,
    };
  }

  return validateManifest(rawData);
}

/**
 * Creates a gzipped tarball of the module directory.
 *
 * Uses the system `tar` command to create the archive, excluding
 * sensitive files, dependencies, and build artifacts. The tarball
 * includes `module.json` and all source files.
 *
 * @param moduleDir - Absolute path to the module directory.
 * @param logger - Optional logger for diagnostics.
 * @returns Buffer containing the gzipped tarball.
 * @throws Error if the tar command fails.
 */
export function createTarball(moduleDir: string, logger?: Logger): Buffer {
  const excludeFlags = EXCLUDE_PATTERNS
    .map(pattern => `--exclude='${pattern}'`)
    .join(' ');

  logger?.debug('packager', `Creating tarball from ${moduleDir}`);
  logger?.debug('packager', `Excluding: ${EXCLUDE_PATTERNS.join(', ')}`);

  const tarball = execSync(
    `tar -czf - ${excludeFlags} .`,
    { cwd: moduleDir, maxBuffer: 50 * 1024 * 1024 },
  );

  logger?.debug('packager', `Tarball created: ${tarball.length} bytes`);

  return Buffer.from(tarball);
}

/**
 * Packages a module directory into a publishable tarball.
 *
 * This is the main entry point for the packager. It:
 * 1. Validates the module manifest (unless skipValidation is set)
 * 2. Verifies module.json exists and is valid
 * 3. Creates a gzipped tarball excluding .env files, node_modules, and build artifacts
 * 4. Returns the tarball buffer and validated manifest
 *
 * @param options - Packaging options including the module directory path.
 * @returns A PackageResult indicating success or failure with details.
 *
 * @example
 * ```typescript
 * const result = await packageModule({
 *   moduleDir: '/path/to/my-module',
 *   logger: new Logger(true),
 * });
 *
 * if (result.success) {
 *   console.log(`Packaged ${result.manifest!.id}: ${result.tarball!.length} bytes`);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */
export function packageModule(options: PackageOptions): PackageResult {
  const { moduleDir, logger, skipValidation = false } = options;

  // Step 1: Validate the manifest
  if (!skipValidation) {
    const validation = readAndValidateManifest(moduleDir);

    if (!validation.valid) {
      const validationErrors = validation.errors.map(e =>
        e.field ? `${e.field}: ${e.message}` : e.message
      );

      return {
        success: false,
        error: 'Manifest validation failed',
        validationErrors,
      };
    }

    // Step 2: Verify module.json is included (it must exist since validation passed)
    const manifestPath = join(moduleDir, 'module.json');
    if (!existsSync(manifestPath)) {
      return {
        success: false,
        error: `No module.json found in ${moduleDir}`,
      };
    }

    // Step 3: Create the tarball
    let tarball: Buffer;
    try {
      tarball = createTarball(moduleDir, logger);
    } catch (err) {
      return {
        success: false,
        error: `Failed to create tarball: ${(err as Error).message}`,
      };
    }

    return {
      success: true,
      tarball,
      manifest: validation.manifest,
    };
  }

  // Skip validation path — just create the tarball
  const manifestPath = join(moduleDir, 'module.json');
  if (!existsSync(manifestPath)) {
    return {
      success: false,
      error: `No module.json found in ${moduleDir}`,
    };
  }

  let manifest: ModuleManifest;
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    manifest = JSON.parse(content) as ModuleManifest;
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse module.json: ${(err as Error).message}`,
    };
  }

  let tarball: Buffer;
  try {
    tarball = createTarball(moduleDir, logger);
  } catch (err) {
    return {
      success: false,
      error: `Failed to create tarball: ${(err as Error).message}`,
    };
  }

  return {
    success: true,
    tarball,
    manifest,
  };
}
