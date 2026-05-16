import type { ParsedDep } from '../types.js';

type DepSection = 'dependencies' | 'dev-dependencies' | 'build-dependencies' | null;

/** Parse Cargo.toml content (minimal TOML — only handles dep sections). */
export function parseCargoToml(content: string): ParsedDep[] {
  const results: ParsedDep[] = [];
  let section: DepSection = null;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // Section header
    const headerMatch = /^\[(.+?)\]/.exec(line);
    if (headerMatch) {
      const h = headerMatch[1].replace(/\s/g, '');
      if (h === 'dependencies' || h === 'package.dependencies') section = 'dependencies';
      else if (h === 'dev-dependencies' || h === 'dev_dependencies') section = 'dev-dependencies';
      else if (h === 'build-dependencies' || h === 'build_dependencies') section = 'build-dependencies';
      else section = null;
      continue;
    }

    if (!section) continue;

    // name = "version" or name = { version = "...", ... }
    const simpleMatch = /^([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (simpleMatch) {
      const [, name, version] = simpleMatch;
      results.push({ name, specifiedVersion: version, ecosystem: 'cargo', dev: section !== 'dependencies' });
      continue;
    }

    const tableMatch = /^([a-zA-Z0-9_-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]*)"/.exec(line);
    if (tableMatch) {
      const [, name, version] = tableMatch;
      results.push({ name, specifiedVersion: version, ecosystem: 'cargo', dev: section !== 'dependencies' });
    }
  }

  return results;
}
