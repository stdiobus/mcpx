/**
 * Module manifest types and constants for mcpx.
 *
 * Defines the structure of `module.json` manifest files that describe
 * MCP server modules, including required and optional fields with
 * their validation constraints.
 *
 * @module core/manifest
 */

/**
 * Supported runtime environments for MCP modules.
 */
export type Runtime = 'nodejs' | 'python' | 'go' | 'rust' | 'shell' | 'docker';

/**
 * All valid runtime values as a readonly array for validation.
 */
export const VALID_RUNTIMES: readonly Runtime[] = ['nodejs', 'python', 'go', 'rust', 'shell', 'docker'] as const;

/**
 * Module manifest as defined in `module.json`.
 *
 * Describes an MCP server module's identity, runtime requirements,
 * entry point, and optional configuration.
 *
 * @example
 * ```json
 * {
 *   "id": "mcp-agentic-companion",
 *   "name": "MCP Agentic Companion",
 *   "runtime": "nodejs",
 *   "entry": "mcp-agentic/openai-companion.ts",
 *   "env": { "OPENAI_API_KEY": "" },
 *   "args": ["--port", "3000"],
 *   "description": "An AI companion MCP server",
 *   "version": "1.0.0"
 * }
 * ```
 *
 * @see Requirement 1.1 — Required fields
 * @see Requirement 1.2 — Optional fields
 */
export interface ModuleManifest {
  /**
   * Unique module identifier.
   * Must be 1–128 characters, containing only lowercase alphanumeric characters and hyphens.
   * Pattern: `^[a-z0-9][a-z0-9-]{0,127}$`
   */
  id: string;

  /**
   * Human-readable module name.
   * Must be 1–256 characters.
   */
  name: string;

  /**
   * The execution runtime for this module.
   * Determines which runtime plugin handles launching.
   */
  runtime: Runtime;

  /**
   * Relative path from the module directory to the entry point file.
   * Uses forward slashes regardless of platform.
   */
  entry: string;

  /**
   * Environment variable defaults.
   * Maps variable names to default string values.
   * Maximum 64 entries.
   * Values may use template expressions in v2: `$env:VAR`, `$file:path`, `$cmd:command`.
   */
  env?: Record<string, string>;

  /**
   * Default command-line arguments passed to the module process.
   * Maximum 64 elements.
   * Arguments are passed in array order before any user-supplied arguments.
   */
  args?: string[];

  /**
   * Human-readable description of the module.
   * Maximum 1024 characters.
   */
  description?: string;

  /**
   * Module version in semver format (MAJOR.MINOR.PATCH).
   */
  version?: string;

  /**
   * Module dependencies (v3).
   * Maps module IDs to version range strings.
   */
  dependencies?: Record<string, string>;
}

/**
 * Validation constraints for manifest fields.
 */
export const MANIFEST_CONSTRAINTS = {
  /** Maximum length for the `id` field. */
  ID_MAX_LENGTH: 128,

  /** Regex pattern for valid `id` values. */
  ID_PATTERN: /^[a-z0-9][a-z0-9-]{0,127}$/,

  /** Maximum length for the `name` field. */
  NAME_MAX_LENGTH: 256,

  /** Maximum length for the `description` field. */
  DESCRIPTION_MAX_LENGTH: 1024,

  /** Maximum number of entries in the `env` object. */
  ENV_MAX_ENTRIES: 64,

  /** Maximum number of elements in the `args` array. */
  ARGS_MAX_ELEMENTS: 64,

  /** Regex pattern for valid semver `version` values. */
  VERSION_PATTERN: /^\d+\.\d+\.\d+$/,
} as const;

/**
 * A fully resolved module with its manifest and filesystem location.
 */
export interface ResolvedModule {
  /** The parsed module manifest. */
  manifest: ModuleManifest;

  /** Absolute path to the module directory. */
  dir: string;

  /** Absolute path to the module.json file. */
  manifestPath: string;
}

/**
 * Represents a single validation error found in a module manifest.
 */
