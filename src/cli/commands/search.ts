/**
 * `mcpx search <query>` command
 *
 * Queries the remote registry with substring matching against module
 * name and description, displaying up to 50 results.
 *
 * Results are displayed to stderr in human-readable format (id, name,
 * description) or to stdout as JSON when --json flag is used.
 *
 * @module cli/commands/search
 * @see Requirement 12.8 — Search registry with substring matching, display up to 50 results
 */

import { Logger } from '../../core/logger.js';
import { HttpRegistryClient, type RegistryEntry } from '../../registry/client.js';

/**
 * Options for the searchCommand function.
 */
export interface SearchCommandOptions {
  /** The search query string. */
  query: string;
  /** Output results as JSON to stdout. */
  json: boolean;
  /** Enable verbose diagnostic output. */
  verbose: boolean;
}

/**
 * Format search results as a human-readable table.
 *
 * Displays id, name, and description for each result.
 *
 * @param results - Array of registry entries to format
 * @returns Formatted table string
 */
export function formatSearchResults(results: RegistryEntry[]): string {
  if (results.length === 0) {
    return '';
  }

  // Calculate column widths
  const headers = { id: 'ID', name: 'NAME', description: 'DESCRIPTION' };
  let idWidth = headers.id.length;
  let nameWidth = headers.name.length;

  for (const r of results) {
    idWidth = Math.max(idWidth, r.id.length);
    nameWidth = Math.max(nameWidth, r.name.length);
  }

  // Cap widths for readability
  idWidth = Math.min(idWidth, 40);
  nameWidth = Math.min(nameWidth, 40);

  const pad = (str: string, width: number) => str.slice(0, width).padEnd(width);

  const lines: string[] = [];

  // Header
  lines.push(
    `${pad(headers.id, idWidth)}  ${pad(headers.name, nameWidth)}  ${headers.description}`
  );

  // Separator
  lines.push(
    `${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(headers.description.length)}`
  );

  // Data rows
  for (const r of results) {
    const desc = r.description || '';
    lines.push(
      `${pad(r.id, idWidth)}  ${pad(r.name, nameWidth)}  ${desc}`
    );
  }

  return lines.join('\n');
}

/**
 * Execute the `mcpx search <query>` command.
 *
 * Queries the registry for modules matching the query string using
 * substring matching against name and description. Displays up to
 * 50 results.
 *
 * @param options - Command options (query, json, verbose)
 * @returns Exit code (0 on success, 1 on error)
 */
export async function searchCommand(options: SearchCommandOptions): Promise<number> {
  const { query, json, verbose } = options;
  const logger = new Logger(verbose);

  if (!query || query.trim() === '') {
    logger.error('Search query is required', 'Usage: mcpx search <query>');
    return 1;
  }

  logger.debug('search', `Searching registry for: "${query}"`);

  const client = new HttpRegistryClient();

  let results: RegistryEntry[];
  try {
    results = await client.search(query);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Registry search failed: ${message}`, 'Check your network connection and try again');
    return 1;
  }

  logger.debug('search', `Found ${results.length} result(s)`);

  if (results.length === 0) {
    if (json) {
      process.stdout.write(JSON.stringify([], null, 2) + '\n');
    } else {
      logger.info(`No modules found matching "${query}"`);
    }
    return 0;
  }

  if (json) {
    const output = results.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
    }));
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    const output = formatSearchResults(results);
    process.stderr.write(`[mcpx] ${output.split('\n').join('\n[mcpx] ')}\n`);
  }

  return 0;
}
