import type { ParsedDep } from '../types.js';

const DEP_RE = /^([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?)\s*([=!<>~^]+\s*[\w.*+]+)?/;

/** Parse requirements.txt / requirements-*.txt content. */
export function parseRequirements(content: string): ParsedDep[] {
  const results: ParsedDep[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    // Skip comments, blank lines, options (-r, -c, -e, --), and URL deps
    if (!line || line.startsWith('#') || line.startsWith('-') || line.includes('://')) continue;
    const match = DEP_RE.exec(line);
    if (!match) continue;
    const name = match[1];
    const versionSpec = (match[3] ?? '').trim();
    results.push({ name, specifiedVersion: versionSpec, ecosystem: 'pypi', dev: false });
  }
  return results;
}