export interface ManifestValidationError {
  /** Dot-separated path to the invalid field (e.g. "id", "env.MY_VAR"). */
  field: string;

  /** Human-readable description of what was expected. */
  message: string;

  /** The actual value that failed validation (if available). */
  actual?: unknown;
}

/**
 * Result of manifest validation.
 */
export interface ManifestValidationResult {
  /** Whether the manifest is valid. */
  valid: boolean;

  /** List of validation errors (empty if valid). */
  errors: ManifestValidationError[];

  /** The parsed manifest if valid, undefined otherwise. */
  manifest?: ModuleManifest;
}

/**
 * Validates a parsed JSON object against the ModuleManifest schema.
 *
 * Checks required fields, type constraints, patterns, and optional field limits.
 * Unrecognized fields are ignored without error per Requirement 1.7.
 *
 * @param data - The parsed JSON object to validate.
 * @returns A validation result with errors (if any) and the typed manifest (if valid).
 *
 * @see Requirement 1.1 — Required fields
 * @see Requirement 1.2 — Optional fields
 * @see Requirement 1.3 — Runtime enum validation
 * @see Requirement 1.5 — Missing required field error
 * @see Requirement 1.6 — Round-trip property
 * @see Requirement 1.7 — Ignore unrecognized fields
 */
