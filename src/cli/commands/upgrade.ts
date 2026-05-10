/**
 * `mcpx upgrade` command
 *
 * Checks for newer versions of installed modules and updates them.
 * When invoked without arguments, checks ALL installed modules.
 * When invoked with a module ID, checks only that specific module.
 *
 * For each module to upgrade:
 * - Reads the local module.json to get the current version
 * - Queries the registry for the latest version
 * - If a newer version is available, removes the old directory and clones the new version
 * - Reports which modules were upgraded (old version → new version)
 *
 * @module cli/commands/upgrade
 * @see Requirement 12.4 — Check for newer versions of all installed modules and update them
 * @see Requirement 12.5 — Update only the specified module to its latest version
 */

import { join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Logger } from '../../core/logger.js';
import { discoverAllModules } from '../../core/resolver.js';
import type { RegistryClient, RegistryEntry } from '../../registry/client.js';
import { HttpRegistryClient } from '../../registry/client.js';
import type { ParsedArgs } from '../parser.js';

/**
 * Result of upgrading a single module.
 */
export interface UpgradeResult {
  /** The module ID. */
  id: string;
  /** Whether the upgrade was performed. */
  upgraded: boolean;
  /** The previous version (before upgrade). */
  previousVersion?: string;
  /** The new version (after upgrade). */
  newVersion?: string;
  /** Error message if upgrade failed. */
  error?: string;
}

/**
 * JSON output structure for the upgrade command.
 */
export interface UpgradeJsonOutput {
  /** Whether the overall operation was successful. */
  success: boolean;
  /** Results for each module checked. */
  results: UpgradeResult[];
  /** Error message if the command itself failed. */
  error?: string;
  /** Suggestion for the user. */
  suggestion?: string;
}

/**
 * Options for the upgradeCommand function.
 */
export interface UpgradeCommandOptions {
  /** The resolved Module_Root directory path. */
  root: string;
  /** Parsed CLI arguments. */
  args: ParsedArgs;
  /** Logger instance for diagnostic output. */
  logger: Logger;
  /** Registry client (injectable for testing). */
  registryClient?: RegistryClient;
}

/**
 * Execute the `mcpx upgrade [module_id]` command.
 *
 * When no module_id is provided, checks all installed modules for updates.
 * When a module_id is provided, checks only that specific module.
 *
 * @param options - Command options
 * @returns Exit code (0 on success, 1 on failure)
 */
export async function upgradeCommand(options: UpgradeCommandOptions): Promise<number> {
  const { root, args, logger, registryClient } = options;
  const json = args.flags.json;
  const moduleId = args.moduleId;
  const client = registryClient ?? new HttpRegistryClient();

  logger.debug('upgrade', moduleId ? `Upgrading module: ${moduleId}` : 'Upgrading all modules');

  // Discover installed modules
  const allModules = discoverAllModules(root);

  if (allModules.length === 0) {
    const error = 'No modules installed';
    const suggestion = 'Use "mcpx install <module_name>" to install a module';

    if (json) {
      writeJsonOutput({ success: false, results: [], error, suggestion });
    } else {
      logger.error(error, suggestion);
    }
    return 1;
  }

  // Filter to specific module if provided
  let modulesToCheck = allModules;
  if (moduleId) {
    modulesToCheck = allModules.filter(m => m.id === moduleId);
    if (modulesToCheck.length === 0) {
      const error = `Module "${moduleId}" is not installed`;
      const suggestion = `Use "mcpx list" to see installed modules or "mcpx install ${moduleId}" to install it`;

      if (json) {
        writeJsonOutput({ success: false, results: [], error, suggestion });
      } else {
        logger.error(error, suggestion);
      }
      return 1;
    }
  }

  const results: UpgradeResult[] = [];
  let hasErrors = false;

  for (const mod of modulesToCheck) {
    const result = await upgradeModule(mod, client, root, logger);
    results.push(result);
    if (result.error) {
      hasErrors = true;
    }
  }

  // Report results
  const upgraded = results.filter(r => r.upgraded);

  if (json) {
    writeJsonOutput({ success: !hasErrors, results });
  } else {
    if (upgraded.length === 0 && !hasErrors) {
      logger.info('All modules are up to date');
    } else {
      for (const r of results) {
        if (r.upgraded) {
          logger.info(`Upgraded "${r.id}": ${r.previousVersion ?? 'unknown'} → ${r.newVersion}`);
        } else if (r.error) {
          logger.error(`Failed to upgrade "${r.id}": ${r.error}`);
        }
      }
    }
  }

  return hasErrors ? 1 : 0;
}

/**
 * Attempt to upgrade a single module.
 *
 * Reads the local version from module.json, queries the registry for the
 * latest version, and if newer, removes the old directory and clones fresh.
 */
async function upgradeModule(
  mod: { id: string; dir: string; manifestPath: string },
  client: RegistryClient,
  root: string,
  logger: Logger,
): Promise<UpgradeResult> {
  // Read local version from module.json
  let localVersion: string | undefined;
  try {
    const content = readFileSync(mod.manifestPath, 'utf-8');
    const manifest = JSON.parse(content);
    localVersion = manifest.version;
  } catch {
    return {
      id: mod.id,
      upgraded: false,
      error: `Failed to read local module.json at ${mod.manifestPath}`,
    };
  }

  // Query registry for latest version
  let entry: RegistryEntry | null;
  try {
    entry = await client.getModule(mod.id);
  } catch (err) {
    return {
      id: mod.id,
      upgraded: false,
      error: `Failed to query registry: ${(err as Error).message}`,
    };
  }

  if (!entry) {
    logger.debug('upgrade', `Module "${mod.id}" not found in registry, skipping`);
    return {
      id: mod.id,
      upgraded: false,
    };
  }

  // Compare versions
  const remoteVersion = entry.latestVersion;
  if (localVersion && localVersion === remoteVersion) {
    logger.debug('upgrade', `Module "${mod.id}" is already at latest version (${localVersion})`);
    return {
      id: mod.id,
      upgraded: false,
      previousVersion: localVersion,
      newVersion: remoteVersion,
    };
  }

  // If no local version, or versions differ, perform upgrade
  logger.debug('upgrade', `Upgrading "${mod.id}" from ${localVersion ?? 'unknown'} to ${remoteVersion}`);

  // Remove old directory
  try {
    rmSync(mod.dir, { recursive: true, force: true });
  } catch (err) {
    return {
      id: mod.id,
      upgraded: false,
      previousVersion: localVersion,
      error: `Failed to remove old module directory: ${(err as Error).message}`,
    };
  }

  // Clone new version
  const targetDir = join(root, 'modules', mod.id);
  try {
    execSync(`git clone "${entry.gitUrl}" "${targetDir}"`, {
      stdio: 'pipe',
    });
  } catch (err) {
    return {
      id: mod.id,
      upgraded: false,
      previousVersion: localVersion,
      error: `Failed to clone from ${entry.gitUrl}: ${(err as Error).message}`,
    };
  }

  return {
    id: mod.id,
    upgraded: true,
    previousVersion: localVersion,
    newVersion: remoteVersion,
  };
}

/**
 * Write JSON output to stdout.
 */
function writeJsonOutput(output: UpgradeJsonOutput): void {
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
