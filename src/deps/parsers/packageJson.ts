import type { ParsedDep } from '../types.js';

/** Parse package.json content and return a flat list of dependencies. */
export function parsePackageJson(content: string): ParsedDep[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return [];
  }

  const results: ParsedDep[] = [];

  function extractDeps(obj: unknown, dev: boolean): void {
    if (!obj || typeof obj !== 'object') return;
    for (const [name, version] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof version === 'string') {
        results.push({ name, specifiedVersion: version, ecosystem: 'npm', dev });
      }
    }
  }

  extractDeps(pkg.dependencies, false);
  extractDeps(pkg.devDependencies, true);
  return results;
}
