/**
 * Utility for checking runtime tool availability.
 *
 * Provides a cross-platform mechanism to detect whether a CLI tool
 * is installed and accessible on the system PATH, along with its version.
 *
 * @module runtimes/check-tool
 * @see Requirement 18.1 — Report missing tools with install suggestions
 */

import { spawnSync } from 'node:child_process';

/**
 * Result of checking whether a tool is available on the system.
 */
export interface ToolCheckResult {
  /** Whether the tool was found and executed successfully. */
  available: boolean;

  /** The detected version string, if available. */
  version?: string;
}

/**
 * Check whether a CLI tool is available on the system PATH.
 *
 * Runs `<tool> --version` and parses the output to extract a version string.
 * Returns availability status and version if detected.
 *
 * @param tool - The tool binary name to check (e.g., "node", "python3", "go").
 * @returns An object indicating availability and optional version.
 */
export function checkToolAvailable(tool: string): ToolCheckResult {
  try {
    const result = spawnSync(tool, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.error || result.status !== 0) {
      return { available: false };
    }

    const output = (result.stdout || result.stderr || '').trim();
    const version = parseVersion(output);

    return { available: true, version };
  } catch {
    return { available: false };
  }
}

/**
 * Parse a version string from tool output.
 *
 * Handles common version output formats:
 * - "v18.17.0" (node)
 * - "Python 3.11.4" (python3)
 * - "go version go1.21.0 darwin/arm64" (go)
 * - "cargo 1.72.0" (cargo)
 * - "Docker version 24.0.5, build ced0996" (docker)
 * - "uv 0.4.0" (uv)
 *
 * @param output - The raw output from `<tool> --version`.
 * @returns The extracted version string, or undefined if not parseable.
 */
function parseVersion(output: string): string | undefined {
  if (!output) return undefined;

  // Match common version patterns: semver-like (x.y.z), or vX.Y.Z
  const match = output.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/);
  return match ? match[1] : undefined;
}
