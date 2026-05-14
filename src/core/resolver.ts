/**
 * Root + module resolution for mcpx.
 *
 * Root resolution determines the Module_Root directory using a precedence chain:
 * 1. MCPX_ROOT environment variable (if set and non-empty)
 * 2. Script location (dirname of dirname of realpath of process.argv[1])
 * 3. ~/.ai fallback (cross-platform via homedir())
 *
 * Module discovery finds modules by ID or path within the Module_Root:
 * 1. Exact directory name match: {Module_Root}/modules/{Module_ID}/module.json
 * 2. Scan immediate subdirectories of {Module_Root}/modules/ for module.json with matching id field
 * 3. If input contains `/` or `.` → treat as path, resolve directly
 *
 * @module core/resolver
 * @see Requirement 2.1 — Resolution precedence order
 * @see Requirement 2.2 — MCPX_ROOT handling (empty string treated as unset)
 * @see Requirement 2.3 — Error when no root resolved, listing locations checked
 * @see Requirement 2.4 — Symlink resolution via realpathSync
 * @see Requirement 2.5 — Validate resolved path exists and is a directory
 * @see Requirement 2.6 — Relative MCPX_ROOT resolved against cwd
 * @see Requirement 3.1 — Exact directory name match
 * @see Requirement 3.2 — Scan subdirectories for matching id field
 * @see Requirement 3.3 — Error listing discovered module IDs
 * @see Requirement 3.4 — Duplicate ID detection
 * @see Requirement 3.5 — Path-based resolution
 * @see Requirement 3.6 — Error for path without valid module.json
 * @see Requirement 13.3 — Platform-appropriate path separators and home directory
 * @see Requirement 13.5 — Handle Unix (~/.ai) and Windows (%USERPROFILE%\.ai) transparently
 */

import { resolve, dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ModuleManifest, ResolvedModule } from './manifest.js';
import { validateManifest } from './manifest.js';
import { McpxError, ManifestError } from './errors.js';

/**
 * Resolve the Module_Root directory using the precedence chain.
 *
 * Resolution order:
 * 1. If MCPX_ROOT is set to a non-empty value, use it (resolve relative paths against cwd)
 * 2. Resolve symlinks on the script path, then check dirname(dirname(realpath)) for a modules/ dir
 * 3. Fall back to ~/.ai (or %USERPROFILE%\.ai on Windows)
 *
 * @returns The absolute path to the resolved Module_Root directory
 * @throws {McpxError} With code 'general' if no valid root can be resolved
 *
 * @example
 * ```typescript
 * const root = resolveRoot();
 * // root === "/Users/etc/.ai"
 * ```
 */
export function resolveRoot(): string {
  const checkedLocations: string[] = [];

  // 1. MCPX_ROOT environment variable
  const envRoot = process.env.MCPX_ROOT;
  if (envRoot !== undefined && envRoot !== '') {
    // Resolve relative paths against cwd
    const resolved = resolve(envRoot);
    checkedLocations.push(resolved);

    if (!existsSync(resolved)) {
      throw new McpxError(
        'general',
        `MCPX_ROOT path does not exist: ${resolved}`,
        'Set MCPX_ROOT to an existing directory or unset it to use automatic resolution',
      );
    }

    if (!isDirectory(resolved)) {
      throw new McpxError(
        'general',
        `MCPX_ROOT path is not a directory: ${resolved}`,
        'Set MCPX_ROOT to a directory path, not a file',
      );
    }

    return resolved;
  }

  // 2. Script location: dirname(dirname(realpath(script)))
  const scriptPath = process.argv[1];
  if (scriptPath) {
    try {
      const scriptReal = realpathSync(scriptPath);
      const candidate = dirname(dirname(scriptReal));
      checkedLocations.push(candidate);

      const modulesDir = resolve(candidate, 'modules');
      if (existsSync(modulesDir) && isDirectory(modulesDir)) {
        return candidate;
      }
    } catch {
      // realpathSync may throw if the script path doesn't exist (e.g., in tests)
      // Continue to fallback
    }
  }

  // 3. Home directory fallback: ~/.ai
  const home = resolve(homedir(), '.ai');
  checkedLocations.push(home);

  if (existsSync(home) && isDirectory(home)) {
    return home;
  }

  // No root found — report error with all locations checked
  const locations = checkedLocations.map((loc) => `  - ${loc}`).join('\n');
  throw new McpxError(
    'general',
    `Module root not found. Checked:\n${locations}`,
    'Set MCPX_ROOT environment variable or create ~/.ai directory',
  );
}

