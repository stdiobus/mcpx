/**
 * `mcpx list` command
 *
 * Discovers and displays all modules in the Module_Root with their
 * ID, name, runtime, and status (ready/misconfigured/unavailable).
 *
 * When no modules are found, displays a getting-started message with
 * the Module_Root path and instructions for creating a module.
 *
 * @module cli/commands/list
 * @see Requirement 10.2 — Display all discovered modules with status
 * @see Requirement 11.5 — Support --json flag for JSON output
 * @see Requirement 18.3 — Getting-started message when no modules found
 */

import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import { Logger } from '../../core/logger.js';
import { validateManifest, type ModuleManifest, type Runtime } from '../../core/manifest.js';
import { getPlugin } from '../../runtimes/registry.js';
import { displayNoModulesMessage } from '../../core/degradation.js';

/**
 * Module status entry for the list command output.
 */
export interface ModuleStatus {
  id: string;
  name: string;
  runtime: string;
  status: 'ready' | 'misconfigured' | 'unavailable';
  issues?: string[];
}

/**
 * Options for the listCommand function.
 */
export interface ListCommandOptions {
  root: string;
  json: boolean;
  verbose: boolean;
}

/**
 * Discover all modules and determine their status.
 *
 * For each module found in {root}/modules/:
 * - Validates the manifest (misconfigured if invalid)
 * - Checks runtime availability (unavailable if runtime tool missing)
 * - Returns 'ready' if both pass
 *
 * @param root - The Module_Root directory path
 * @param logger - Logger instance for diagnostics
 * @returns Array of module statuses
 */
export async function getModuleStatuses(root: string, logger: Logger): Promise<ModuleStatus[]> {
  const modulesDir = join(root, 'modules');
  if (!existsSync(modulesDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(modulesDir);
  } catch {
    return [];
  }

  const statuses: ModuleStatus[] = [];

  for (const entry of entries) {
    const entryPath = join(modulesDir, entry);
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const manifestPath = join(entryPath, 'module.json');
    if (!existsSync(manifestPath)) continue;

    // Try to parse the manifest
    let rawData: unknown;
    try {
      const content = readFileSync(manifestPath, 'utf-8');
      rawData = JSON.parse(content);
    } catch (err) {
      // Malformed JSON
      statuses.push({
        id: entry,
        name: entry,
        runtime: 'unknown',
        status: 'misconfigured',
        issues: [`Invalid JSON in module.json: ${(err as Error).message}`],
      });
      continue;
    }

    // Validate the manifest
    const validation = validateManifest(rawData);
    if (!validation.valid) {
      const manifest = rawData as Record<string, unknown>;
      statuses.push({
        id: (manifest.id as string) ?? entry,
        name: (manifest.name as string) ?? entry,
        runtime: (manifest.runtime as string) ?? 'unknown',
        status: 'misconfigured',
        issues: validation.errors.map(e => e.message),
      });
      continue;
    }

    const manifest = validation.manifest!;

    // Check runtime availability
    try {
      const plugin = getPlugin(manifest.runtime as Runtime);
      const check = await plugin.checkAvailability();
      if (!check.available) {
        statuses.push({
          id: manifest.id,
          name: manifest.name,
          runtime: manifest.runtime,
          status: 'unavailable',
          issues: [check.suggestion ?? `Runtime "${manifest.runtime}" is not available`],
        });
        continue;
      }
    } catch {
      statuses.push({
        id: manifest.id,
        name: manifest.name,
        runtime: manifest.runtime,
        status: 'unavailable',
        issues: [`No plugin registered for runtime: ${manifest.runtime}`],
      });
      continue;
    }

    statuses.push({
      id: manifest.id,
      name: manifest.name,
      runtime: manifest.runtime,
      status: 'ready',
    });
  }

  return statuses;
}

/**
 * Format module statuses as a human-readable table.
 *
 * @param statuses - Array of module statuses to format
 * @returns Formatted table string
 */
export function formatHumanReadable(statuses: ModuleStatus[]): string {
  if (statuses.length === 0) {
    return 'No modules found.';
  }

  // Calculate column widths
  const headers = { id: 'ID', name: 'NAME', runtime: 'RUNTIME', status: 'STATUS' };
  let idWidth = headers.id.length;
  let nameWidth = headers.name.length;
  let runtimeWidth = headers.runtime.length;
  let statusWidth = headers.status.length;

  for (const s of statuses) {
    idWidth = Math.max(idWidth, s.id.length);
    nameWidth = Math.max(nameWidth, s.name.length);
    runtimeWidth = Math.max(runtimeWidth, s.runtime.length);
    statusWidth = Math.max(statusWidth, s.status.length);
  }

  const pad = (str: string, width: number) => str.padEnd(width);

  const lines: string[] = [];

  // Header
  lines.push(
    `${pad(headers.id, idWidth)}  ${pad(headers.name, nameWidth)}  ${pad(headers.runtime, runtimeWidth)}  ${pad(headers.status, statusWidth)}`
  );

  // Separator
  lines.push(
    `${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(runtimeWidth)}  ${'-'.repeat(statusWidth)}`
  );

  // Data rows
  for (const s of statuses) {
    lines.push(
      `${pad(s.id, idWidth)}  ${pad(s.name, nameWidth)}  ${pad(s.runtime, runtimeWidth)}  ${pad(s.status, statusWidth)}`
    );
  }

  return lines.join('\n');
}

/**
 * Execute the `mcpx list` command.
 *
 * Discovers all modules in the Module_Root and displays them.
 * If no modules are found, shows a getting-started message.
 *
 * @param options - Command options (root, json, verbose)
 * @returns Exit code (always 0)
 */
export async function listCommand(options: ListCommandOptions): Promise<number> {
  const { root, json, verbose } = options;
  const logger = new Logger(verbose);

  const statuses = await getModuleStatuses(root, logger);

  if (statuses.length === 0) {
    if (json) {
      process.stdout.write(JSON.stringify([], null, 2) + '\n');
    }
    displayNoModulesMessage(root, logger);
    return 0;
  }

  if (json) {
    process.stdout.write(JSON.stringify(statuses, null, 2) + '\n');
  } else {
    const output = formatHumanReadable(statuses);
    // Write to stderr (all diagnostic output goes to stderr per R4.2)
    process.stderr.write(`[mcpx] ${output.split('\n').join('\n[mcpx] ')}\n`);
  }

  return 0;
}
