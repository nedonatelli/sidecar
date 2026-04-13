/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';

// We mock vscode inline here because jsDocSyncProvider needs a richer surface
// (Diagnostic, CodeAction, CodeActionKind, WorkspaceEdit with delete/insert)
// than the shared src/__mocks__/vscode.ts currently exposes. Keeping the
// enrichment local avoids disturbing other test suites.
vi.mock('vscode', () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }
  class Diagnostic {
    source?: string;
    code?: string;
    constructor(
      public range: Range,
      public message: string,
      public severity: number,
    ) {}
  }
  class WorkspaceEdit {
    deletes: { uri: unknown; range: Range }[] = [];
    inserts: { uri: unknown; position: Position; text: string }[] = [];
    delete(uri: unknown, range: Range): void {
      this.deletes.push({ uri, range });
    }
    insert(uri: unknown, position: Position, text: string): void {
      this.inserts.push({ uri, position, text });
    }
  }
  class CodeAction {
    diagnostics?: Diagnostic[];
    isPreferred?: boolean;
    edit?: WorkspaceEdit;
    constructor(
      public title: string,
      public kind: number,
    ) {}
  }
  const CodeActionKind = { QuickFix: 1 };
  const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
  return {
    Position,
    Range,
    Diagnostic,
    WorkspaceEdit,
    CodeAction,
    CodeActionKind,
    DiagnosticSeverity,
    languages: { createDiagnosticCollection: vi.fn(), registerCodeActionsProvider: vi.fn() },
    workspace: {
      onDidSaveTextDocument: vi.fn(),
      onDidOpenTextDocument: vi.fn(),
      onDidChangeConfiguration: vi.fn(),
      textDocuments: [],
    },
  };
});

import {
  toDiagnostics,
  buildOrphanFix,
  buildMissingFix,
  computeInsertion,
  computeLineDeletionRange,
} from './jsDocSyncProvider.js';
import { findDocumentedFunctions, type DocumentedFunction } from './jsDocSync.js';
import { Range, Position, Diagnostic, DiagnosticSeverity, WorkspaceEdit } from 'vscode';

/**
 * Minimal TextDocument stand-in. jsDocSyncProvider only touches `uri`,
 * `lineAt(n)`, `lineCount`, and `getText()`, so we expose just those.
 */
function makeDoc(source: string): any {
  const lines = source.split('\n');
  return {
    uri: { scheme: 'file', fsPath: '/test.ts', path: '/test.ts' },
    languageId: 'typescript',
    getText: () => source,
    lineCount: lines.length,
    lineAt: (n: number) => ({ text: lines[n] ?? '' }),
  };
}

function makeMissingDiagnostic(fnName: string, paramName: string, declLine: number): Diagnostic {
  const d = new Diagnostic(
    new Range(new Position(declLine, 0), new Position(declLine, Number.MAX_SAFE_INTEGER)),
    `${fnName}() has a parameter '${paramName}' with no matching @param tag`,
    DiagnosticSeverity.Warning,
  );
  d.source = 'SideCar JSDoc sync';
  d.code = 'jsdoc-missing-param';
  return d;
}

function makeOrphanDiagnostic(fnName: string, paramName: string, paramLine: number): Diagnostic {
  const d = new Diagnostic(
    new Range(new Position(paramLine, 0), new Position(paramLine, Number.MAX_SAFE_INTEGER)),
    `@param ${paramName} — '${paramName}' is no longer a parameter of ${fnName}()`,
    DiagnosticSeverity.Warning,
  );
  d.source = 'SideCar JSDoc sync';
  d.code = 'jsdoc-orphan-param';
  return d;
}

describe('toDiagnostics', () => {
  it('produces one warning per orphan tag, anchored to the tag line', () => {
    const src = `/**
 * @param a first
 * @param b stale
 */
function one(a: number) {}`;
    const fns = findDocumentedFunctions(src);
    const fn = fns[0];
    const diags = toDiagnostics({ fn, orphanTags: ['b'], missingTags: [] });
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'b' is no longer a parameter of one()");
    expect(diags[0].range.start.line).toBe(fn.jsDocParamLines[fn.jsDocParamNames.indexOf('b')]);
    expect(diags[0].code).toBe('jsdoc-orphan-param');
  });

  it('produces one warning per missing tag, anchored to the decl line', () => {
    const src = `/**
 * @param a first
 */
function grew(a: number, b: number) {}`;
    const fns = findDocumentedFunctions(src);
    const fn = fns[0];
    const diags = toDiagnostics({ fn, orphanTags: [], missingTags: ['b'] });
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("grew() has a parameter 'b' with no matching @param tag");
    expect(diags[0].range.start.line).toBe(fn.declLine);
    expect(diags[0].code).toBe('jsdoc-missing-param');
  });

  it('returns multiple diagnostics when a function has both orphan and missing tags', () => {
    const src = `/**
 * @param oldName stuff
 */
function renamed(newName: string) {}`;
    const fns = findDocumentedFunctions(src);
    const diags = toDiagnostics({
      fn: fns[0],
      orphanTags: ['oldName'],
      missingTags: ['newName'],
    });
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.code).sort()).toEqual(['jsdoc-missing-param', 'jsdoc-orphan-param']);
  });
});

