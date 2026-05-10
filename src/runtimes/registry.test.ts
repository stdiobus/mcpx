/**
 * Tests for the runtime registry and install suggestion utilities.
 *
 * @see Requirement 18.1 — Platform-specific install suggestions
 * @see Requirement 10.6 — Runtime_Plugin architecture
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { RuntimePlugin, RuntimeCheck, ExecDescriptor } from './plugin.js';
import type { ResolvedModule } from '../core/manifest.js';

// Mock node:os platform for install suggestion tests
jest.unstable_mockModule('node:os', () => ({
  platform: jest.fn(() => 'darwin'),
}));

// Mock child_process for checkToolAvailable tests
jest.unstable_mockModule('node:child_process', () => ({
  spawnSync: jest.fn(),
}));

const { platform } = await import('node:os');
const { spawnSync } = await import('node:child_process');
const { getInstallSuggestion, getPlugin, getAllPlugins, registerPlugin } = await import('./registry.js');
const { checkToolAvailable } = await import('./check-tool.js');

const mockedPlatform = jest.mocked(platform);
const mockedSpawnSync = jest.mocked(spawnSync);

describe('getInstallSuggestion', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('macOS (darwin)', () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue('darwin');
    });

    it('returns brew install suggestion for node', () => {
      const suggestion = getInstallSuggestion('node');
      expect(suggestion).toContain('https://nodejs.org');
      expect(suggestion).toContain('brew install node');
      expect(suggestion).toContain('Install Node.js');
    });

    it('returns brew install suggestion for python3', () => {
      const suggestion = getInstallSuggestion('python3');
      expect(suggestion).toContain('https://python.org');
      expect(suggestion).toContain('brew install python3');
      expect(suggestion).toContain('Install Python');
    });

    it('returns brew install suggestion for go', () => {
      const suggestion = getInstallSuggestion('go');
      expect(suggestion).toContain('https://go.dev');
      expect(suggestion).toContain('brew install go');
      expect(suggestion).toContain('Install Go');
    });

    it('returns rustup suggestion for cargo', () => {
      const suggestion = getInstallSuggestion('cargo');
      expect(suggestion).toContain('https://rustup.rs');
      expect(suggestion).toContain('Install Rust');
    });

    it('returns docker install suggestion', () => {
      const suggestion = getInstallSuggestion('docker');
      expect(suggestion).toContain('https://docker.com/get-started');
      expect(suggestion).toContain('brew install --cask docker');
      expect(suggestion).toContain('Install Docker');
    });

    it('returns uv install suggestion', () => {
      const suggestion = getInstallSuggestion('uv');
      expect(suggestion).toContain('https://docs.astral.sh/uv');
      expect(suggestion).toContain('brew install uv');
      expect(suggestion).toContain('Install uv');
    });
  });

  describe('Linux', () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue('linux');
    });

    it('returns apt install suggestion for node', () => {
      const suggestion = getInstallSuggestion('node');
      expect(suggestion).toContain('sudo apt install nodejs');
    });

    it('returns apt install suggestion for python3', () => {
      const suggestion = getInstallSuggestion('python3');
      expect(suggestion).toContain('sudo apt install python3');
    });

    it('returns apt install suggestion for go', () => {
      const suggestion = getInstallSuggestion('go');
      expect(suggestion).toContain('sudo apt install golang');
    });

    it('returns apt install suggestion for docker', () => {
      const suggestion = getInstallSuggestion('docker');
      expect(suggestion).toContain('sudo apt install docker.io');
    });
  });

  describe('Windows (win32)', () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue('win32');
    });

    it('returns winget install suggestion for node', () => {
      const suggestion = getInstallSuggestion('node');
      expect(suggestion).toContain('winget install OpenJS.NodeJS');
    });

    it('returns winget install suggestion for python3', () => {
      const suggestion = getInstallSuggestion('python3');
      expect(suggestion).toContain('winget install Python.Python.3');
    });

    it('returns winget install suggestion for go', () => {
      const suggestion = getInstallSuggestion('go');
      expect(suggestion).toContain('winget install GoLang.Go');
    });

    it('returns winget install suggestion for docker', () => {
      const suggestion = getInstallSuggestion('docker');
      expect(suggestion).toContain('winget install Docker.DockerDesktop');
    });

    it('returns winget install suggestion for cargo', () => {
      const suggestion = getInstallSuggestion('cargo');
      expect(suggestion).toContain('winget install Rustlang.Rustup');
    });
  });

  describe('unknown tool', () => {
    it('returns generic suggestion for unknown tools', () => {
      const suggestion = getInstallSuggestion('unknown-tool');
      expect(suggestion).toContain('unknown-tool');
      expect(suggestion).toContain('package manager');
    });
  });
});

describe('checkToolAvailable', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns available with version when tool exists', () => {
    mockedSpawnSync.mockReturnValue({
      stdout: 'v18.17.0\n',
      stderr: '',
      status: 0,
      signal: null,
      error: undefined,
      pid: 1234,
      output: ['', 'v18.17.0\n', ''],
    } as any);

    const result = checkToolAvailable('node');
    expect(result.available).toBe(true);
    expect(result.version).toBe('18.17.0');
  });

  it('parses Python version format', () => {
    mockedSpawnSync.mockReturnValue({
      stdout: 'Python 3.11.4\n',
      stderr: '',
      status: 0,
      signal: null,
      error: undefined,
      pid: 1234,
      output: ['', 'Python 3.11.4\n', ''],
    } as any);

    const result = checkToolAvailable('python3');
    expect(result.available).toBe(true);
    expect(result.version).toBe('3.11.4');
  });

  it('parses Go version format', () => {
    mockedSpawnSync.mockReturnValue({
      stdout: 'go version go1.21.0 darwin/arm64\n',
      stderr: '',
      status: 0,
      signal: null,
      error: undefined,
      pid: 1234,
      output: ['', 'go version go1.21.0 darwin/arm64\n', ''],
    } as any);

    const result = checkToolAvailable('go');
    expect(result.available).toBe(true);
    expect(result.version).toBe('1.21.0');
  });

  it('parses Docker version format', () => {
    mockedSpawnSync.mockReturnValue({
      stdout: 'Docker version 24.0.5, build ced0996\n',
      stderr: '',
      status: 0,
      signal: null,
      error: undefined,
      pid: 1234,
      output: ['', 'Docker version 24.0.5, build ced0996\n', ''],
    } as any);

    const result = checkToolAvailable('docker');
    expect(result.available).toBe(true);
    expect(result.version).toBe('24.0.5');
  });

  it('returns unavailable when tool is not found', () => {
    mockedSpawnSync.mockReturnValue({
      stdout: '',
      stderr: '',
      status: null,
      signal: null,
      error: new Error('ENOENT'),
      pid: 0,
      output: ['', '', ''],
    } as any);

    const result = checkToolAvailable('nonexistent');
    expect(result.available).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it('returns unavailable when tool exits with non-zero status', () => {
    mockedSpawnSync.mockReturnValue({
      stdout: '',
      stderr: 'error\n',
      status: 1,
      signal: null,
      error: undefined,
      pid: 1234,
      output: ['', '', 'error\n'],
    } as any);

    const result = checkToolAvailable('broken-tool');
    expect(result.available).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it('parses version from stderr when stdout is empty', () => {
    mockedSpawnSync.mockReturnValue({
      stdout: '',
      stderr: 'cargo 1.72.0 (103a7ff2e 2023-08-15)\n',
      status: 0,
      signal: null,
      error: undefined,
      pid: 1234,
      output: ['', '', 'cargo 1.72.0 (103a7ff2e 2023-08-15)\n'],
    } as any);

    const result = checkToolAvailable('cargo');
    expect(result.available).toBe(true);
    expect(result.version).toBe('1.72.0');
  });
});

describe('plugin registry', () => {
  // Create a mock plugin for testing
  const mockPlugin: RuntimePlugin = {
    name: 'nodejs',
    supportedExtensions: ['.ts', '.js', '.mjs'],
    async checkAvailability(): Promise<RuntimeCheck> {
      return { available: true, tool: 'node', version: '18.17.0' };
    },
    buildCommand(module: ResolvedModule): ExecDescriptor {
      return { command: 'node', args: [module.manifest.entry], cwd: module.dir, env: {} };
    },
  };

  const mockPlugin2: RuntimePlugin = {
    name: 'python',
    supportedExtensions: ['.py'],
    async checkAvailability(): Promise<RuntimeCheck> {
      return { available: true, tool: 'python3', version: '3.11.4' };
    },
    buildCommand(module: ResolvedModule): ExecDescriptor {
      return { command: 'python3', args: [module.manifest.entry], cwd: module.dir, env: {} };
    },
  };

  beforeEach(() => {
    // Register test plugins
    registerPlugin('nodejs', mockPlugin);
    registerPlugin('python', mockPlugin2);
  });

  it('getPlugin returns the registered plugin for a runtime', () => {
    const plugin = getPlugin('nodejs');
    expect(plugin).toBe(mockPlugin);
    expect(plugin.name).toBe('nodejs');
  });

  it('getPlugin throws for unregistered runtime', () => {
    expect(() => getPlugin('go')).toThrow('No plugin registered for runtime: go');
  });

  it('getAllPlugins returns all registered plugins', () => {
    const plugins = getAllPlugins();
    expect(plugins.length).toBeGreaterThanOrEqual(2);
    expect(plugins).toContain(mockPlugin);
    expect(plugins).toContain(mockPlugin2);
  });

  it('registerPlugin overwrites existing registration', () => {
    const newPlugin: RuntimePlugin = {
      name: 'nodejs-v2',
      async checkAvailability(): Promise<RuntimeCheck> {
        return { available: true, tool: 'node', version: '20.0.0' };
      },
      buildCommand(module: ResolvedModule): ExecDescriptor {
        return { command: 'node', args: [module.manifest.entry], cwd: module.dir, env: {} };
      },
    };

    registerPlugin('nodejs', newPlugin);
    const plugin = getPlugin('nodejs');
    expect(plugin).toBe(newPlugin);
    expect(plugin.name).toBe('nodejs-v2');
  });
});
