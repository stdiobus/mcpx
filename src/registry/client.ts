/**
 * Registry HTTP client for the mcpx module registry.
 *
 * Provides methods to search, retrieve, and publish modules to the
 * remote registry at registry.stdiobus.com.
 *
 * @module registry/client
 * @see Requirement 12.3 — Registry JSON index with module metadata
 */

import type { ModuleManifest } from '../core/manifest.js';

/**
 * A module entry as stored in the registry index.
 */
export interface RegistryEntry {
  /** Unique module identifier. */
  id: string;

  /** Human-readable module name. */
  name: string;

  /** Module description. */
  description: string;

  /** Git repository URL for the module source. */
  gitUrl: string;

  /** Latest published version in semver format. */
  latestVersion: string;

  /** Supported runtime environments. */
  runtimes: string[];

  /** ISO 8601 timestamp of when the module was published. */
  publishedAt: string;
}

/**
 * Interface for registry client implementations.
 */
export interface RegistryClient {
  /** Search the registry for modules matching a query string. */
  search(query: string): Promise<RegistryEntry[]>;

  /** Get a single module by ID, or null if not found. */
  getModule(id: string): Promise<RegistryEntry | null>;

  /** Publish a module manifest and tarball to the registry. */
  publish(manifest: ModuleManifest, tarball: Buffer): Promise<void>;
}

/**
 * HTTP-based registry client that communicates with the remote registry API.
 *
 * Uses the native `fetch` API (Node.js 18+) for HTTP requests.
 *
 * @example
 * ```typescript
 * const client = new HttpRegistryClient();
 * const results = await client.search('agentic');
 * const module = await client.getModule('mcp-agentic-companion');
 * ```
 */
export class HttpRegistryClient implements RegistryClient {
  constructor(private baseUrl: string = 'https://registry.stdiobus.com') { }

  /**
   * Search the registry for modules matching a query string.
   *
   * @param query - The search query (substring match against name and description).
   * @returns An array of matching registry entries (up to 50 results).
   */
  async search(query: string): Promise<RegistryEntry[]> {
    const url = `${this.baseUrl}/modules?q=${encodeURIComponent(query)}&limit=50`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Registry search failed: ${res.status} ${res.statusText}`);
    }

    return res.json() as Promise<RegistryEntry[]>;
  }

  /**
   * Get a single module by its ID.
   *
   * @param id - The module ID to look up.
   * @returns The registry entry, or null if the module is not found (404).
   */
  async getModule(id: string): Promise<RegistryEntry | null> {
    const url = `${this.baseUrl}/modules/${encodeURIComponent(id)}`;
    const res = await fetch(url);

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      throw new Error(`Registry lookup failed: ${res.status} ${res.statusText}`);
    }

    return res.json() as Promise<RegistryEntry>;
  }

  /**
   * Publish a module to the registry.
   *
   * @param manifest - The validated module manifest.
   * @param tarball - The module tarball as a Buffer.
   */
  async publish(manifest: ModuleManifest, tarball: Buffer): Promise<void> {
    const url = `${this.baseUrl}/modules`;

    const formData = new FormData();
    formData.append('manifest', JSON.stringify(manifest));
    formData.append('tarball', new Blob([tarball]), `${manifest.id}.tar.gz`);

    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Registry publish failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
    }
  }
}
