/**
 * `mcpx install <module_name>` command
 *
 * Queries the registry for a module by name, downloads it from its
 * git URL, and places it in the Module_Root/modules/ directory.
 *
 * Error cases:
 * - Module not found in registry → suggest `mcpx search`
 * - Module already installed locally → suggest `mcpx upgrade`
 *
 * @module cli/commands/install
 * @see Requirement 12.1 — Download module from Registry and place in Module_Root
 * @see Requirement 12.9 — Report error if module not found, suggest mcpx search
 * @see Requirement 12.11 — Report if already installed, suggest mcpx upgrade
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Logger } from '../../core/logger.js';
import { McpxError } from '../../core/errors.js';
import type { RegistryClient, RegistryEntry } from '../../registry/client.js';
import { HttpRegistryClient } from '../../registry/client.js';
import type { ParsedArgs } from '../parser.js';

/**
 * JSON output structure for the install command.
 */
export interface InstallJsonOutput {
  /** Whether the installation was successful. */
  success: boolean;
  /** The module ID that was installed. */
  moduleId: string;
  /** The directory where the module was installed. */
  installPath?: string;
  /** Error message if installation failed. */
  error?: string;
  /** Suggestion for the user. */
  suggestion?: string;
}

/**
 * Options for the installCommand function.
 */
export interface InstallCommandOptions {
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
 * Execute the `mcpx install <module_name>` command.
 *
 * Queries the registry for the specified module, checks if it's already
 * installed locally, and if not, clones it from the git URL into the
 * Module_Root/modules/ directory.
 *
 * @param options - Command options
 * @returns Exit code (0 on success, 1 on failure)
 */
export async function installCommand(options: InstallCommandOptions): Promise<number> {
  const { root, args, logger, registryClient } = options;
  const json = args.flags.json;
  const moduleId = args.moduleId;

  // Validate that a module name was provided
  if (!moduleId) {
    const error = 'No module name specified for install command';
    const suggestion = 'Usage: mcpx install <module_name>';

    if (json) {
      writeJsonOutput({ success: false, moduleId: '', error, suggestion });
    } else {
      logger.error(error, suggestion);
    }
    return 1;
  }

  logger.debug('install', `Installing module: ${moduleId}`);

  // Check if module is already installed locally
  const modulesDir = join(root, 'modules');
  const targetDir = join(modulesDir, moduleId);

  if (existsSync(targetDir)) {
    const error = `Module "${moduleId}" is already installed at ${targetDir}`;
    const suggestion = `Use "mcpx upgrade ${moduleId}" to update it`;

    if (json) {
      writeJsonOutput({ success: false, moduleId, error, suggestion });
    } else {
      logger.error(error, suggestion);
    }
    return 1;
  }

  // Query the registry for the module
  const client = registryClient ?? new HttpRegistryClient();
  let entry: RegistryEntry | null;

  try {
    entry = await client.getModule(moduleId);
  } catch (err) {
    const error = `Failed to query registry: ${(err as Error).message}`;
    const suggestion = 'Check your network connection and try again';

    if (json) {
      writeJsonOutput({ success: false, moduleId, error, suggestion });
    } else {
      logger.error(error, suggestion);
    }
    return 1;
  }

  if (!entry) {
    const error = `Module "${moduleId}" not found in the registry`;
    const suggestion = `Use "mcpx search ${moduleId}" to discover available modules`;

    if (json) {
      writeJsonOutput({ success: false, moduleId, error, suggestion });
    } else {
      logger.error(error, suggestion);
    }
    return 1;
  }

  logger.debug('install', `Found module in registry: ${entry.name} (${entry.latestVersion})`);
  logger.debug('install', `Git URL: ${entry.gitUrl}`);

  // Clone the module from git
  try {
    execSync(`git clone "${entry.gitUrl}" "${targetDir}"`, {
      stdio: 'pipe',
    });
  } catch (err) {
    const error = `Failed to clone module from ${entry.gitUrl}: ${(err as Error).message}`;
    const suggestion = 'Ensure git is installed and the repository URL is accessible';

    if (json) {
      writeJsonOutput({ success: false, moduleId, error, suggestion });
    } else {
      logger.error(error, suggestion);
    }
    return 1;
  }

  // Success
  if (json) {
    writeJsonOutput({ success: true, moduleId, installPath: targetDir });
  } else {
    logger.info(`Installed "${moduleId}" to ${targetDir}`);
  }

  return 0;
}

/**
 * Write JSON output to stdout.
 */
function writeJsonOutput(output: InstallJsonOutput): void {
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
