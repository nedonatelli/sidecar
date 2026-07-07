import { describe, it, expect } from 'vitest';
import { findBlockEnd, findIndentEnd, parseImport, resolveImportPath } from './importScan.js';

describe('findBlockEnd', () => {
  it('finds the closing brace on the same line', () => {
    const lines = ['function f() { return 1; }', 'const x = 2;'];
    expect(findBlockEnd(lines, 0)).toBe(0);
  });

  it('finds the closing brace across multiple lines', () => {
    const lines = ['function f() {', '  return 1;', '}', 'const after = 1;'];
    expect(findBlockEnd(lines, 0)).toBe(2);
  });

  it('handles nested braces', () => {
    const lines = ['class C {', '  m() {', '    if (x) { y(); }', '  }', '}'];
    expect(findBlockEnd(lines, 0)).toBe(4);
  });

  it('returns the last line when the block is never closed', () => {
    const lines = ['function f() {', '  return 1;'];
    expect(findBlockEnd(lines, 0)).toBe(1);
  });

  it('starts counting from the given line, not the file start', () => {
    const lines = ['const a = { x: 1 };', 'function g() {', '  z();', '}'];
    expect(findBlockEnd(lines, 1)).toBe(3);
  });
});

describe('findIndentEnd', () => {
  it('returns the last line of a Python-style indented block', () => {
    const lines = ['def f():', '    a = 1', '    b = 2', 'x = 3'];
    expect(findIndentEnd(lines, 0)).toBe(2);
  });

  it('treats blank lines inside the block as part of it', () => {
    const lines = ['def f():', '    a = 1', '', '    b = 2', 'top = 3'];
    expect(findIndentEnd(lines, 0)).toBe(3);
  });

  it('breaks at the first line dedented to or past the definition indent', () => {
    const lines = ['    def nested():', '        body()', '    next_def()'];
    expect(findIndentEnd(lines, 0)).toBe(1);
  });

  it('returns the start line when there is no indented body', () => {
    const lines = ['def f(): pass', 'other()'];
    expect(findIndentEnd(lines, 0)).toBe(0);
  });

  it('extends to the end of file when the block runs to EOF', () => {
    const lines = ['def f():', '    a = 1', '    b = 2'];
    expect(findIndentEnd(lines, 0)).toBe(2);
  });
});

describe('parseImport', () => {
  it('parses a named import with multiple bindings', () => {
    const line = "import { A, B, C } from './mod';";
    expect(parseImport(line, [line], 0)).toEqual({ modulePath: './mod', bindings: ['A', 'B', 'C'], endLine: 0 });
  });

  it('strips `as` aliases from named bindings', () => {
    const line = "import { A as X, B } from './mod';";
    expect(parseImport(line, [line], 0)).toEqual({ modulePath: './mod', bindings: ['A', 'B'], endLine: 0 });
  });

  it('parses a multi-line named import and returns the closing line', () => {
    const lines = ['import {', '  A,', '  B,', "} from './mod';"];
    expect(parseImport(lines[0], lines, 0)).toEqual({ modulePath: './mod', bindings: ['A', 'B'], endLine: 3 });
  });

  it('parses a default import', () => {
    const line = "import Foo from './mod';";
    expect(parseImport(line, [line], 0)).toEqual({ modulePath: './mod', bindings: ['default'], endLine: 0 });
  });

  it('parses a star import', () => {
    const line = "import * as ns from './mod';";
    expect(parseImport(line, [line], 0)).toEqual({ modulePath: './mod', bindings: ['*'], endLine: 0 });
  });

  it('parses a side-effect import (no bindings)', () => {
    const line = "import './styles.css';";
    expect(parseImport(line, [line], 0)).toEqual({ modulePath: './styles.css', bindings: [], endLine: 0 });
  });

  it('returns null for a non-import line', () => {
    const line = 'const x = 1;';
    expect(parseImport(line, [line], 0)).toBeNull();
  });

  it('returns null for an unterminated multi-line import (no closing brace found)', () => {
    const lines = ['import {', '  A,', '  B,']; // never closes
    expect(parseImport(lines[0], lines, 0)).toBeNull();
  });
});

describe('resolveImportPath', () => {
  it('resolves a sibling relative import', () => {
    expect(resolveImportPath('src/a/foo.ts', './bar')).toBe('src/a/bar');
  });

  it('resolves a parent relative import', () => {
    expect(resolveImportPath('src/a/foo.ts', '../bar')).toBe('src/bar');
  });

  it('resolves nested segments and skips `.`', () => {
    expect(resolveImportPath('src/a/foo.ts', './x/y')).toBe('src/a/x/y');
  });

  it('returns null for a non-relative (bare) specifier', () => {
    expect(resolveImportPath('src/a/foo.ts', 'lodash')).toBeNull();
  });

  it('handles an importer with no directory component', () => {
    expect(resolveImportPath('foo.ts', './bar')).toBe('bar');
  });
});
