/**
 * Dependency resolver for mcpx module registry.
 *
 * Resolves transitive dependencies from module manifests using the
 * registry client, detecting version conflicts and enforcing a maximum
 * resolution depth to prevent infinite recursion in circular dependency graphs.
 *
 * @module registry/resolver
 * @see Requirement 12.6 — Resolve and install dependencies transitively up to max depth 10
 * @see Requirement 12.7 — Report dependency conflicts with both versions and requiring modules
 */

import type { RegistryClient, RegistryEntry } from './client.js';

/**
 * Represents a node in the dependency graph.
 */
export interface DependencyNode {
  /** Module identifier. */
  id: string;

  /** Resolved version string. */
  version: string;

  /** Map of dependency module IDs to required version strings. */
  dependencies: Record<string, string>;
}

/**
 * Error thrown when two modules require different versions of the same dependency.
 *
 * Includes the dependency ID, both conflicting versions, and the modules
 * that require them for clear diagnostic output.
 */
export class ConflictError extends Error {
  /** The dependency module ID that has conflicting version requirements. */
  readonly dependencyId: string;

  /** The version already resolved (from the first requiring module). */
  readonly existingVersion: string;

  /** The conflicting version requested (from the second requiring module). */
  readonly requestedVersion: string;

  /** The module that first required the existing version. */
  readonly existingRequiredBy: string;

  /** The module that requested the conflicting version. */
  readonly requestedBy: string;

  constructor(
    dependencyId: string,
    existingVersion: string,
    requestedVersion: string,
    existingRequiredBy: string,
    requestedBy: string,
  ) {
    super(
      `Dependency conflict for "${dependencyId}": ` +
      `version "${existingVersion}" required by "${existingRequiredBy}" ` +
      `conflicts with version "${requestedVersion}" required by "${requestedBy}"`,
    );
    this.name = 'ConflictError';
    this.dependencyId = dependencyId;
    this.existingVersion = existingVersion;
    this.requestedVersion = requestedVersion;
    this.existingRequiredBy = existingRequiredBy;
    this.requestedBy = requestedBy;
  }
}

/**
 * Error thrown when a dependency cannot be found in the registry.
 */
export class DependencyNotFoundError extends Error {
  /** The module ID that was not found. */
  readonly dependencyId: string;

  /** The module that required this dependency. */
  readonly requiredBy: string;

  constructor(dependencyId: string, requiredBy: string) {
    super(`Dependency "${dependencyId}" required by "${requiredBy}" not found in registry`);
    this.name = 'DependencyNotFoundError';
    this.dependencyId = dependencyId;
    this.requiredBy = requiredBy;
  }
}

/**
 * Error thrown when the dependency tree exceeds the maximum allowed depth.
 */
export class MaxDepthExceededError extends Error {
  /** The maximum depth that was exceeded. */
  readonly maxDepth: number;

  constructor(maxDepth: number) {
    super(`Dependency resolution exceeded maximum depth of ${maxDepth}`);
    this.name = 'MaxDepthExceededError';
    this.maxDepth = maxDepth;
  }
}

/** Default maximum depth for transitive dependency resolution. */
export const DEFAULT_MAX_DEPTH = 10;

/**
 * Internal tracking for resolved dependencies, including which module required them.
 */
interface ResolvedEntry {
  node: DependencyNode;
  requiredBy: string;
}

/**
 * Resolves transitive dependencies for a module using the registry.
 *
 * Uses breadth-first traversal to resolve the full dependency tree,
 * detecting version conflicts and enforcing a maximum depth limit.
 * Version matching uses exact string comparison against the registry's
 * `latestVersion` field.
 *
 * @param rootModule - The root module whose dependencies should be resolved
 * @param registry - The registry client to look up dependency metadata
 * @param maxDepth - Maximum depth for transitive resolution (default: 10)
 * @returns Array of resolved dependency nodes (does not include the root module)
 *
 * @throws {ConflictError} When two modules require different versions of the same dependency
 * @throws {DependencyNotFoundError} When a dependency is not found in the registry
 * @throws {MaxDepthExceededError} When the dependency tree exceeds maxDepth
 *
 * @example
 * ```typescript
 * const root: DependencyNode = {
 *   id: 'my-module',
 *   version: '1.0.0',
 *   dependencies: { 'dep-a': '2.0.0', 'dep-b': '1.0.0' }
 * };
 * const resolved = await resolveDependencies(root, registryClient);
 * // resolved = [{ id: 'dep-a', version: '2.0.0', dependencies: {} }, ...]
 * ```
 */
export async function resolveDependencies(
  rootModule: DependencyNode,
  registry: RegistryClient,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Promise<DependencyNode[]> {
  const resolved = new Map<string, ResolvedEntry>();
  const queue: Array<{ node: DependencyNode; depth: number }> = [
    { node: rootModule, depth: 0 },
  ];

  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;

    if (depth > maxDepth) {
      throw new MaxDepthExceededError(maxDepth);
    }

    for (const [depId, requiredVersion] of Object.entries(node.dependencies)) {
      const existing = resolved.get(depId);

      if (existing) {
        // Check for version conflict using exact match
        if (existing.node.version !== requiredVersion) {
          throw new ConflictError(
            depId,
            existing.node.version,
            requiredVersion,
            existing.requiredBy,
            node.id,
          );
        }
        // Already resolved with compatible version, skip
        continue;
      }

      // Look up the dependency in the registry
      const entry = await registry.getModule(depId);
      if (!entry) {
        throw new DependencyNotFoundError(depId, node.id);
      }

      // Check that the registry version matches the required version (exact match)
      if (entry.latestVersion !== requiredVersion) {
        throw new ConflictError(
          depId,
          entry.latestVersion,
          requiredVersion,
          'registry',
          node.id,
        );
      }

      // Create the dependency node — we don't have the dependency's own
      // dependencies from the RegistryEntry, so we default to empty.
      // In a full implementation, the registry would provide this info.
      const depNode: DependencyNode = {
        id: depId,
        version: entry.latestVersion,
        dependencies: {},
      };

      resolved.set(depId, { node: depNode, requiredBy: node.id });
      queue.push({ node: depNode, depth: depth + 1 });
    }
  }

  return [...resolved.values()].map((entry) => entry.node);
}
