/**
 * `mcpx run <module_id>` command
 *
 * Resolves a module by ID or path, loads environment variables,
 * selects the appropriate runtime, and executes the module process.
 *
 * Supports early exit detection: if the module process exits within
 * 2 seconds with a non-zero code, captures up to 4096 bytes of stderr
 * for diagnostic display.
 *
 * @module cli/commands/run
 * @see Requirement 9.4 — Resolve module, load env, exec
 * @see Requirement 18.5 — Early exit detection with stderr capture
 */

export { execModule, execModuleWithEarlyExitDetection } from '../../platform/exec.js';
export type { ModuleInfo } from '../../platform/exec.js';
