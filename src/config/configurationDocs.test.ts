import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Coverage pin for docs/configuration.md: every setting declared in
// package.json `contributes.configuration` must be documented, so the doc can't
// silently fall behind the schema (it had drifted 17 settings behind). Mirrors
// the count-pin approach in tools.test.ts and settingsSchema.test.ts.

describe('docs/configuration.md coverage', () => {
  it('documents every setting declared in package.json contributes.configuration', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: { configuration: unknown };
    };
    const cfg = pkg.contributes.configuration;
    const sections = (Array.isArray(cfg) ? cfg : [cfg]) as Array<{ properties?: Record<string, unknown> }>;

    const declared = new Set<string>();
    for (const s of sections) for (const key of Object.keys(s.properties ?? {})) declared.add(key);

    const doc = readFileSync(resolve(process.cwd(), 'docs/configuration.md'), 'utf8');
    const missing = [...declared].filter((key) => !doc.includes(key)).sort();

    expect(
      missing,
      `These settings are declared in package.json but not documented in docs/configuration.md:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });
});
