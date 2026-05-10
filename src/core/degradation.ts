/**
 * Graceful degradation messages for mcpx.
 *
 * Provides helpful guidance when the user's environment is partially
 * configured, enabling incremental issue resolution.
 *
 * @module core/degradation
 * @see Requirement 18.2 — Display unresolved variable names and expected .env file path
 * @see Requirement 18.3 — Display getting-started message when no modules found
 * @see Requirement 18.5 — Capture stderr on early exit (within 2s)
 */

import { join } from 'node:path';
import { Logger } from './logger.js';

/**
 * Display a getting-started message when no modules are found in the Module_Root.
 *
 * Shows the Module_Root path and minimum steps to create a module.json manifest.
 *
 * @param moduleRoot - The resolved Module_Root directory path
 * @param logger - Logger instance for stderr output
 *
 * @see Requirement 18.3 — Getting-started message with Module_Root path
 */
export function displayNoModulesMessage(moduleRoot: string, logger: Logger): void {
  const modulesDir = join(moduleRoot, 'modules');

  logger.info('No modules found.');
  logger.info('');
  logger.info('Getting started:');
  logger.info(`  Module root: ${moduleRoot}`);
  logger.info(`  Modules dir: ${modulesDir}`);
  logger.info('');
  logger.info('  To create a module:');
  logger.info(`    1. Create a directory: mkdir -p ${modulesDir}/my-module`);
  logger.info(`    2. Add a manifest:     ${modulesDir}/my-module/module.json`);
  logger.info('');
  logger.info('  Minimum module.json:');
  logger.info('    {');
  logger.info('      "id": "my-module",');
  logger.info('      "name": "My Module",');
  logger.info('      "runtime": "nodejs",');
  logger.info('      "entry": "index.ts"');
  logger.info('    }');
}

/**
 * Display a message when .env is missing but the module requires environment variables.
 *
 * Lists the unresolved variable names and the expected .env file path.
 *
 * @param unresolvedVars - Array of variable names that could not be resolved
 * @param envFilePath - The expected .env file path where variables should be defined
 * @param logger - Logger instance for stderr output
 *
 * @see Requirement 18.2 — Display unresolved variable names and expected .env file path
 */
export function displayMissingEnvMessage(
  unresolvedVars: string[],
  envFilePath: string,
  logger: Logger,
): void {
  logger.error(
    `Missing environment variables: ${unresolvedVars.join(', ')}`,
    `Add them to ${envFilePath}`,
  );
  logger.info('');
  logger.info('  Expected .env file:');
  logger.info(`    ${envFilePath}`);
  logger.info('');
  logger.info('  Add the following variables:');
  for (const varName of unresolvedVars) {
    logger.info(`    ${varName}=<value>`);
  }
}

/**
 * Maximum bytes of stderr to capture from an early-exiting module process.
 */
export const EARLY_EXIT_STDERR_MAX_BYTES = 4096;

/**
 * Threshold in milliseconds — if a module exits within this time, it's
 * considered an early exit and stderr is captured for diagnostics.
 */
export const EARLY_EXIT_THRESHOLD_MS = 2000;

/**
 * Display early exit diagnostic information when a module process exits
 * within 2 seconds of launch.
 *
 * Shows the module ID, runtime, entry file, and captured stderr output
 * to help the user debug startup failures.
 *
 * @param moduleId - The module's ID
 * @param runtime - The runtime used to launch the module
 * @param entry - The entry file path from the manifest
 * @param exitCode - The process exit code
 * @param stderrOutput - Captured stderr output (up to 4096 bytes)
 * @param logger - Logger instance for stderr output
 *
 * @see Requirement 18.5 — Capture up to 4096 bytes of stderr on early exit
 */
export function displayEarlyExitMessage(
  moduleId: string,
  runtime: string,
  entry: string,
  exitCode: number,
  stderrOutput: string,
  logger: Logger,
): void {
  logger.error(
    `Module "${moduleId}" exited with code ${exitCode} shortly after launch`,
  );
  logger.info(`  Runtime: ${runtime}`);
  logger.info(`  Entry:   ${entry}`);

  if (stderrOutput.length > 0) {
    logger.info('');
    logger.info('  Module stderr output:');
    // Indent each line of stderr for readability
    const lines = stderrOutput.split('\n');
    for (const line of lines) {
      if (line.length > 0) {
        logger.info(`    ${line}`);
      }
    }
  }
}
