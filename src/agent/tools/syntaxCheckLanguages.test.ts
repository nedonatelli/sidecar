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

  it('KNOWN LIMIT: tree-sitter does not flag Python INDENTATION errors — py_compile does', async () => {
    // Verified against the shipped grammar: tree-sitter-python parses both an
    // orphaned indented line and a mis-indented block as CLEAN (it flags
    // structural breaks like a missing colon, but not indentation).
    //
    // This is not a hole, because the layers cover each other: the
    // completion-time syntax gate still shells out to `py_compile` for .py
    // files (runSyntaxGate skips the shell checker only for files the
    // in-process pass ALREADY flagged), and py_compile raises IndentationError.
    // Edit-time catches structure; completion-time catches indentation.
    const clean = 'def greet(name):\n    return name\n';
    const orphaned = 'def welcome(name): return name\n    return name\n';
    const misIndented = 'def f():\n    x = 1\n  y = 2\n';

    expect((await editWouldBreakSyntax('a.py', clean, orphaned)).refuse).toBe(false);
    expect((await editWouldBreakSyntax('a.py', clean, misIndented)).refuse).toBe(false);

    // …but a STRUCTURAL Python break is caught at edit time.
    const noColon = 'def welcome(name) -> str\n    return name\n';
    expect((await editWouldBreakSyntax('a.py', clean, noColon)).refuse).toBe(true);
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
