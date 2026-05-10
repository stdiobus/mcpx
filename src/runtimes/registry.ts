/**
 * Runtime plugin registry and platform-specific install suggestions.
 *
 * Provides a central registry for all runtime plugins and utility functions
 * for generating platform-appropriate install suggestions when tools are missing.
 *
 * @module runtimes/registry
 * @see Requirement 18.1 — Platform-specific install suggestions
 * @see Requirement 10.6 — Runtime_Plugin architecture
 */

import { platform } from 'node:os';
import type { Runtime } from '../core/manifest.js';
import type { RuntimePlugin } from './plugin.js';

/**
 * Platform-specific install suggestion templates.
 *
 * Each tool maps to an object with platform-specific install commands
 * and a universal URL fallback.
 */
interface InstallInfo {
  /** URL for manual download/install. */
  url: string;

  /** macOS install command (typically brew). */
  darwin?: string;

  /** Linux install command (typically apt). */
  linux?: string;

  /** Windows install command (typically winget or choco). */
  win32?: string;
}

/**
 * Known tool install information keyed by tool binary name.
 */
const INSTALL_INFO: Record<string, InstallInfo> = {
  node: {
    url: 'https://nodejs.org',
    darwin: 'brew install node',
    linux: 'sudo apt install nodejs',
    win32: 'winget install OpenJS.NodeJS',
  },
  npx: {
    url: 'https://nodejs.org',
    darwin: 'brew install node',
    linux: 'sudo apt install nodejs',
    win32: 'winget install OpenJS.NodeJS',
  },
  python3: {
    url: 'https://python.org',
    darwin: 'brew install python3',
    linux: 'sudo apt install python3',
    win32: 'winget install Python.Python.3',
  },
  python: {
    url: 'https://python.org',
    darwin: 'brew install python3',
    linux: 'sudo apt install python3',
    win32: 'winget install Python.Python.3',
  },
  go: {
    url: 'https://go.dev',
    darwin: 'brew install go',
    linux: 'sudo apt install golang',
    win32: 'winget install GoLang.Go',
  },
  cargo: {
    url: 'https://rustup.rs',
    darwin: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh',
    linux: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh',
    win32: 'winget install Rustlang.Rustup',
  },
  rustc: {
    url: 'https://rustup.rs',
    darwin: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh',
    linux: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh',
    win32: 'winget install Rustlang.Rustup',
  },
  docker: {
    url: 'https://docker.com/get-started',
    darwin: 'brew install --cask docker',
    linux: 'sudo apt install docker.io',
    win32: 'winget install Docker.DockerDesktop',
  },
  uv: {
    url: 'https://docs.astral.sh/uv',
    darwin: 'brew install uv',
    linux: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
    win32: 'winget install astral-sh.uv',
  },
};

/**
 * Get a platform-specific install suggestion for a tool.
 *
 * Returns a human-readable string with the install URL and a
 * platform-appropriate package manager command.
 *
 * @param tool - The tool binary name (e.g., "node", "python3", "go").
 * @returns A string with install instructions appropriate for the current platform.
 *
 * @example
 * ```typescript
 * // On macOS:
 * getInstallSuggestion('node')
 * // → "Install Node.js: https://nodejs.org or run: brew install node"
 *
 * // On Linux:
 * getInstallSuggestion('python3')
 * // → "Install Python: https://python.org or run: sudo apt install python3"
 * ```
 */
export function getInstallSuggestion(tool: string): string {
  const info = INSTALL_INFO[tool];

  if (!info) {
    return `Install ${tool}: check your system package manager`;
  }

  const currentPlatform = platform();
  const platformCommand = getPlatformCommand(info, currentPlatform);
  const label = getToolLabel(tool);

  if (platformCommand) {
    return `Install ${label}: ${info.url} or run: ${platformCommand}`;
  }

  return `Install ${label}: ${info.url}`;
}

/**
 * Get the platform-specific command from install info.
 */
function getPlatformCommand(info: InstallInfo, currentPlatform: string): string | undefined {
  switch (currentPlatform) {
    case 'darwin':
      return info.darwin;
    case 'linux':
      return info.linux;
    case 'win32':
      return info.win32;
    default:
      return undefined;
  }
}

/**
 * Get a human-readable label for a tool.
 */
function getToolLabel(tool: string): string {
  switch (tool) {
    case 'node':
    case 'npx':
      return 'Node.js';
    case 'python3':
    case 'python':
      return 'Python';
    case 'go':
      return 'Go';
    case 'cargo':
    case 'rustc':
      return 'Rust';
    case 'docker':
      return 'Docker';
    case 'uv':
      return 'uv';
    default:
      return tool;
  }
}

/**
 * Register all 6 built-in runtime plugins.
 *
 * Imports and registers nodejs, python, go, rust, shell, and docker plugins.
 * This must be called once at startup before any command dispatch.
 *
 * @see Requirement 10.6 — Runtime_Plugin architecture
 */
export async function registerAllPlugins(): Promise<void> {
  const [
    { NodejsPlugin },
    { PythonPlugin },
    { GoPlugin },
    { RustPlugin },
    { ShellPlugin },
    { DockerPlugin },
  ] = await Promise.all([
    import('./nodejs.js'),
    import('./python.js'),
    import('./go.js'),
    import('./rust.js'),
    import('./shell.js'),
    import('./docker.js'),
  ]);

  registerPlugin('nodejs', new NodejsPlugin());
  registerPlugin('python', new PythonPlugin());
  registerPlugin('go', new GoPlugin());
  registerPlugin('rust', new RustPlugin());
  registerPlugin('shell', new ShellPlugin());
  registerPlugin('docker', new DockerPlugin());
}

/**
 * Internal registry of runtime plugins.
 * Plugins are registered lazily to avoid circular imports.
 */
const pluginRegistry = new Map<Runtime, RuntimePlugin>();

/**
 * Register a runtime plugin in the registry.
 *
 * @param runtime - The runtime identifier.
 * @param plugin - The plugin instance to register.
 */
export function registerPlugin(runtime: Runtime, plugin: RuntimePlugin): void {
  pluginRegistry.set(runtime, plugin);
}

/**
 * Get the plugin for a specific runtime.
 *
 * @param runtime - The runtime identifier (e.g., 'nodejs', 'python').
 * @returns The registered plugin for the runtime.
 * @throws Error if no plugin is registered for the given runtime.
 */
export function getPlugin(runtime: Runtime): RuntimePlugin {
  const plugin = pluginRegistry.get(runtime);
  if (!plugin) {
    throw new Error(`No plugin registered for runtime: ${runtime}`);
  }
  return plugin;
}

/**
 * Get all registered runtime plugins.
 *
 * @returns An array of all registered plugin instances.
 */
export function getAllPlugins(): RuntimePlugin[] {
  return Array.from(pluginRegistry.values());
}
