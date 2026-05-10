/**
 * Environment variable loader for mcpx.
 *
 * Handles dotenv file parsing, multi-source precedence merging,
 * env template resolution ($env:, $file:, $cmd:), permission checks,
 * and value masking for secure display.
 *
 * Precedence (highest to lowest):
 *   1. System environment (process.env / inherited from MCP client)
 *   2. Module-level .env ({module_dir}/.env)
 *   3. Root-level .env ({Module_Root}/.env)
 *   4. Manifest defaults (module.json env field)
 *
 * @module core/env-loader
 * @see Requirement 5 — Environment Variable Management
 * @see Requirement 10.5 — Env template syntax
 * @see Requirement 15 — Security and Secrets Management
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Logger } from './logger.js';
import { EnvironmentError } from './errors.js';
import { displayMissingEnvMessage } from './degradation.js';

/**
 * Result of parsing a single .env file.
 * Maps variable names to their string values.
 */
export type EnvMap = Record<string, string>;

/**
 * Options for loading environment variables.
 */
export interface EnvLoadOptions {
  /** Absolute path to the Module_Root directory. */
  rootDir: string;

  /** Absolute path to the module's own directory. */
  moduleDir: string;

  /** Manifest-defined env defaults (from module.json `env` field). */
  manifestEnv?: Record<string, string>;

  /** Logger instance for diagnostics. */
  logger: Logger;
}

/**
 * Result of environment loading, including resolved values and diagnostics.
 */
export interface EnvLoadResult {
  /** The final merged environment variables to pass to the module process. */
  env: EnvMap;

  /** Warnings generated during loading (permission issues, malformed lines, etc.). */
  warnings: string[];

  /** Errors that prevent launching (unresolved templates, missing required vars). */
  errors: string[];
}

/**
 * A single parsed line from a .env file.
 */
interface ParsedEnvLine {
  key: string;
  value: string;
}

// ─── Dotenv Parser ───────────────────────────────────────────────────────────

/**
 * Parse a dotenv-format string into key-value pairs.
 *
 * Supports:
 * - KEY=VALUE pairs (one per line)
 * - # comment lines (leading whitespace allowed)
 * - Blank lines
 * - Single-quoted values (literal, no escape processing)
 * - Double-quoted values (with escape processing for \n, \r, \t, \\, \")
 * - Unquoted values (trailing whitespace trimmed)
 *
 * @param content - The raw file content to parse
 * @param filePath - The file path (for warning messages)
 * @param logger - Logger for reporting malformed lines
 * @returns Parsed key-value pairs and any warnings
 *
 * @see Requirement 5.1 — Standard dotenv format
 * @see Requirement 5.8 — Warn on malformed lines with file path and line number
 */
export function parseDotenv(content: string, filePath: string, logger: Logger): EnvMap {
  const result: EnvMap = {};
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip blank lines
    if (/^\s*$/.test(line)) continue;

    // Skip comment lines
    if (/^\s*#/.test(line)) continue;

    // Parse KEY=VALUE
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      logger.warn(`Malformed line in ${filePath}:${lineNum}`);
      continue;
    }

    const key = match[1];
    let value = match[2];

    // Handle quoted values
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // Double-quoted: process escape sequences
      value = value.slice(1, -1);
      value = value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
        .replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      // Single-quoted: literal value, no escape processing
      value = value.slice(1, -1);
    } else {
      // Unquoted: trim trailing whitespace
      value = value.trimEnd();
    }

    result[key] = value;
  }

  return result;
}

// ─── File Permission Check ───────────────────────────────────────────────────

/**
 * Check Unix file permissions on a .env file.
 * Warns if group or other have any access (read, write, or execute).
 *
 * On non-Unix platforms (Windows), this check is skipped.
 *
 * @param filePath - Absolute path to the .env file
 * @param logger - Logger for emitting warnings
 *
 * @see Requirement 15.4 — Check .env file permissions on Unix
 */
export function checkFilePermissions(filePath: string, logger: Logger): void {
  if (process.platform === 'win32') return;

  try {
    const stats = statSync(filePath);
    const mode = stats.mode;
    // Check group (bits 3-5) and other (bits 0-2) permissions
    const groupOther = mode & 0o077;
    if (groupOther !== 0) {
      const octal = (mode & 0o777).toString(8);
      logger.warn(
        `Insecure permissions on ${filePath} (${octal}). Recommend: chmod 600 ${filePath}`
      );
    }
  } catch {
    // If we can't stat the file, skip the check
  }
}

// ─── Env Template Resolution ─────────────────────────────────────────────────

/**
 * Timeout in milliseconds for $cmd: template expressions.
 * @see Requirement 10.5 — $cmd:command execution SHALL be terminated after 10 seconds
 */
const CMD_TIMEOUT_MS = 10_000;

/**
 * Check if a value is an env template expression.
 */
export function isTemplate(value: string): boolean {
  return value.startsWith('$env:') || value.startsWith('$file:') || value.startsWith('$cmd:');
}

