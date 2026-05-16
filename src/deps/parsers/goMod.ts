import type { ParsedDep } from '../types.js';

/** Parse go.mod content. Handles both inline and block require statements. */
export function parseGoMod(content: string): ParsedDep[] {
  const results: ParsedDep[] = [];
  let inRequireBlock = false;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;

    if (line === 'require (') {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }

    // Block entry: <module> <version> [// indirect]
    if (inRequireBlock) {
      const match = /^([^\s]+)\s+(v[\w.+-]+)/.exec(line);
      if (match) {
        const [, name, version] = match;
        const dev = line.includes('// indirect');
        results.push({ name, specifiedVersion: version, ecosystem: 'go', dev });
      }
      continue;
    }

    // Inline: require <module> <version>
    const inlineMatch = /^require\s+([^\s]+)\s+(v[\w.+-]+)/.exec(line);
    if (inlineMatch) {
      const [, name, version] = inlineMatch;
      results.push({ name, specifiedVersion: version, ecosystem: 'go', dev: false });
    }
  }

  return results;
}
