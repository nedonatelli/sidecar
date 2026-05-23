import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { SidecarCodeLensProvider } from './sidecarCodeLensProvider.js';

function makeDoc(languageId: string, lines: string[]): vscode.TextDocument {
  return {
    languageId,
    lineCount: lines.length,
    lineAt: (i: number) => ({
      text: lines[i],
      range: { start: { line: i, character: 0 }, end: { line: i, character: lines[i].length } },
    }),
    getText: () => lines.join('\n'),
  } as unknown as vscode.TextDocument;
}

const noToken = {} as vscode.CancellationToken;

describe('SidecarCodeLensProvider', () => {
  const provider = new SidecarCodeLensProvider();

  it('produces one explain lens for a TypeScript function declaration', () => {
    const doc = makeDoc('typescript', ['export function doSomething() {', '  return 42;', '}']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command?.title).toBe('⚡ SideCar: Explain');
    expect(lenses[0].command?.arguments?.[0]).toMatchObject({ action: 'explain', startLine: 0 });
  });

  it('produces one explain lens for a describe( call', () => {
    const doc = makeDoc('typescript', ["describe('my suite', () => {", '});']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command?.title).toBe('⚡ SideCar: Explain');
  });

  it('produces one fix lens for a TODO comment', () => {
    const doc = makeDoc('typescript', ['const x = 1;', '// TODO: fix this', 'const y = 2;']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command?.title).toBe('⚡ SideCar: Fix');
    expect(lenses[0].command?.arguments?.[0]).toMatchObject({ action: 'fix', startLine: 1 });
  });

  it('produces one fix lens for a FIXME comment in Python', () => {
    const doc = makeDoc('python', ['x = 1', '# FIXME: broken', 'y = 2']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command?.title).toBe('⚡ SideCar: Fix');
  });

  it('produces an explain lens for a Python def', () => {
    const doc = makeDoc('python', ['def foo():', '    pass']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command?.title).toBe('⚡ SideCar: Explain');
  });

  it('produces an explain lens for a Go func', () => {
    const doc = makeDoc('go', ['package main', '', 'func main() {', '}']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command?.arguments?.[0]).toMatchObject({ startLine: 2 });
  });

  it('returns zero lenses for an empty file', () => {
    const doc = makeDoc('typescript', []);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(0);
  });

  it('caps total lenses at 50 for a dense file', () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`export function fn${i}() {}`);
    }
    const doc = makeDoc('typescript', lines);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses.length).toBeLessThanOrEqual(50);
  });

  it('skips lines within the cluster gap of the previous lens', () => {
    const doc = makeDoc('typescript', ['export function a() {}', 'export function b() {}', 'export function c() {}']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    expect(lenses).toHaveLength(1);
  });

  it('resolveCodeLens returns the lens unchanged', () => {
    const doc = makeDoc('typescript', ['export function foo() {}']);
    const lenses = provider.provideCodeLenses(doc, noToken);
    const resolved = provider.resolveCodeLens(lenses[0], noToken);
    expect(resolved).toBe(lenses[0]);
  });
});
