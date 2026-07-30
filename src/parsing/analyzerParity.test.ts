import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { getRegexAnalyzer } from './registry.js';
import { createTreeSitterAnalyzer } from './treeSitterAnalyzer.js';
import { grammarsDir, hasGrammars } from './grammarsTestSupport.js';
import type { CodeAnalyzer, CodeElement } from './types.js';

// Both analyzers, over this repo's own source, on real bytes.
//
// The fixtures in symbolIndexer.test.ts pin behaviour a few lines at a time;
// they cannot see a change that works on a 4-line fixture and breaks on the
// corpus this extension actually indexes. The missing `variable` symbols were
// found exactly that way — from outside — and nothing inside the suite could
// see them, because every test was written against the extractor that produced
// the data.
//
// Kept out of registry.test.ts, the co-located home, because that suite
// `vi.doMock`s ./treeSitterAnalyzer.js with `resetModules` between cases; a
// real-grammar suite sharing the file would fight those mocks.

// Measured at 221 exported + 790 total over 497 files when this landed. The
// floor is deliberately loose: it exists to catch emission collapsing toward
// zero, which is the failure this whole change is about, not to track the true
// count upward as source is added.
const EXPORTED_FLOOR = 180;

/** Every non-test TypeScript source file in the repo. */
function sourceFiles(): string[] {
  // NOT `src/**/*.ts`: git's pathspec requires that to match at least one
  // directory level, so it silently drops top-level files like src/astContext.ts
  // — the very file the BOM fix lives in.
  return execSync("git ls-files src | grep '\\.ts$'", { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter((f) => !f.includes('.test.'));
}

function variables(analyzer: CodeAnalyzer, file: string, content: string): CodeElement[] {
  return analyzer.parseFileContent(file, content).elements.filter((e) => e.type === 'variable');
}

describe('analyzer output over the real workspace', () => {
  const regex = getRegexAnalyzer();
  let files: string[];
  let contents: Map<string, string>;

  beforeAll(() => {
    files = sourceFiles();
    contents = new Map(files.map((f) => [f, readFileSync(f, 'utf-8')]));
  }, 60000);

  it('indexes exported constants across the workspace', () => {
    const all = files.flatMap((f) => variables(regex, f, contents.get(f)!));
    const exported = all.filter((e) => e.exported);
    console.log(`  variable symbols across ${files.length} files: ${exported.length} exported, ${all.length} total`);
    expect(exported.length).toBeGreaterThan(EXPORTED_FLOOR);
  }, 60000);

  it('no declaration range swallows the declaration after it', () => {
    // The runaway signature, stated without a magic number: top-level
    // declarations are siblings, so their ranges cannot overlap. An unbalanced
    // bracket — the `(` inside `const P = /^\s*\(/` — used to run one span to
    // end-of-file, engulfing every declaration below it. A large declaration
    // that merely ends the file is not that, and this does not flag it.
    const overlaps: string[] = [];
    for (const f of files) {
      const decls = variables(regex, f, contents.get(f)!).sort((a, b) => a.startLine - b.startLine);
      for (let i = 1; i < decls.length; i++) {
        const prev = decls[i - 1];
        if (prev.endLine >= decls[i].startLine && prev.startLine !== decls[i].startLine) {
          overlaps.push(`${f}: ${prev.name} (${prev.startLine}-${prev.endLine}) engulfs ${decls[i].name}`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  }, 60000);

  // The parity comparison needs grammars; the checks above deliberately do not,
  // so a grammar-less checkout still gets the regression guard.
  describe.skipIf(!hasGrammars)('agreement with the tree-sitter analyzer', () => {
    let treeSitter: CodeAnalyzer;
    beforeAll(async () => {
      treeSitter = await createTreeSitterAnalyzer(grammarsDir);
    }, 120000);

    it('both analyzers agree on which names are exported variables', () => {
      // A symbol's kind must not depend on whether grammars happened to load:
      // one developer's find_references would answer differently from another's
      // on identical source.
      const disagreements: string[] = [];
      for (const f of files) {
        const content = contents.get(f)!;
        const fromTs = new Set(
          variables(treeSitter, f, content)
            .filter((e) => e.exported)
            .map((e) => e.name),
        );
        const fromRegex = new Set(
          variables(regex, f, content)
            .filter((e) => e.exported)
            .map((e) => e.name),
        );
        for (const n of fromRegex) if (!fromTs.has(n)) disagreements.push(`${f}: regex-only ${n}`);
        for (const n of fromTs) if (!fromRegex.has(n)) disagreements.push(`${f}: tree-sitter-only ${n}`);
      }
      expect(disagreements).toEqual([]);
    }, 120000);
  });
});
