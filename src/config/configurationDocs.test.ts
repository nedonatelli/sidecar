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

  it('documents the default value each setting actually ships with', () => {
    // Being listed is not the same as being described correctly. The declared
    // default is what a user gets; `sidecar.diagnostics.analysisBudgetMs`
    // shipped 3000 while both the doc and the code's fallback said 5000, so
    // every source that a reader might check disagreed with the product.
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: { configuration: unknown };
    };
    const cfg = pkg.contributes.configuration;
    const sections = (Array.isArray(cfg) ? cfg : [cfg]) as Array<{
      properties?: Record<string, { default?: unknown }>;
    }>;
    const doc = readFileSync(resolve(process.cwd(), 'docs/configuration.md'), 'utf8');

    const wrong: string[] = [];
    for (const s of sections) {
      for (const [key, schema] of Object.entries(s.properties ?? {})) {
        // Only numbers and booleans: strings and objects are rendered in prose
        // and enum tables in too many shapes to compare mechanically.
        if (typeof schema.default !== 'number' && typeof schema.default !== 'boolean') continue;
        const row = doc.split('\n').find((l) => l.includes(`\`${key}\``) && l.startsWith('|'));
        if (!row) continue; // absence is the other test's job
        if (!row.includes(`\`${String(schema.default)}\``)) {
          wrong.push(`${key}: package.json says ${String(schema.default)}, docs row says otherwise`);
        }
      }
    }
    expect(wrong, `Documented defaults disagree with package.json:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });
});
