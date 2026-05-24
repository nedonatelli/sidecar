import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { SidecarCodeLensProvider, findSymbolEnd } from './sidecarCodeLensProvider.js';

function makeDoc(languageId: string, lines: string[]): vscode.TextDocument {
  return {
    languageId,
    lineCount: lines.length,
    lineAt: (i: number) => ({
      text: lines[i],
      isEmptyOrWhitespace: lines[i].trim() === '',
      firstNonWhitespaceCharacterIndex: lines[i].length - lines[i].trimStart().length,
      range: { start: { line: i, character: 0 }, end: { line: i, character: lines[i].length } },
    }),
    getText: () => lines.join('\n'),
  } as unknown as vscode.TextDocument;
}

const noToken = {} as vscode.CancellationToken;

// ---------------------------------------------------------------------------
// findSymbolEnd
// ---------------------------------------------------------------------------

describe('findSymbolEnd — brace-based languages', () => {
  it('finds closing brace of a simple function', () => {
    const doc = makeDoc('typescript', [
      'function foo() {', // 0
      '  return 1;', // 1
      '}', // 2
    ]);
    expect(findSymbolEnd(doc, 0)).toBe(2);
  });

  it('handles nested braces', () => {
    const doc = makeDoc('typescript', [
      'function bar() {', // 0
      '  if (x) {', // 1
      '    return { a: 1 };', // 2
      '  }', // 3
      '}', // 4
    ]);
    expect(findSymbolEnd(doc, 0)).toBe(4);
  });

  it('caps at document end when no closing brace', () => {
    const lines = ['function unclosed() {', ...Array(10).fill('  x++;')];
    const doc = makeDoc('typescript', lines);
    expect(findSymbolEnd(doc, 0)).toBe(lines.length - 1);
  });
});

describe('findSymbolEnd — Python', () => {
  it('ends at the line before the next def at same indent', () => {
    const doc = makeDoc('python', [
      'def foo():', // 0
      '    x = 1', // 1
      '', // 2
      'def bar():', // 3
      '    pass', // 4
    ]);
    expect(findSymbolEnd(doc, 0)).toBe(2);
  });

  it('ends at the line before a class at same indent', () => {
    const doc = makeDoc('python', [
      'class Foo:', // 0
      '    x = 1', // 1
      '', // 2
      'class Bar:', // 3
    ]);
    expect(findSymbolEnd(doc, 0)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SidecarCodeLensProvider
// ---------------------------------------------------------------------------

describe('SidecarCodeLensProvider', () => {
  const provider = new SidecarCodeLensProvider();

  it('emits three lenses per function (Explain / Add tests / Refactor)', () => {
    const doc = makeDoc('typescript', ['export function doSomething() {', '  return 42;', '}']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(3);
    const titles = lenses.map((l) => l.command?.title);
    expect(titles).toContain('⚡ Explain');
    expect(titles).toContain('⚡ Add tests');
    expect(titles).toContain('⚡ Refactor');
  });

  it('all three lenses share the same startLine', () => {
    const doc = makeDoc('typescript', ['async function fetchData() {', '  return 1;', '}']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    const starts = lenses.map((l) => (l.command?.arguments?.[0] as { startLine: number }).startLine);
    expect(new Set(starts).size).toBe(1);
    expect(starts[0]).toBe(0);
  });

  it('emits one Fix lens for a TODO comment', () => {
    const doc = makeDoc('typescript', ['const x = 1;', '// TODO: fix this', 'const y = 2;']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command?.title).toBe('⚡ Fix');
    expect(lenses[0].command?.arguments?.[0]).toMatchObject({ action: 'fix', startLine: 1 });
  });

  it('emits Fix for FIXME in Python', () => {
    const doc = makeDoc('python', ['x = 1', '# FIXME: broken', 'y = 2']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command?.title).toBe('⚡ Fix');
  });

  it('emits three lenses for a Python def', () => {
    const doc = makeDoc('python', ['def foo():', '    pass']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(3);
    expect(lenses.map((l) => l.command?.title)).toContain('⚡ Explain');
  });

  it('emits three lenses for a Go func (correct startLine)', () => {
    const doc = makeDoc('go', ['package main', '', 'func main() {', '}']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses.length).toBe(3);
    const start = (lenses[0].command?.arguments?.[0] as { startLine: number }).startLine;
    expect(start).toBe(2);
  });

  it('returns zero lenses for an empty file', () => {
    const doc = makeDoc('typescript', []);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(0);
  });

  it('caps at MAX_SYMBOLS * 3 lenses for a dense file', () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`export function fn${i}() {}`);
    const doc = makeDoc('typescript', lines);
    const lenses = provider.provideCodeLenses(doc, noToken);
    // MAX_SYMBOLS = 25, each emits 3 → max 75
    expect(lenses.length).toBeLessThanOrEqual(75);
  });

  it('respects CLUSTER_GAP — only first of adjacent symbols gets lenses', () => {
    const doc = makeDoc('typescript', [
      'export function a() {}', // 0 → lenses
      'export function b() {}', // 1 → skipped (gap ≤ 3)
      'export function c() {}', // 2 → skipped
      'export function d() {}', // 3 → skipped
      'export function e() {}', // 4 → lenses (gap = 4)
    ]);
    const lenses = provider.provideCodeLenses(doc, noToken);
    const explainLenses = lenses.filter((l) => l.command?.title === '⚡ Explain');
    expect(explainLenses.length).toBe(2);
  });

  it('resolveCodeLens returns the lens unchanged', () => {
    const doc = makeDoc('typescript', ['export function foo() {}']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    const resolved = provider.resolveCodeLens(lenses[0], noToken);
    expect(resolved).toBe(lenses[0]);
  });

  it('returns empty for an unsupported language', () => {
    const doc = makeDoc('sql', ['SELECT * FROM users;']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(0);
  });
});