/**
 * Check whether a path is a directory.
 *
 * @param path - The absolute path to check
 * @returns true if the path exists and is a directory
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Determines whether the given input should be treated as a filesystem path
 * rather than a module ID.
 *
 * An input is treated as a path if it contains `/` or `.` characters.
 *
 * @param input - The module identifier or path string
 * @returns true if the input should be resolved as a path
 */
export function isPathInput(input: string): boolean {
  return input.includes('/') || input.includes('.');
}

/**
 * Attempts to read and parse a module.json file at the given path.
 * Returns the parsed manifest or null if the file doesn't exist or is invalid JSON.
 *
 * @param manifestPath - Absolute path to the module.json file
 * @returns The parsed manifest object or null
 */
function readManifestFile(manifestPath: string): ModuleManifest | null {
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content) as ModuleManifest;
  } catch {
    return null;
  }
}

/**
 * Discovers all modules in the Module_Root by scanning the modules/ directory.
 * Returns an array of discovered modules with their manifest and directory info.
 *
 * Used for error reporting (listing available modules) and duplicate detection.
 *
 * @param moduleRoot - Absolute path to the Module_Root directory
 * @returns Array of discovered modules with id and directory path
 */
export function discoverAllModules(moduleRoot: string): Array<{ id: string; dir: string; manifestPath: string }> {
  const modulesDir = join(moduleRoot, 'modules');
  if (!existsSync(modulesDir)) {
    return [];
  }

  const discovered: Array<{ id: string; dir: string; manifestPath: string }> = [];

  let entries: string[];
  try {
    entries = readdirSync(modulesDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryPath = join(modulesDir, entry);
    try {
      const stat = statSync(entryPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const manifestPath = join(entryPath, 'module.json');
    const manifest = readManifestFile(manifestPath);
    if (manifest && manifest.id) {
      discovered.push({ id: manifest.id, dir: entryPath, manifestPath });
    }
  }

  return discovered;
}

/**
 * Detects duplicate module IDs among discovered modules.
 * Returns a map of duplicate IDs to their conflicting paths.
 *
 * @param modules - Array of discovered modules
 * @returns Map of duplicate IDs to arrays of conflicting directory paths
 */
export function findDuplicateIds(
  modules: Array<{ id: string; dir: string }>
): Map<string, string[]> {
  const idMap = new Map<string, string[]>();

  for (const mod of modules) {
    const existing = idMap.get(mod.id);
    if (existing) {
      existing.push(mod.dir);
    } else {
      idMap.set(mod.id, [mod.dir]);
    }
  }

  const duplicates = new Map<string, string[]>();
  for (const [id, paths] of idMap) {
    if (paths.length > 1) {
      duplicates.set(id, paths);
    }
  }

  return duplicates;
}

/**
 * Resolves a module by path. The input is treated as a filesystem path
 * (relative or absolute) and resolved to a module directory containing
 * a valid module.json.
 *
 * @param pathInput - A relative or absolute path to a module directory
 * @returns The resolved module with manifest and directory info
 * @throws {ManifestError} If the resolved path does not contain a valid module.json
 */
export function resolveModuleByPath(pathInput: string): ResolvedModule {
  const resolvedDir = resolve(pathInput);
  const manifestPath = join(resolvedDir, 'module.json');

  const manifest = readManifestFile(manifestPath);
  if (!manifest) {
    throw new ManifestError(
      `No valid module.json found at path: ${resolvedDir}`,
      `Ensure the directory contains a valid module.json file`
    );
  }

  return { manifest, dir: resolvedDir, manifestPath };
}

/**
 * Resolves a module by its ID within the Module_Root.
 *
 * Search strategy (ordered):
 * 1. Exact directory name match: {moduleRoot}/modules/{moduleId}/module.json
 * 2. Scan immediate subdirectories of {moduleRoot}/modules/ for module.json with matching id field
 *
 * @param moduleId - The module ID to search for (case-sensitive)
 * @param moduleRoot - Absolute path to the Module_Root directory
 * @returns The resolved module with manifest and directory info
 * @throws {McpxError} If duplicate IDs are found
 * @throws {McpxError} If no module matching the ID is found
 */
export function resolveModuleById(moduleId: string, moduleRoot: string): ResolvedModule {
  // Step 1: Exact directory name match
  const exactDir = join(moduleRoot, 'modules', moduleId);
  const exactManifestPath = join(exactDir, 'module.json');

  if (existsSync(exactManifestPath)) {
    // Important: if module.json exists but is invalid JSON, this is a manifest error,
    // not "module not found". We parse explicitly here to preserve correct exit codes.
    const raw = readFileSync(exactManifestPath, 'utf-8');
    let parsed: ModuleManifest;
    try {
      parsed = JSON.parse(raw) as ModuleManifest;
    } catch (err: unknown) {
      throw new ManifestError(
        `Invalid JSON in ${exactManifestPath}: ${(err as Error).message}`,
        'Fix the JSON syntax in your module.json file',
      );
    }
    const validation = validateManifest(parsed);
    if (!validation.valid) {
      const msgs = validation.errors.map((e) => `  - ${e.field}: ${e.message}`).join('\n');
      throw new ManifestError(
        `Manifest validation failed in ${exactManifestPath}:\n${msgs}`,
        'Fix required fields and types in your module.json file',
      );
    }

    return { manifest: validation.manifest!, dir: exactDir, manifestPath: exactManifestPath };
  }

  // Step 2: Scan immediate subdirectories for matching id field
  const allModules = discoverAllModules(moduleRoot);

  // Check for duplicate IDs before resolving
  const duplicates = findDuplicateIds(allModules);
  if (duplicates.has(moduleId)) {
    const conflictingPaths = duplicates.get(moduleId)!;
    throw new McpxError(
      'manifest',
      `Duplicate module ID "${moduleId}" found in multiple locations:\n${conflictingPaths.map(p => `  - ${p}`).join('\n')}`,
      `Rename one of the conflicting modules to use a unique ID`
    );
  }

  const match = allModules.find(m => m.id === moduleId);
  if (match) {
    const manifest = readManifestFile(match.manifestPath);
    if (manifest) {
      return { manifest, dir: match.dir, manifestPath: match.manifestPath };
    }
  }

  // No match found — report error with discovered module IDs
  const discoveredIds = allModules.map(m => m.id);
  const idList = discoveredIds.length > 0
    ? `Available modules:\n${discoveredIds.map(id => `  - ${id}`).join('\n')}`
    : `No modules found in ${join(moduleRoot, 'modules')}`;

  throw new McpxError(
    'general',
    `Module "${moduleId}" not found.\n${idList}`,
    `Check the module ID or use "mcpx list" to see available modules`
  );
}

/**
 * Resolves a module by ID or path.
 *
 * If the input contains `/` or `.`, it is treated as a filesystem path.
 * Otherwise, it is treated as a module ID and searched within the Module_Root.
 *
 * @param input - A module ID or filesystem path
 * @param moduleRoot - Absolute path to the Module_Root directory
 * @returns The resolved module with manifest and directory info
 * @throws {McpxError} If the module cannot be found or resolved
 * @throws {ManifestError} If a path is provided but contains no valid module.json
 */
export function resolveModule(input: string, moduleRoot: string): ResolvedModule {
  if (isPathInput(input)) {
    return resolveModuleByPath(input);
  }
  return resolveModuleById(input, moduleRoot);
}
