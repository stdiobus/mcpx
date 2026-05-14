import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Resolve the repository/package root for tests, robustly across CI layouts.
 *
 * We walk upward until we find a package.json with name "@stdiobus/mcpx".
 */
export function findPackageRoot(fromDir: string): string {
  let dir = resolve(fromDir);
  for (let i = 0; i < 12; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg?.name === '@stdiobus/mcpx') return dir;
      } catch {
        // ignore and keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: return the original directory if nothing found.
  return resolve(fromDir);
}

