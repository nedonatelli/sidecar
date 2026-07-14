import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { findPythonIndentErrors } from './pythonIndent.js';

// ---------------------------------------------------------------------------
// False-positive corpus.
//
// A false positive here REFUSES A LEGITIMATE EDIT — worse than the corruption
// the checker prevents. So it is validated against real code, not just
// hand-written fixtures.
//
// The full validation run: 4,001 files that CPython itself accepts (the Python
// 3.13 standard library plus requests, flask, pip, attrs, httpx, fastapi, black
// and pytest) → ZERO errors reported. Every false positive that run surfaced
// changed the design:
//
//   • ipaddress.py — a docstring opening `"""The name …, e.g.:` — a colon INSIDE
//     a string, read as a block opener.
//   • textwrap.py — a line closing a triple-quote and then opening a `{`; the
//     bracket continuation was lost when the rest of the line was skipped.
//   • bdb.py — a docstring-only line masked to nothing and dropped, so the next
//     statement looked like a missing indented block.
//   • pygments filters — `if a or \` backslash continuations, whose indent IS
//     meaningful; an early "skip backslash lines" fix wrecked the indent stack.
//   • black's torture cases — multi-line f-strings (PEP 701), form feeds used as
//     whitespace, and a line that is nothing but a backslash. All three are now
//     detected and the file is skipped rather than guessed at.
//
// Re-running the whole 4,001-file sweep needs those repos cloned, so the files
// that actually produced findings are vendored here. They are `.py.txt` so no
// tooling tries to lint or execute them.
// ---------------------------------------------------------------------------

const FIXTURES = path.join(__dirname, '__fixtures__');

const load = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

describe('pythonIndent: real-world code must never be flagged', () => {
  const realWorld = [
    'stdlib_ipaddress.py.txt',
    'stdlib_textwrap.py.txt',
    'stdlib_bdb.py.txt',
    'pygments_filters.py.txt',
    'flask_app.py.txt',
    'requests_models.py.txt',
    'fastapi_routing.py.txt',
  ];

  for (const name of realWorld) {
    it(`${name} — zero errors`, () => {
      const errors = findPythonIndentErrors(load(name));
      expect(errors.map((e) => `line ${e.line}: ${e.message}`)).toEqual([]);
    });
  }
});

describe('pythonIndent: exotic sources are SKIPPED, not guessed at', () => {
  // Fail-open by design. These parse in CPython but use constructs the scanner
  // does not model; reporting on them would risk refusing a valid edit.
  const exotic = [
    ['black_pep701.py.txt', 'multi-line f-strings (PEP 701)'],
    ['black_formfeeds.py.txt', 'form feeds used as whitespace'],
    ['black_backslash.py.txt', 'a line that is nothing but a backslash'],
  ] as const;

  for (const [name, why] of exotic) {
    it(`${name} — ${why} → skipped`, () => {
      expect(findPythonIndentErrors(load(name))).toEqual([]);
    });
  }
});

describe('pythonIndent: the checker still bites on real IndentationErrors', () => {
  // The corpus proves it is quiet on valid code. This proves the quiet is not
  // because it has been neutered.
  it('flags the orphaned body — the corruption class this exists for', () => {
    const orphaned = 'def welcome(name):\n    return name\n\n\ndef f(): return 1\n    return 2\n';
    const errors = findPythonIndentErrors(orphaned);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/unexpected indent/i);
  });

  it('flags a bad dedent inside an otherwise real-looking file', () => {
    const bad = 'class A:\n    def f(self):\n        x = 1\n      y = 2\n';
    expect(findPythonIndentErrors(bad).length).toBeGreaterThan(0);
  });
});
