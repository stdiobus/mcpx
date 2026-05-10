/**
 * Docker runtime plugin for mcpx.
 *
 * Handles launching Docker-based MCP modules using `docker run --rm -i`.
 * Passes all resolved environment variables using `-e` flags.
 * Sets working directory to the module's directory.
 *
 * @module runtimes/docker
 * @see Requirement 8.6 — Docker executes with `docker run --rm -i` using image from entry
 * @see Requirement 8.7 — Pass all resolved env vars using `-e` flags
 * @see Requirement 8.3 — Working directory set to module directory
 * @see Requirement 8.8 — Report error if `docker` is not available
 */

import { execFileSync } from 'node:child_process';
import type { RuntimePlugin, RuntimeCheck, ExecDescriptor } from './plugin.js';
import type { ResolvedModule } from '../core/manifest.js';
import { RuntimeError } from '../core/errors.js';

/**
 * Docker runtime plugin.
 *
 * Launch strategy:
 * - Use `docker run --rm -i <image>` where image comes from manifest.entry.
 * - Build `-e KEY=VALUE` flags for all env vars in the module's resolved env.
 *
 * Availability check verifies `docker` is in PATH.
 */
export class DockerPlugin implements RuntimePlugin {
  readonly name = 'docker';

  /**
   * Check if the `docker` tool is available on the system.
   */
  async checkAvailability(): Promise<RuntimeCheck> {
    try {
      const output = execFileSync('docker', ['--version'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      const version = output.trim().replace(/^Docker version /, '');
      return { available: true, tool: 'docker', version };
    } catch {
      return {
        available: false,
        tool: 'docker',
        suggestion: 'Install Docker: https://docs.docker.com/get-docker/',
      };
    }
  }

  /**
   * Build the execution descriptor for a Docker module.
   *
   * Uses `docker run --rm -i` with the image name from manifest.entry.
   * Passes all resolved environment variables as `-e KEY=VALUE` flags.
   *
   * @param module - The resolved module with manifest and directory path.
   * @param resolvedEnv - The fully resolved environment variables to pass to the container.
   * @returns The execution descriptor for process replacement.
   */
  buildCommand(module: ResolvedModule, resolvedEnv?: Record<string, string>): ExecDescriptor {
    const { manifest, dir } = module;
    const image = manifest.entry;
    const moduleArgs = manifest.args ?? [];

    // Build docker run command with env flags
    const args: string[] = ['run', '--rm', '-i'];

    // Pass all resolved env vars using -e flags
    const envVars = resolvedEnv ?? {};
    for (const [key, value] of Object.entries(envVars)) {
      args.push('-e', `${key}=${value}`);
    }

    // Add image name and any module args
    args.push(image, ...moduleArgs);

    return {
      command: 'docker',
      args,
      cwd: dir,
      env: {},
    };
  }
}
