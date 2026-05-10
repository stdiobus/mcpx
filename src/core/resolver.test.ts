import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { resolveRoot } from './resolver.js';
import { McpxError } from './errors.js';

describe('resolveRoot', () => {
  let originalMcpxRoot: string | undefined;
  let originalArgv: string[];
  let tempDir: string;

  beforeEach(() => {
    originalMcpxRoot = process.env.MCPX_ROOT;
    originalArgv = [...process.argv];
    tempDir = mkdtempSync(join(tmpdir(), 'mcpx-resolver-test-'));
  });

  afterEach(() => {
    // Restore env
    if (originalMcpxRoot === undefined) {
      delete process.env.MCPX_ROOT;
    } else {
      process.env.MCPX_ROOT = originalMcpxRoot;
    }
    process.argv = originalArgv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('MCPX_ROOT environment variable (highest precedence)', () => {
    it('uses MCPX_ROOT when set to an absolute path that exists', () => {
      const rootDir = join(tempDir, 'custom-root');
      mkdirSync(rootDir);
      process.env.MCPX_ROOT = rootDir;

      const result = resolveRoot();
      expect(result).toBe(rootDir);
    });

    it('resolves relative MCPX_ROOT against cwd', () => {
      const rootDir = join(tempDir, 'relative-root');
      mkdirSync(rootDir);
      process.env.MCPX_ROOT = './relative-root';
      const originalCwd = process.cwd();
      try {
        process.chdir(tempDir);
        const result = resolveRoot();
        // resolve() uses cwd which may differ from realpath on macOS (/var → /private/var)
        expect(result).toBe(resolve(realpathSync(tempDir), 'relative-root'));
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('treats empty MCPX_ROOT as unset and falls through to next method', () => {
      process.env.MCPX_ROOT = '';
      // Set up script location with modules/ dir so it resolves there
      const fakeRoot = join(tempDir, 'fake-root');
      const binDir = join(fakeRoot, 'bin');
      const modulesDir = join(fakeRoot, 'modules');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(modulesDir);
      const scriptPath = join(binDir, 'mcpx');
      writeFileSync(scriptPath, '#!/usr/bin/env node');
      process.argv[1] = scriptPath;

      const result = resolveRoot();
      // Should NOT use empty string as root, should fall through
      // realpathSync resolves macOS /var → /private/var symlinks
      expect(result).toBe(realpathSync(fakeRoot));
    });

    it('throws McpxError when MCPX_ROOT path does not exist', () => {
      process.env.MCPX_ROOT = join(tempDir, 'nonexistent');

      expect(() => resolveRoot()).toThrow('MCPX_ROOT path does not exist');
    });

    it('throws McpxError with general error code when MCPX_ROOT does not exist', () => {
      process.env.MCPX_ROOT = join(tempDir, 'nonexistent');

      try {
        resolveRoot();
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpxError);
        expect((err as McpxError).code).toBe('general');
        expect((err as McpxError).exitCode).toBe(1);
      }
    });

    it('throws McpxError when MCPX_ROOT points to a file, not a directory', () => {
      const filePath = join(tempDir, 'a-file');
      writeFileSync(filePath, 'content');
      process.env.MCPX_ROOT = filePath;

      expect(() => resolveRoot()).toThrow('MCPX_ROOT path is not a directory');
    });

    it('includes suggestion in error when MCPX_ROOT is invalid', () => {
      process.env.MCPX_ROOT = join(tempDir, 'nonexistent');

      try {
        resolveRoot();
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpxError);
        expect((err as McpxError).suggestion).toContain('MCPX_ROOT');
      }
    });
  });

  describe('script location (second precedence)', () => {
    it('resolves root from script location when modules/ dir exists', () => {
      delete process.env.MCPX_ROOT;
      // Simulate: script at <root>/bin/mcpx → root = dirname(dirname(realpath))
      const fakeRoot = join(tempDir, 'fake-root');
      const binDir = join(fakeRoot, 'bin');
      const modulesDir = join(fakeRoot, 'modules');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(modulesDir);
      const scriptPath = join(binDir, 'mcpx');
      writeFileSync(scriptPath, '#!/usr/bin/env node');

      process.argv[1] = scriptPath;

      const result = resolveRoot();
      expect(result).toBe(realpathSync(fakeRoot));
    });

    it('resolves symlinks before determining script location', () => {
      delete process.env.MCPX_ROOT;
      // Create actual root with modules/
      const actualRoot = join(tempDir, 'actual-root');
      const actualBin = join(actualRoot, 'bin');
      const modulesDir = join(actualRoot, 'modules');
      mkdirSync(actualBin, { recursive: true });
      mkdirSync(modulesDir);
      const actualScript = join(actualBin, 'mcpx');
      writeFileSync(actualScript, '#!/usr/bin/env node');

      // Create symlink to the script from a different location
      const linkDir = join(tempDir, 'link-dir');
      mkdirSync(linkDir);
      const linkPath = join(linkDir, 'mcpx-link');
      symlinkSync(actualScript, linkPath);

      process.argv[1] = linkPath;

      const result = resolveRoot();
      expect(result).toBe(realpathSync(actualRoot));
    });

    it('skips script location when modules/ dir does not exist there', () => {
      delete process.env.MCPX_ROOT;
      // Script location without modules/ dir — should fall through
      const fakeRoot = join(tempDir, 'no-modules');
      const binDir = join(fakeRoot, 'bin');
      mkdirSync(binDir, { recursive: true });
      const scriptPath = join(binDir, 'mcpx');
      writeFileSync(scriptPath, '#!/usr/bin/env node');
      process.argv[1] = scriptPath;

      // Should fall through to homedir fallback
      const homeAi = resolve(homedir(), '.ai');
      if (existsSync(homeAi)) {
        const result = resolveRoot();
        expect(result).toBe(homeAi);
      } else {
        expect(() => resolveRoot()).toThrow('Module root not found');
      }
    });
  });

  describe('homedir fallback (lowest precedence)', () => {
    it('falls back to ~/.ai when it exists and script location has no modules/', () => {
      delete process.env.MCPX_ROOT;
      // Point script to a location without modules/
      const binDir = join(tempDir, 'bin');
      mkdirSync(binDir);
      const scriptPath = join(binDir, 'mcpx');
      writeFileSync(scriptPath, '#!/usr/bin/env node');
      process.argv[1] = scriptPath;

      const homeAi = resolve(homedir(), '.ai');
      if (existsSync(homeAi)) {
        const result = resolveRoot();
        expect(result).toBe(homeAi);
      }
      // If ~/.ai doesn't exist on this machine, this test is a no-op
    });
  });

  describe('error when no root found', () => {
    it('throws McpxError with checked locations when nothing resolves', () => {
      delete process.env.MCPX_ROOT;
      // Use a script path in temp that has no modules/ dir
      const binDir = join(tempDir, 'nowhere', 'bin');
      mkdirSync(binDir, { recursive: true });
      const scriptPath = join(binDir, 'mcpx');
      writeFileSync(scriptPath, '#!/usr/bin/env node');
      process.argv[1] = scriptPath;

      const homeAi = resolve(homedir(), '.ai');
      if (!existsSync(homeAi)) {
        try {
          resolveRoot();
          throw new Error('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(McpxError);
          expect((err as McpxError).message).toContain('Module root not found');
          expect((err as McpxError).suggestion).toBeDefined();
        }
      }
      // If ~/.ai exists, this test scenario can't trigger the error on this machine
    });
  });

  describe('precedence ordering', () => {
    it('MCPX_ROOT takes precedence over script location', () => {
      // Set up both: MCPX_ROOT and a valid script location
      const envRoot = join(tempDir, 'env-root');
      mkdirSync(envRoot);
      process.env.MCPX_ROOT = envRoot;

      const scriptRoot = join(tempDir, 'script-root');
      const binDir = join(scriptRoot, 'bin');
      const modulesDir = join(scriptRoot, 'modules');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(modulesDir);
      const scriptPath = join(binDir, 'mcpx');
      writeFileSync(scriptPath, '#!/usr/bin/env node');
      process.argv[1] = scriptPath;

      const result = resolveRoot();
      // MCPX_ROOT should win
      expect(result).toBe(envRoot);
    });

    it('script location takes precedence over homedir fallback', () => {
      delete process.env.MCPX_ROOT;
      // Set up script location with modules/
      const scriptRoot = join(tempDir, 'script-root');
      const binDir = join(scriptRoot, 'bin');
      const modulesDir = join(scriptRoot, 'modules');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(modulesDir);
      const scriptPath = join(binDir, 'mcpx');
      writeFileSync(scriptPath, '#!/usr/bin/env node');
      process.argv[1] = scriptPath;

      const result = resolveRoot();
      // Script location should win over ~/.ai
      expect(result).toBe(realpathSync(scriptRoot));
    });
  });
});