export function validateManifest(data: unknown): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    errors.push({
      field: '',
      message: 'Manifest must be a JSON object',
      actual: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data,
    });
    return { valid: false, errors };
  }

  const obj = data as Record<string, unknown>;

  // --- Required fields ---

  // id: string, 1-128 chars, pattern ^[a-z0-9][a-z0-9-]{0,127}$
  if (!('id' in obj) || obj.id === undefined) {
    errors.push({ field: 'id', message: 'Required field "id" is missing' });
  } else if (typeof obj.id !== 'string') {
    errors.push({ field: 'id', message: 'Field "id" must be a string', actual: typeof obj.id });
  } else if (!MANIFEST_CONSTRAINTS.ID_PATTERN.test(obj.id)) {
    errors.push({
      field: 'id',
      message: `Field "id" must match pattern ${MANIFEST_CONSTRAINTS.ID_PATTERN.source} (1-128 lowercase alphanumeric characters and hyphens, starting with alphanumeric)`,
      actual: obj.id,
    });
  }

  // name: string, 1-256 chars
  if (!('name' in obj) || obj.name === undefined) {
    errors.push({ field: 'name', message: 'Required field "name" is missing' });
  } else if (typeof obj.name !== 'string') {
    errors.push({ field: 'name', message: 'Field "name" must be a string', actual: typeof obj.name });
  } else if (obj.name.length < 1 || obj.name.length > MANIFEST_CONSTRAINTS.NAME_MAX_LENGTH) {
    errors.push({
      field: 'name',
      message: `Field "name" must be 1-${MANIFEST_CONSTRAINTS.NAME_MAX_LENGTH} characters`,
      actual: obj.name.length,
    });
  }

  // runtime: enum
  if (!('runtime' in obj) || obj.runtime === undefined) {
    errors.push({ field: 'runtime', message: 'Required field "runtime" is missing' });
  } else if (typeof obj.runtime !== 'string') {
    errors.push({ field: 'runtime', message: 'Field "runtime" must be a string', actual: typeof obj.runtime });
  } else if (!VALID_RUNTIMES.includes(obj.runtime as Runtime)) {
    errors.push({
      field: 'runtime',
      message: `Field "runtime" must be one of: ${VALID_RUNTIMES.join(', ')}`,
      actual: obj.runtime,
    });
  }

  // entry: string, min 1 char
  if (!('entry' in obj) || obj.entry === undefined) {
    errors.push({ field: 'entry', message: 'Required field "entry" is missing' });
  } else if (typeof obj.entry !== 'string') {
    errors.push({ field: 'entry', message: 'Field "entry" must be a string', actual: typeof obj.entry });
  } else if (obj.entry.length < 1) {
    errors.push({ field: 'entry', message: 'Field "entry" must be a non-empty string', actual: obj.entry });
  }

  // --- Optional fields ---

  // env: object, max 64 entries, values are strings
  if ('env' in obj && obj.env !== undefined) {
    if (obj.env === null || typeof obj.env !== 'object' || Array.isArray(obj.env)) {
      errors.push({
        field: 'env',
        message: 'Field "env" must be an object mapping variable names to string values',
        actual: obj.env === null ? 'null' : Array.isArray(obj.env) ? 'array' : typeof obj.env,
      });
    } else {
      const envObj = obj.env as Record<string, unknown>;
      const entries = Object.entries(envObj);
      if (entries.length > MANIFEST_CONSTRAINTS.ENV_MAX_ENTRIES) {
        errors.push({
          field: 'env',
          message: `Field "env" must have at most ${MANIFEST_CONSTRAINTS.ENV_MAX_ENTRIES} entries`,
          actual: entries.length,
        });
      }
      for (const [key, value] of entries) {
        if (typeof value !== 'string') {
          errors.push({
            field: `env.${key}`,
            message: `Field "env.${key}" value must be a string`,
            actual: typeof value,
          });
        }
      }
    }
  }

  // args: array of strings, max 64
  if ('args' in obj && obj.args !== undefined) {
    if (!Array.isArray(obj.args)) {
      errors.push({
        field: 'args',
        message: 'Field "args" must be an array of strings',
        actual: typeof obj.args,
      });
    } else {
      if (obj.args.length > MANIFEST_CONSTRAINTS.ARGS_MAX_ELEMENTS) {
        errors.push({
          field: 'args',
          message: `Field "args" must have at most ${MANIFEST_CONSTRAINTS.ARGS_MAX_ELEMENTS} elements`,
          actual: obj.args.length,
        });
      }
      for (let i = 0; i < obj.args.length; i++) {
        if (typeof obj.args[i] !== 'string') {
          errors.push({
            field: `args[${i}]`,
            message: `Field "args[${i}]" must be a string`,
            actual: typeof obj.args[i],
          });
        }
      }
    }
  }

  // description: string, max 1024
  if ('description' in obj && obj.description !== undefined) {
    if (typeof obj.description !== 'string') {
      errors.push({
        field: 'description',
        message: 'Field "description" must be a string',
        actual: typeof obj.description,
      });
    } else if (obj.description.length > MANIFEST_CONSTRAINTS.DESCRIPTION_MAX_LENGTH) {
      errors.push({
        field: 'description',
        message: `Field "description" must be at most ${MANIFEST_CONSTRAINTS.DESCRIPTION_MAX_LENGTH} characters`,
        actual: obj.description.length,
      });
    }
  }

  // version: semver pattern ^\d+\.\d+\.\d+$
  if ('version' in obj && obj.version !== undefined) {
    if (typeof obj.version !== 'string') {
      errors.push({
        field: 'version',
        message: 'Field "version" must be a string in semver format (MAJOR.MINOR.PATCH)',
        actual: typeof obj.version,
      });
    } else if (!MANIFEST_CONSTRAINTS.VERSION_PATTERN.test(obj.version)) {
      errors.push({
        field: 'version',
        message: 'Field "version" must match semver format: MAJOR.MINOR.PATCH (e.g. "1.0.0")',
        actual: obj.version,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // All validations passed — cast to ModuleManifest (only known fields)
  const manifest: ModuleManifest = {
    id: obj.id as string,
    name: obj.name as string,
    runtime: obj.runtime as Runtime,
    entry: obj.entry as string,
  };

  if (obj.env !== undefined) manifest.env = obj.env as Record<string, string>;
  if (obj.args !== undefined) manifest.args = obj.args as string[];
  if (obj.description !== undefined) manifest.description = obj.description as string;
  if (obj.version !== undefined) manifest.version = obj.version as string;
  if (obj.dependencies !== undefined) manifest.dependencies = obj.dependencies as Record<string, string>;

  return { valid: true, errors: [], manifest };
}