/**
 * Resolve a single env template expression.
 *
 * Template syntax:
 * - `$env:VAR` — Read from environment variable
 * - `$file:path` — Read file contents (trimmed)
 * - `$cmd:command` — Execute command and capture stdout (10s timeout)
 *
 * @param template - The template expression to resolve
 * @param varName - The variable name being resolved (for error messages)
 * @returns The resolved string value
 * @throws EnvironmentError if resolution fails
 *
 * @see Requirement 10.5 — Env template syntax
 * @see Requirement 10.10 — Report error on template resolution failure
 * @see Requirement 15.6 — Support $cmd: for external credential sources
 * @see Requirement 15.7 — Report error on $cmd: failure
 */
export function resolveTemplate(template: string, varName: string): string {
  if (template.startsWith('$env:')) {
    const refVar = template.slice(5);
    const value = process.env[refVar];
    if (value === undefined) {
      throw new EnvironmentError(
        `Env template $env:${refVar} for variable "${varName}" is undefined`,
        `Set the ${refVar} environment variable or add it to a .env file`
      );
    }
    return value;
  }

  if (template.startsWith('$file:')) {
    const filePath = template.slice(6);
    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) {
      throw new EnvironmentError(
        `Env template $file:${filePath} for variable "${varName}" — file not found`,
        `Create the file at ${resolvedPath} or update the template path`
      );
    }
    try {
      return readFileSync(resolvedPath, 'utf-8').trim();
    } catch (err) {
      throw new EnvironmentError(
        `Env template $file:${filePath} for variable "${varName}" — cannot read file: ${(err as Error).message}`,
        `Check file permissions on ${resolvedPath}`
      );
    }
  }

  if (template.startsWith('$cmd:')) {
    const cmd = template.slice(5);
    try {
      const output = execSync(cmd, {
        timeout: CMD_TIMEOUT_MS,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim();
    } catch (err: unknown) {
      const error = err as { killed?: boolean; status?: number; message?: string };
      if (error.killed) {
        throw new EnvironmentError(
          `Env template $cmd:${cmd} for variable "${varName}" timed out after 10 seconds`,
          `Ensure the command completes within 10 seconds or use a different approach`
        );
      }
      throw new EnvironmentError(
        `Env template $cmd:${cmd} for variable "${varName}" failed: ${error.message ?? 'non-zero exit code'}`,
        `Verify the command exists and runs successfully: ${cmd}`
      );
    }
  }

  // Not a template — return as-is
  return template;
}

// ─── Value Masking ───────────────────────────────────────────────────────────

/**
 * Mask a secret value for display.
 *
 * - If value is longer than 4 characters: show first 4 + "****"
 * - If value is 4 characters or fewer: show "****" only
 *
 * @param value - The secret value to mask
 * @returns The masked representation
 *
 * @see Requirement 15.1 — Never log full unmasked values
 * @see Requirement 15.2 — Masking format: first 4 chars + "****" or full mask
 */
export function maskValue(value: string): string {
  if (value.length <= 4) {
    return '****';
  }
  return value.slice(0, 4) + '****';
}

// ─── Literal Value Warning ───────────────────────────────────────────────────

/**
 * Check manifest env values for literal secrets that should use templates.
 *
 * If a module.json env value is not empty and not a template expression,
 * emit a warning that it should be moved to a .env file or use a template.
 *
 * @param manifestEnv - The env object from module.json
 * @param logger - Logger for emitting warnings
 *
 * @see Requirement 15.5 — Warn on literal values in manifest env
 */
export function warnLiteralEnvValues(
  manifestEnv: Record<string, string>,
  logger: Logger
): void {
  for (const [key, value] of Object.entries(manifestEnv)) {
    if (value !== '' && !isTemplate(value)) {
      logger.warn(
        `module.json env "${key}" contains a literal value. ` +
        `Move it to a .env file or use a template expression ($env:, $file:, $cmd:)`
      );
    }
  }
}

// ─── Main Environment Loader ─────────────────────────────────────────────────

/**
 * Load and merge environment variables from all sources.
 *
 * Applies the full precedence chain:
 *   1. System environment (process.env) — never overridden
 *   2. Module-level .env ({moduleDir}/.env)
 *   3. Root-level .env ({rootDir}/.env)
 *   4. Manifest defaults (module.json env field)
 *
 * For manifest defaults that use template expressions ($env:, $file:, $cmd:),
 * resolves them before applying.
 *
 * @param options - Loading options including paths and manifest env
 * @returns The load result with merged env, warnings, and errors
 *
 * @see Requirement 5.1–5.8 — Environment Variable Management
 * @see Requirement 10.5 — Env template syntax
 * @see Requirement 15.4 — Permission checks
 * @see Requirement 15.5 — Literal value warnings
 */
export function loadEnvironment(options: EnvLoadOptions): EnvLoadResult {
  const { rootDir, moduleDir, manifestEnv, logger } = options;
  const warnings: string[] = [];
  const errors: string[] = [];

  // Start with an empty merged map. We'll layer sources from lowest to highest.
  // Then at the end, system env takes final precedence (we never override it).
  const merged: EnvMap = {};

  // ── Layer 4 (lowest): Manifest defaults ──────────────────────────────────
  if (manifestEnv) {
    // Warn about literal values in manifest
    warnLiteralEnvValues(manifestEnv, logger);

    for (const [key, value] of Object.entries(manifestEnv)) {
      if (isTemplate(value)) {
        // Resolve template expressions
        try {
          merged[key] = resolveTemplate(value, key);
        } catch (err) {
          if (err instanceof EnvironmentError) {
            errors.push(err.message);
          } else {
            errors.push(`Failed to resolve template for "${key}": ${(err as Error).message}`);
          }
        }
      } else {
        // Literal value (including empty string as placeholder)
        merged[key] = value;
      }
    }
    logger.debug('env-loader', `Loaded ${Object.keys(manifestEnv).length} manifest defaults`);
  }

  // ── Layer 3: Root-level .env ─────────────────────────────────────────────
  const rootEnvPath = resolve(rootDir, '.env');
  if (existsSync(rootEnvPath)) {
    checkFilePermissions(rootEnvPath, logger);
    try {
      const content = readFileSync(rootEnvPath, 'utf-8');
      const rootEnv = parseDotenv(content, rootEnvPath, logger);
      // Root .env overrides manifest defaults
      for (const [key, value] of Object.entries(rootEnv)) {
        merged[key] = value;
      }
      logger.debug('env-loader', `Loaded ${Object.keys(rootEnv).length} vars from root .env`);
    } catch (err) {
      errors.push(`Failed to read root .env at ${rootEnvPath}: ${(err as Error).message}`);
    }
  }

  // ── Layer 2: Module-level .env ───────────────────────────────────────────
  const moduleEnvPath = resolve(moduleDir, '.env');
  if (existsSync(moduleEnvPath)) {
    checkFilePermissions(moduleEnvPath, logger);
    try {
      const content = readFileSync(moduleEnvPath, 'utf-8');
      const moduleEnvVars = parseDotenv(content, moduleEnvPath, logger);
      // Module .env overrides root .env and manifest defaults
      for (const [key, value] of Object.entries(moduleEnvVars)) {
        merged[key] = value;
      }
      logger.debug('env-loader', `Loaded ${Object.keys(moduleEnvVars).length} vars from module .env`);
    } catch (err) {
      errors.push(`Failed to read module .env at ${moduleEnvPath}: ${(err as Error).message}`);
    }
  }

  // ── Layer 1 (highest): System environment ────────────────────────────────
  // Never override existing system environment variables.
  // Only add variables from merged that are NOT already in process.env.
  const finalEnv: EnvMap = {};
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] !== undefined) {
      // System env takes precedence — use system value
      finalEnv[key] = process.env[key]!;
      logger.debug('env-loader', `"${key}" preserved from system environment`);
    } else {
      finalEnv[key] = value;
    }
  }

  // ── Graceful degradation: detect unresolved variables from missing .env ──
  // If manifest defines env vars with empty defaults (placeholders) and no .env
  // file exists to provide values, display a helpful message.
  if (manifestEnv) {
    const unresolvedVars: string[] = [];
    const moduleEnvPath = resolve(moduleDir, '.env');
    const rootEnvPath2 = resolve(rootDir, '.env');
    const envFileExists = existsSync(moduleEnvPath) || existsSync(rootEnvPath2);

    for (const [key, defaultValue] of Object.entries(manifestEnv)) {
      // A variable is "unresolved" if:
      // - Its manifest default is empty (placeholder)
      // - It's not set in the system environment
      // - No .env file provides it
      if (defaultValue === '' && finalEnv[key] === '' && process.env[key] === undefined) {
        unresolvedVars.push(key);
      }
    }

    if (unresolvedVars.length > 0 && !envFileExists) {
      const expectedEnvPath = resolve(moduleDir, '.env');
      displayMissingEnvMessage(unresolvedVars, expectedEnvPath, logger);
    }
  }

  return { env: finalEnv, warnings, errors };
}

/**
 * Load environment and throw on errors.
 *
 * Convenience wrapper around `loadEnvironment` that throws an
 * EnvironmentError if any resolution errors occurred.
 *
 * @param options - Loading options
 * @returns The merged environment map
 * @throws EnvironmentError if any env resolution errors occurred
 */
export function loadEnvironmentOrThrow(options: EnvLoadOptions): EnvMap {
  const result = loadEnvironment(options);

  if (result.errors.length > 0) {
    throw new EnvironmentError(
      `Environment variable resolution failed:\n  ${result.errors.join('\n  ')}`,
      'Check your .env files and template expressions'
    );
  }

  return result.env;
}
