import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  checkSyntax,
  canParseSyntax,
  editWouldBreakSyntax,
  __setParserForTests,
  __resetParserCache,
} from './syntaxCheck.js';

// #157: the syntax guard's bug fixes. Each case is the issue's failing case, inverted.

afterEach(() => __resetParserCache());

interface FakeNode {
  type: string;
  isMissing?: boolean;
  hasError?: boolean;
  startPosition?: { row: number; column: number };
  childCount: number;
  child(i: number): FakeNode | null;
}
const node = (over: Partial<FakeNode> & { children?: FakeNode[] } = {}): FakeNode => {
  const children = over.children ?? [];
  return { type: 'program', childCount: children.length, child: (i) => children[i] ?? null, ...over };
};

describe('ML-30: every parse tree is freed', () => {
  // Trees live on the WASM heap and are never garbage-collected. Measured with
  // the real TypeScript grammar on a 347 KB file: before the fix the guard
  // stopped checking after 105 calls (every later call: unchecked = allowed);
  // after it, 3,000 calls all checked.
  it('frees the tree after a clean parse, an error parse, and a parse with no root', async () => {
    const deletes = vi.fn();
    const trees = [
      { rootNode: node({ hasError: false }), delete: deletes },
      {
        rootNode: node({ hasError: true, children: [node({ type: 'ERROR', startPosition: { row: 0, column: 0 } })] }),
        delete: deletes,
      },
      { rootNode: undefined as unknown as FakeNode, delete: deletes },
    ];
    let i = 0;
    __setParserForTests('typescript', { parse: () => trees[i++] });
    expect((await checkSyntax('a.ts', 'x')).broken).toBe(false);
    expect((await checkSyntax('a.ts', 'x')).broken).toBe(true);
    expect((await checkSyntax('a.ts', 'x')).checked).toBe(false);
    expect(deletes).toHaveBeenCalledTimes(3);
  });
});

describe('ML-49: "the first parse error" is the first in the file', () => {
  it('names line 2, not line 6, for errors on lines 2 and 6', async () => {
    const src = [
      'const a = 1;',
      'const b = (;',
      'const c = 3;',
      'const d = 4;',
      'const e = 5;',
      'function f( {',
      '',
    ].join('\n');
    const r = await checkSyntax('t2.ts', src);
    expect(r.broken).toBe(true);
    expect(r.firstErrorLine).toBe(2);
  });
});

describe('ML-45: a tree that has an error the walk cannot reach counts it', () => {
  it('root hasError with no ERROR or MISSING node found is one error, not zero', async () => {
    // A hidden MISSING token: the root reports an error, every visible child is clean.
    __setParserForTests('typescript', {
      parse: () => ({ rootNode: node({ hasError: true, children: [node({ type: 'statement', hasError: false })] }) }),
    });
    const r = await checkSyntax('a.ts', 'x');
    expect(r).toMatchObject({ checked: true, broken: true, errorCount: 1 });
  });
});

describe('ML-47: sibling extensions are checked', () => {
  it.each([
    ['a.mts', 'export const x = (;\n'],
    ['a.cts', 'export const x = (;\n'],
    ['a.pyi', 'def f(x: int) -> int\n'],
    ['a.h', 'class A { int x; \n'],
    ['a.hpp', 'class A { int x; \n'],
    ['a.cc', 'int main( { return 0; }\n'],
    ['a.kts', 'fun main( { }\n'],
  ])('%s is parsed and a broken file is caught', async (file, broken) => {
    expect(canParseSyntax(file)).toBe(true);
    const r = await checkSyntax(file, broken);
    expect(r.checked).toBe(true);
    expect(r.broken).toBe(true);
  });

  it('a C++ header parses clean as .h (read with the C++ grammar, not C)', async () => {
    const r = await checkSyntax('a.h', 'namespace n {\nclass A {\n public:\n  int x() const { return 1; }\n};\n}\n');
    expect(r).toMatchObject({ checked: true, broken: false });
  });
});

describe('ML-09: the guard refuses an edit that orphans a Python else', () => {
  it('refuses replacing `if x >= 0:` + body with `return 1` (CPython: invalid syntax at line 3)', async () => {
    const sign = ['def sign(x):', '    if x >= 0:', '        return 1', '    else:', '        return -1', ''].join(
      '\n',
    );
    const edited = sign.replace('    if x >= 0:\n        return 1', '    return 1');
    const r = await editWouldBreakSyntax('m.py', sign, edited);
    expect(r.refuse).toBe(true);
    expect(r.message).toMatch(/line 3/);
  });
});

describe('ML-39: no coverage is claimed for a grammar that cannot run', () => {
  it('.dart is not claimed (its grammar is ABI 15; the runtime reads 13-14)', () => {
    expect(canParseSyntax('main.dart')).toBe(false);
  });

  it('a grammar that failed to load stops being claimed', () => {
    expect(canParseSyntax('a.rs')).toBe(true);
    __setParserForTests('rust', null);
    expect(canParseSyntax('a.rs')).toBe(false);
  });
});

describe('ML-50: a Python file with more indentation errors than the cap says so', () => {
  it('sets saturated when the indent scan hit its cap', async () => {
    const { checkSyntax } = await import('./syntaxCheck.js');
    const messy = Array.from({ length: 60 }, (_, i) => (i % 2 ? '    x = 1' : 'y = 2')).join('\n') + '\n';
    const r = await checkSyntax('/w/messy.py', messy);
    expect(r.broken).toBe(true);
    expect(r.saturated).toBe(true);
  });

  it('does not set saturated for a file with a single indentation error', async () => {
    const { checkSyntax } = await import('./syntaxCheck.js');
    const r = await checkSyntax('/w/one.py', 'def f():\n    x = 1\n      y = 2\n');
    expect(r.broken).toBe(true);
    expect(r.saturated).toBeUndefined();
  });
});
