import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// What the PACKAGED extension can actually load — not what a direct call to
// createTreeSitterAnalyzer returns.
//
// The distinction is the whole bug (#47). `registry.ts` reached the analyzer
// through an indirected dynamic import, which esbuild left as a runtime
// specifier pointing at `dist/treeSitterAnalyzer.js` — a file the bundle does
// not contain and the VSIX does not ship. `.catch(() => null)` swallowed the
// ERR_MODULE_NOT_FOUND, so every install silently used the regex parser while
// shipping 28 MB of grammars it could not load.
//
// Measured on 0.122.4 before the fix: the cached symbol graph matched the regex
// analyzer's count over src/ (6,541) and not tree-sitter's (5,836).
//
// Every other test in this directory calls createTreeSitterAnalyzer directly and
// so passed throughout — they verify a code path no install reached. This one
// reads the build output, because that is the only artifact users run.

const BUNDLE = resolve(process.cwd(), 'dist', 'extension.js');

// Mirrors grammarsTestSupport: absent locally is tolerable (nobody has bundled
// yet), absent in CI is a workflow defect. CI runs `npm run bundle` before the
// test step, so a missing bundle there means this suite would silently cover
// nothing — the exact failure mode it exists to prevent.
if (process.env.CI && !existsSync(BUNDLE)) {
  throw new Error(
    'dist/extension.js is missing while running in CI. The bundled-analyzer suite ' +
      'cannot verify what the packaged extension loads. Ensure `npm run bundle` runs ' +
      'before the test step (.github/workflows/ci.yml).',
  );
}

describe.skipIf(!existsSync(BUNDLE))('the packaged bundle', () => {
  const bundle = existsSync(BUNDLE) ? readFileSync(BUNDLE, 'utf-8') : '';

  it('contains the tree-sitter analyzer rather than importing it at runtime', () => {
    // The language mappings only exist inside treeSitterAnalyzer.ts, so finding
    // one proves the module was bundled rather than left as a dangling import.
    expect(bundle).toContain('generator_function_declaration');
    expect(bundle).toContain('createTreeSitterAnalyzer');
  });

  it('has no runtime import of a dist-relative module that is not shipped', () => {
    // `dist/` holds extension.js and its sourcemap, nothing else. Any surviving
    // relative dynamic import therefore cannot resolve at runtime — which is
    // precisely how tree-sitter went missing without a single error surfacing.
    const relativeImports = [...bundle.matchAll(/\bimport\(\s*["'](\.\/[^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(relativeImports).toEqual([]);
  });

  it('does not swallow a tree-sitter load failure', () => {
    // The `.catch(() => null)` sat inside the try block and absorbed exactly the
    // error the outer handler existed to report, so the fallback was silent. A
    // degraded parser must never again look identical to a working one.
    expect(bundle).toContain('Tree-sitter failed to load');
  });
});