describe('computeLineDeletionRange', () => {
  it('removes a normal line including its trailing newline', () => {
    const doc = makeDoc('alpha\nbravo\ncharlie');
    const range = computeLineDeletionRange(doc, 1);
    expect(range.start.line).toBe(1);
    expect(range.start.character).toBe(0);
    expect(range.end.line).toBe(2);
    expect(range.end.character).toBe(0);
  });

  it('removes the last line by consuming the preceding newline', () => {
    const doc = makeDoc('alpha\nbravo\ncharlie');
    const range = computeLineDeletionRange(doc, 2);
    expect(range.start.line).toBe(1);
    expect(range.start.character).toBe(5); // end of "bravo"
    expect(range.end.line).toBe(2);
    expect(range.end.character).toBe(7); // end of "charlie"
  });

  it('clears content in place for a single-line file', () => {
    const doc = makeDoc('only');
    const range = computeLineDeletionRange(doc, 0);
    expect(range.start.line).toBe(0);
    expect(range.start.character).toBe(0);
    expect(range.end.line).toBe(0);
    expect(range.end.character).toBe(4);
  });

  it('handles line-0 deletion in a multi-line file without leaving a blank line', () => {
    const doc = makeDoc('first\nsecond\nthird');
    const range = computeLineDeletionRange(doc, 0);
    // Normal-line branch: (0, 0) -> (1, 0). Consumes "first\n".
    expect(range.start.line).toBe(0);
    expect(range.start.character).toBe(0);
    expect(range.end.line).toBe(1);
    expect(range.end.character).toBe(0);
  });
});

describe('buildOrphanFix', () => {
  const src = `/**
 * @param a first
 * @param b stale
 */
function one(a: number) {}`;

  it('returns a quick fix that deletes the orphan line', () => {
    const doc = makeDoc(src);
    const fns = findDocumentedFunctions(src);
    const diag = makeOrphanDiagnostic('one', 'b', 2);
    const action = buildOrphanFix(doc, diag, fns);
    expect(action).not.toBeNull();
    expect(action!.title).toBe('Remove orphan @param b');
    expect(action!.edit).toBeInstanceOf(WorkspaceEdit);
    const edit = action!.edit as any;
    expect(edit.deletes).toHaveLength(1);
    // Deleted range should cover line 2 (the " * @param b stale" line).
    expect(edit.deletes[0].range.start.line).toBe(2);
  });

  it('looks up the function by name so it survives stale line numbers', () => {
    // Diagnostic captured from an earlier state where line 2 was the orphan.
    // Then the user applied another edit — the current file has the orphan
    // on line 3 instead. The fix should still find the orphan by name.
    const currentSrc = `/**
 * Prelude added after the diagnostic was captured.
 * @param a first
 * @param b stale
 */
function one(a: number) {}`;
    const doc = makeDoc(currentSrc);
    const fns = findDocumentedFunctions(currentSrc);
    const diag = makeOrphanDiagnostic('one', 'b', 2); // stale range
    const action = buildOrphanFix(doc, diag, fns);
    expect(action).not.toBeNull();
    const edit = action!.edit as any;
    // Should resolve to the CURRENT line of `@param b`, not the stale line 2.
    expect(edit.deletes[0].range.start.line).toBe(3);
  });

  it('returns null when the diagnostic message does not match the expected shape', () => {
    const doc = makeDoc(src);
    const fns = findDocumentedFunctions(src);
    const bogus = new Diagnostic(
      new Range(new Position(2, 0), new Position(2, 999)),
      'something unrelated',
      DiagnosticSeverity.Warning,
    );
    expect(buildOrphanFix(doc, bogus, fns)).toBeNull();
  });

  it('returns null when the owning function is no longer in the parsed list', () => {
    const doc = makeDoc('// empty file');
    const diag = makeOrphanDiagnostic('missingFn', 'b', 2);
    expect(buildOrphanFix(doc, diag, [] as DocumentedFunction[])).toBeNull();
  });
});

