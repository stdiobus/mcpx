/**
 * Tests for core/degradation.ts — graceful degradation messages.
 *
 * @see Requirement 18.2 — Display unresolved variable names and expected .env file path
 * @see Requirement 18.3 — Display getting-started message when no modules found
 * @see Requirement 18.5 — Capture up to 4096 bytes of stderr on early exit
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  displayNoModulesMessage,
  displayMissingEnvMessage,
  displayEarlyExitMessage,
  EARLY_EXIT_STDERR_MAX_BYTES,
  EARLY_EXIT_THRESHOLD_MS,
} from './degradation.js';
import { Logger } from './logger.js';

describe('degradation messages', () => {
  let stderrOutput: string;

  beforeEach(() => {
    stderrOutput = '';
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput += chunk.toString();
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('displayNoModulesMessage', () => {
    it('should display the Module_Root path', () => {
      const logger = new Logger(false);
      displayNoModulesMessage('/Users/test/.ai', logger);

      expect(stderrOutput).toContain('/Users/test/.ai');
    });

    it('should display the modules directory path', () => {
      const logger = new Logger(false);
      displayNoModulesMessage('/Users/test/.ai', logger);

      expect(stderrOutput).toContain('/Users/test/.ai/modules');
    });

    it('should display getting-started instructions', () => {
      const logger = new Logger(false);
      displayNoModulesMessage('/Users/test/.ai', logger);

      expect(stderrOutput).toContain('Getting started');
      expect(stderrOutput).toContain('module.json');
      expect(stderrOutput).toContain('mkdir');
    });

    it('should show minimum module.json example', () => {
      const logger = new Logger(false);
      displayNoModulesMessage('/Users/test/.ai', logger);

      expect(stderrOutput).toContain('"id"');
      expect(stderrOutput).toContain('"name"');
      expect(stderrOutput).toContain('"runtime"');
      expect(stderrOutput).toContain('"entry"');
    });

    it('should prefix all messages with [mcpx]', () => {
      const logger = new Logger(false);
      displayNoModulesMessage('/Users/test/.ai', logger);

      const lines = stderrOutput.split('\n').filter(l => l.length > 0);
      for (const line of lines) {
        expect(line).toMatch(/^\[mcpx\]/);
      }
    });
  });

  describe('displayMissingEnvMessage', () => {
    it('should display unresolved variable names', () => {
      const logger = new Logger(false);
      displayMissingEnvMessage(
        ['API_KEY', 'SECRET_TOKEN'],
        '/Users/test/.ai/modules/my-module/.env',
        logger,
      );

      expect(stderrOutput).toContain('API_KEY');
      expect(stderrOutput).toContain('SECRET_TOKEN');
    });

    it('should display the expected .env file path', () => {
      const logger = new Logger(false);
      displayMissingEnvMessage(
        ['MY_VAR'],
        '/path/to/.env',
        logger,
      );

      expect(stderrOutput).toContain('/path/to/.env');
    });

    it('should show variable assignment format', () => {
      const logger = new Logger(false);
      displayMissingEnvMessage(
        ['FOO', 'BAR'],
        '/path/.env',
        logger,
      );

      expect(stderrOutput).toContain('FOO=<value>');
      expect(stderrOutput).toContain('BAR=<value>');
    });

    it('should include an error message about missing variables', () => {
      const logger = new Logger(false);
      displayMissingEnvMessage(
        ['OPENAI_API_KEY'],
        '/path/.env',
        logger,
      );

      expect(stderrOutput).toContain('Missing environment variables');
      expect(stderrOutput).toContain('OPENAI_API_KEY');
    });
  });

  describe('displayEarlyExitMessage', () => {
    it('should display module ID, runtime, and entry', () => {
      const logger = new Logger(false);
      displayEarlyExitMessage(
        'my-module',
        'nodejs',
        'index.ts',
        1,
        'Error: Cannot find module',
        logger,
      );

      expect(stderrOutput).toContain('my-module');
      expect(stderrOutput).toContain('nodejs');
      expect(stderrOutput).toContain('index.ts');
    });

    it('should display the exit code', () => {
      const logger = new Logger(false);
      displayEarlyExitMessage('mod', 'python', 'server.py', 127, '', logger);

      expect(stderrOutput).toContain('127');
    });

    it('should display captured stderr output', () => {
      const logger = new Logger(false);
      const stderrContent = 'ModuleNotFoundError: No module named flask';
      displayEarlyExitMessage('mod', 'python', 'server.py', 1, stderrContent, logger);

      expect(stderrOutput).toContain('ModuleNotFoundError');
      expect(stderrOutput).toContain('flask');
    });

    it('should not display stderr section when output is empty', () => {
      const logger = new Logger(false);
      displayEarlyExitMessage('mod', 'nodejs', 'index.ts', 1, '', logger);

      expect(stderrOutput).not.toContain('Module stderr output');
    });

    it('should display stderr section header when output is present', () => {
      const logger = new Logger(false);
      displayEarlyExitMessage('mod', 'nodejs', 'index.ts', 1, 'some error', logger);

      expect(stderrOutput).toContain('Module stderr output');
    });
  });

  describe('constants', () => {
    it('should define EARLY_EXIT_STDERR_MAX_BYTES as 4096', () => {
      expect(EARLY_EXIT_STDERR_MAX_BYTES).toBe(4096);
    });

    it('should define EARLY_EXIT_THRESHOLD_MS as 2000', () => {
      expect(EARLY_EXIT_THRESHOLD_MS).toBe(2000);
    });
  });
});
