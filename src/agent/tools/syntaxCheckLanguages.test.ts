import { describe, it, expect } from 'vitest';
import { checkSyntax, editWouldBreakSyntax } from './syntaxCheck.js';

describe('syntax guard: languages beyond TypeScript', () => {
  it('detects broken Python (the language the original gate was built for)', async () => {
    const clean = 'def greet(name: str) -> str:\n    return f"Hello, {name}!"\n';
    const broken = 'def welcome(name: str) -> str\n    return f"Hello, {name}!"\n'; // missing colon
    expect((await checkSyntax('a.py', clean)).broken).toBe(false);
    expect((await checkSyntax('a.py', broken)).broken).toBe(true);
    expect((await editWouldBreakSyntax('a.py', clean, broken)).refuse).toBe(true);
  });

  it('catches Python INDENTATION errors too (tree-sitter alone does not)', () => {
    // tree-sitter-python parses an orphaned indented line and a mis-indented
    // block as CLEAN. In Python the corruption class this guard exists for —
    // replacing a block header with a one-liner, orphaning the body — IS an
    // indentation error, so the tree-sitter check is layered with a dedicated
    // indent scanner (validated against 4,001 CPython-accepted files).
    return (async () => {
      const clean = 'def greet(name):\n    return name\n';
      const orphaned = 'def welcome(name): return name\n    return name\n';
      const misIndented = 'def f():\n    x = 1\n  y = 2\n';
      const noColon = 'def welcome(name) -> str\n    return name\n';

      expect((await editWouldBreakSyntax('a.py', clean, orphaned)).refuse).toBe(true);
      expect((await editWouldBreakSyntax('a.py', clean, misIndented)).refuse).toBe(true);
      expect((await editWouldBreakSyntax('a.py', clean, noColon)).refuse).toBe(true);

      // …and valid Python is still accepted.
      const renamed = 'def welcome(name):\n    return name\n';
      expect((await editWouldBreakSyntax('a.py', clean, renamed)).refuse).toBe(false);
    })();
  });

  it('detects broken Rust, Go, and Java too', async () => {
    const cases: Array<[string, string, string]> = [
      ['a.rs', 'fn main() { println!("hi"); }\n', 'fn main() { println!("hi"); \n'],
      ['a.go', 'package main\nfunc main() {}\n', 'package main\nfunc main( {}\n'],
      ['a.java', 'class A { void f() {} }\n', 'class A { void f( {} }\n'],
    ];
    for (const [file, clean, broken] of cases) {
      expect((await checkSyntax(file, clean)).broken, `${file} clean`).toBe(false);
      expect((await checkSyntax(file, broken)).broken, `${file} broken`).toBe(true);
    }
  });
});

describe('syntax guard: scale', () => {
  const bigFile = (() => {
    const fns = Array.from(
      { length: 500 },
      (_, i) => `export function step${i}(v: number): number {\n  return v + ${i};\n}\n`,
    ).join('\n');
    return `// pipeline\n${fns}export const N = 500;\n`;
  })();

  it('parses a ~2000-line file well inside the 10s timeout', async () => {
    const t0 = Date.now();
    const result = await checkSyntax('big.ts', bigFile);
    const elapsed = Date.now() - t0;

    expect(result.checked).toBe(true); // NOT a timeout — a timed-out guard silently disables itself
    expect(result.broken).toBe(false);
    expect(elapsed).toBeLessThan(2000); // generous; a stall would blow this
  });

  it('still catches a break in a large file, and both parses stay fast', async () => {
    const broken = bigFile.replace(
      'export function step250(v: number): number {',
      'export function step250(v: number: number {',
    );
    const t0 = Date.now();
    const verdict = await editWouldBreakSyntax('big.ts', bigFile, broken);
    const elapsed = Date.now() - t0;

    expect(verdict.refuse).toBe(true); // before+after parse, both large
    expect(elapsed).toBeLessThan(3000);
  });
});
