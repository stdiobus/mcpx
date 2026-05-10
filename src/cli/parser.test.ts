import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { parseArgs, KNOWN_COMMANDS } from './parser.js';

describe('parseArgs', () => {
  const originalEnv = process.env.MCPX_DEBUG;

  beforeEach(() => {
    delete process.env.MCPX_DEBUG;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MCPX_DEBUG = originalEnv;
    } else {
      delete process.env.MCPX_DEBUG;
    }
  });

  describe('explicit commands', () => {
    it('parses "run <module_id>"', () => {
      const result = parseArgs(['run', 'my-module']);
      expect(result).toEqual({
        command: 'run',
        moduleId: 'my-module',
        extraArgs: [],
        flags: { verbose: false, json: false },
      });
    });

    it('parses "list" command', () => {
      const result = parseArgs(['list']);
      expect(result).toEqual({
        command: 'list',
        moduleId: undefined,
        extraArgs: [],
        flags: { verbose: false, json: false },
      });
    });

    it('parses "doctor" command', () => {
      const result = parseArgs(['doctor']);
      expect(result).toEqual({
        command: 'doctor',
        moduleId: undefined,
        extraArgs: [],
        flags: { verbose: false, json: false },
      });
    });

    it('parses "env <module_id>"', () => {
      const result = parseArgs(['env', 'my-module']);
      expect(result).toEqual({
        command: 'env',
        moduleId: 'my-module',
        extraArgs: [],
        flags: { verbose: false, json: false },
      });
    });

    it('parses v3 stub commands', () => {
      for (const cmd of ['install', 'publish', 'upgrade', 'search'] as const) {
        const result = parseArgs([cmd, 'some-arg']);
        expect(result.command).toBe(cmd);
        expect(result.moduleId).toBe('some-arg');
      }
    });
  });

  describe('implicit run shorthand', () => {
    it('treats unknown first arg as module ID for implicit run', () => {
      const result = parseArgs(['my-module']);
      expect(result).toEqual({
        command: 'run',
        moduleId: 'my-module',
        extraArgs: [],
        flags: { verbose: false, json: false },
      });
    });

    it('handles module ID with path-like characters', () => {
      const result = parseArgs(['./local-module']);
      expect(result).toEqual({
        command: 'run',
        moduleId: './local-module',
        extraArgs: [],
        flags: { verbose: false, json: false },
      });
    });
  });

  describe('subcommand/module-ID collision (R14.6)', () => {
    it('interprets arg matching a known command as the subcommand', () => {
      // If someone has a module named "list", `mcpx list` is the subcommand
      const result = parseArgs(['list']);
      expect(result.command).toBe('list');
      expect(result.moduleId).toBeUndefined();
    });

    it('requires explicit run to launch a module named after a command', () => {
      // `mcpx run list` explicitly runs a module named "list"
      const result = parseArgs(['run', 'list']);
      expect(result.command).toBe('run');
      expect(result.moduleId).toBe('list');
    });
  });

  describe('flags', () => {
    it('parses --verbose flag', () => {
      const result = parseArgs(['run', 'my-module', '--verbose']);
      expect(result.flags.verbose).toBe(true);
    });

    it('parses --json flag', () => {
      const result = parseArgs(['list', '--json']);
      expect(result.flags.json).toBe(true);
    });

    it('parses both flags together', () => {
      const result = parseArgs(['--verbose', 'doctor', '--json']);
      expect(result.flags.verbose).toBe(true);
      expect(result.flags.json).toBe(true);
      expect(result.command).toBe('doctor');
    });

    it('enables verbose via MCPX_DEBUG=1 env', () => {
      process.env.MCPX_DEBUG = '1';
      const result = parseArgs(['list']);
      expect(result.flags.verbose).toBe(true);
    });

    it('does not enable verbose for MCPX_DEBUG values other than 1', () => {
      process.env.MCPX_DEBUG = 'true';
      const result = parseArgs(['list']);
      expect(result.flags.verbose).toBe(false);
    });

    it('flags before command are handled correctly', () => {
      const result = parseArgs(['--verbose', '--json', 'my-module']);
      expect(result.command).toBe('run');
      expect(result.moduleId).toBe('my-module');
      expect(result.flags.verbose).toBe(true);
      expect(result.flags.json).toBe(true);
    });
  });

  describe('extra arguments (after --)', () => {
    it('captures args after -- separator', () => {
      const result = parseArgs(['run', 'my-module', '--', '--port', '3000']);
      expect(result.extraArgs).toEqual(['--port', '3000']);
    });

    it('handles -- with implicit run', () => {
      const result = parseArgs(['my-module', '--', '--config', 'prod.json']);
      expect(result.command).toBe('run');
      expect(result.moduleId).toBe('my-module');
      expect(result.extraArgs).toEqual(['--config', 'prod.json']);
    });

    it('handles -- with no extra args after it', () => {
      const result = parseArgs(['run', 'my-module', '--']);
      expect(result.extraArgs).toEqual([]);
    });

    it('flags after -- are not parsed as flags', () => {
      const result = parseArgs(['run', 'my-module', '--', '--verbose', '--json']);
      expect(result.flags.verbose).toBe(false);
      expect(result.flags.json).toBe(false);
      expect(result.extraArgs).toEqual(['--verbose', '--json']);
    });
  });

  describe('empty input', () => {
    it('returns run command with no module when no args provided', () => {
      const result = parseArgs([]);
      expect(result.command).toBe('run');
      expect(result.moduleId).toBeUndefined();
      expect(result.extraArgs).toEqual([]);
    });
  });

  describe('KNOWN_COMMANDS', () => {
    it('contains all v2 commands', () => {
      expect(KNOWN_COMMANDS.has('run')).toBe(true);
      expect(KNOWN_COMMANDS.has('list')).toBe(true);
      expect(KNOWN_COMMANDS.has('doctor')).toBe(true);
      expect(KNOWN_COMMANDS.has('env')).toBe(true);
    });

    it('contains all v3 commands', () => {
      expect(KNOWN_COMMANDS.has('install')).toBe(true);
      expect(KNOWN_COMMANDS.has('publish')).toBe(true);
      expect(KNOWN_COMMANDS.has('upgrade')).toBe(true);
      expect(KNOWN_COMMANDS.has('search')).toBe(true);
    });
  });
});