describe('buildMissingFix', () => {
  it('inserts a new @param line after the last existing @param', () => {
    const src = `/**
 * @param a first
 */
function grew(a: number, b: number) {}`;
    const doc = makeDoc(src);
    const fns = findDocumentedFunctions(src);
    const diag = makeMissingDiagnostic('grew', 'b', fns[0].declLine);
    const action = buildMissingFix(doc, diag, fns);
    expect(action).not.toBeNull();
    expect(action!.title).toBe('Add missing @param b');
    const edit = action!.edit as any;
    expect(edit.inserts).toHaveLength(1);
    // Insert should be anchored to the line *after* the last existing @param.
    expect(edit.inserts[0].position.line).toBe(2);
    expect(edit.inserts[0].text).toContain('@param b');
  });

  it('looks up the function by name so it survives stale decl lines', () => {
    const currentSrc = `// Prelude added after the diagnostic was captured.
// Two extra lines pushing the function down.

/**
 * @param a first
 */
function grew(a: number, b: number) {}`;
    const doc = makeDoc(currentSrc);
    const fns = findDocumentedFunctions(currentSrc);
    // Stale decl line — grew() now starts at line 6, not line 3.
    const diag = makeMissingDiagnostic('grew', 'b', 3);
    const action = buildMissingFix(doc, diag, fns);
    expect(action).not.toBeNull();
    const edit = action!.edit as any;
    // Should still insert inside the JSDoc block above the current grew() decl.
    expect(edit.inserts[0].position.line).toBe(5);
  });

  it('returns null when the message does not match the expected shape', () => {
    const src = `/**
 * @param a first
 */
function grew(a: number, b: number) {}`;
    const doc = makeDoc(src);
    const fns = findDocumentedFunctions(src);
    const bogus = new Diagnostic(
      new Range(new Position(3, 0), new Position(3, 999)),
      'something unrelated',
      DiagnosticSeverity.Warning,
    );
    expect(buildMissingFix(doc, bogus, fns)).toBeNull();
  });

  it('returns null when the function is missing from the parsed list', () => {
    const doc = makeDoc('// empty file');
    const diag = makeMissingDiagnostic('phantom', 'b', 0);
    expect(buildMissingFix(doc, diag, [] as DocumentedFunction[])).toBeNull();
  });
});

describe('computeInsertion', () => {
  it('inserts after the last existing @param when tags are present', () => {
    const src = `/**
 * @param a first
 * @param b second
 */
function f(a: number, b: number, c: number) {}`;
    const doc = makeDoc(src);
    const fn = findDocumentedFunctions(src)[0];
    const result = computeInsertion(doc, fn, 'c');
    expect(result).not.toBeNull();
    expect(result!.position.line).toBe(3); // line right after the last @param (line 2)
    expect(result!.text).toMatch(/@param c/);
    expect(result!.text).toMatch(/^ \*/); // preserves the " * " prefix
  });

  it('inserts before @returns when no @param tags exist yet', () => {
    const src = `/**
 * Does a thing.
 * @returns nothing
 */
function f(x: number) {}`;
    const doc = makeDoc(src);
    const fn = findDocumentedFunctions(src)[0];
    const result = computeInsertion(doc, fn, 'x');
    expect(result).not.toBeNull();
    // @returns is on line 2 — insertion anchors on that same line so the new
    // @param lands above it.
    expect(result!.position.line).toBe(2);
  });

  it('inserts before the closing comment when there is no @param and no @returns', () => {
    const src = `/**
 * Just a description.
 */
function f(x: number) {}`;
    const doc = makeDoc(src);
    const fn = findDocumentedFunctions(src)[0];
    const result = computeInsertion(doc, fn, 'x');
    expect(result).not.toBeNull();
    // jsDocEndLine is line 2 (the closing); insertion goes on that line.
    expect(result!.position.line).toBe(2);
  });

  it('returns null when the function has no JSDoc block', () => {
    const fn: DocumentedFunction = {
      name: 'bare',
      declLine: 0,
      paramNames: ['x'],
      hasDestructuredOrRest: false,
      jsDocStartLine: null,
      jsDocEndLine: null,
      jsDocParamNames: [],
      jsDocParamLines: [],
    };
    const doc = makeDoc('function bare(x: number) {}');
    expect(computeInsertion(doc, fn, 'x')).toBeNull();
  });
});
