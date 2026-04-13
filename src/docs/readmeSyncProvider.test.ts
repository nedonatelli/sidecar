/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Inline vscode mock matching the richer surface this provider needs
// (Diagnostic, CodeAction, WorkspaceEdit.replace, etc). Kept local so the
// shared src/__mocks__/vscode.ts doesn't have to grow for one test suite.
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
    replaces: { uri: unknown; range: Range; newText: string }[] = [];
    replace(uri: unknown, range: Range, newText: string): void {
      this.replaces.push({ uri, range, newText });
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
  return {
    Position,
    Range,
    Diagnostic,
    WorkspaceEdit,
    CodeAction,
    CodeActionKind: { QuickFix: 1 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    languages: {
      createDiagnosticCollection: vi.fn(),
      registerCodeActionsProvider: vi.fn(),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/test' } }] as { uri: { fsPath: string } }[],
      textDocuments: [] as unknown[],
      onDidSaveTextDocument: vi.fn(),
      onDidOpenTextDocument: vi.fn(),
      onDidChangeConfiguration: vi.fn(),
      findFiles: vi.fn(async () => []),
      createFileSystemWatcher: vi.fn(() => ({
        onDidCreate: vi.fn(),
        onDidChange: vi.fn(),
        onDidDelete: vi.fn(),
        dispose: vi.fn(),
      })),
      fs: {
        readFile: vi.fn(),
      },
    },
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
    },
    RelativePattern: class {
      constructor(
        public base: unknown,
        public pattern: string,
      ) {}
    },
  };
});

import { toDiagnostic, buildArityFix, isReadmeUri, isSourceFileUri, ExportIndex } from './readmeSyncProvider.js';
import { detectStaleReferences, type ExportedFunction, type StaleReference } from './readmeSync.js';
import { Diagnostic, Position, Range, DiagnosticSeverity, WorkspaceEdit } from 'vscode';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function exp(name: string, paramNames: string[], extras: Partial<ExportedFunction> = {}): ExportedFunction {
  return { name, paramNames, hasDestructuredOrRest: false, declLine: 0, ...extras };
}

function makeExports(fns: ExportedFunction[]): Map<string, ExportedFunction> {
  return new Map(fns.map((f) => [f.name, f]));
}

/** Minimal TextDocument stand-in — the provider only touches uri, getText, lineCount, lineAt. */
function makeDoc(markdown: string): any {
  const lines = markdown.split('\n');
  return {
    uri: { scheme: 'file', fsPath: '/test/README.md', path: '/test/README.md' },
    languageId: 'markdown',
    getText: () => markdown,
    lineCount: lines.length,
    lineAt: (n: number) => ({ text: lines[n] ?? '' }),
  };
}

function makeDiagnostic(ref: StaleReference): Diagnostic {
  return toDiagnostic(ref);
}

// ---------------------------------------------------------------------------
// toDiagnostic
// ---------------------------------------------------------------------------

describe('toDiagnostic', () => {
  it('encodes the function name, expected, and actual counts in the message', () => {
    const md = '```ts\nfoo(1, 2, 3);\n```';
    const stale = detectStaleReferences(md, makeExports([exp('foo', ['a', 'b'])]));
    const diag = toDiagnostic(stale[0]);
    expect(diag.message).toContain('foo() takes 2 arguments');
    expect(diag.message).toContain('passes 3 arguments');
    expect(diag.source).toBe('SideCar README sync');
    expect(diag.code).toBe('readme-stale-call');
    expect(diag.severity).toBe(DiagnosticSeverity.Warning);
  });

  it('uses singular argument wording when expected is 1', () => {
    const md = '```ts\nfoo();\n```';
    const stale = detectStaleReferences(md, makeExports([exp('foo', ['a'])]));
    const diag = toDiagnostic(stale[0]);
    expect(diag.message).toContain('takes 1 argument but');
    expect(diag.message).toContain('0 arguments');
  });

  it('anchors the diagnostic range to the call expression', () => {
    const md = ['# Title', '', '```ts', '  foo(1, 2, 3);', '```'].join('\n');
    const stale = detectStaleReferences(md, makeExports([exp('foo', ['a'])]));
    const diag = toDiagnostic(stale[0]);
    expect(diag.range.start.line).toBe(3);
    expect(diag.range.start.character).toBe(2);
    expect(diag.range.end.line).toBe(3);
    // `foo(1, 2, 3)` is 12 chars long, starting at column 2
    expect(diag.range.end.character).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// buildArityFix
// ---------------------------------------------------------------------------

describe('buildArityFix', () => {
  it('drops trailing args when the call has too many', () => {
    const md = '```ts\nfoo(1, 2, 3);\n```';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    const stale = detectStaleReferences(md, exports);
    const diag = makeDiagnostic(stale[0]);
    const action = buildArityFix(makeDoc(md), diag, stale, exports);
    expect(action).not.toBeNull();
    const edit = action!.edit as WorkspaceEdit & { replaces: { newText: string }[] };
    expect(edit.replaces).toHaveLength(1);
    expect(edit.replaces[0].newText).toBe('foo(1, 2)');
  });

  it('appends missing parameter names when the call has too few', () => {
    const md = '```ts\nfoo(1);\n```';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    const stale = detectStaleReferences(md, exports);
    const diag = makeDiagnostic(stale[0]);
    const action = buildArityFix(makeDoc(md), diag, stale, exports);
    expect(action).not.toBeNull();
    const edit = action!.edit as WorkspaceEdit & { replaces: { newText: string }[] };
    expect(edit.replaces[0].newText).toBe('foo(1, b)');
  });

  it('returns null when the diagnostic message does not match the expected shape', () => {
    const md = '```ts\nfoo(1);\n```';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    const stale = detectStaleReferences(md, exports);
    const bogus = new Diagnostic(
      new Range(new Position(1, 0), new Position(1, 999)),
      'something unrelated',
      DiagnosticSeverity.Warning,
    );
    const action = buildArityFix(makeDoc(md), bogus, stale, exports);
    expect(action).toBeNull();
  });

  it('returns null when no current stale reference matches the diagnostic line', () => {
    const md = '```ts\nfoo(1);\n```';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    const stale = detectStaleReferences(md, exports);
    const diag = makeDiagnostic(stale[0]);
    // Override the diagnostic's line so nothing in `stale` will match it.
    (diag.range as any).start = new Position(999, 0);
    const action = buildArityFix(makeDoc(md), diag, stale, exports);
    expect(action).toBeNull();
  });

  it('matches by function name so stale column numbers still resolve', () => {
    // Diagnostic produced before a column-level edit to the call — the same
    // line holds the same call but at a different startCol. buildArityFix
    // uses current stale data to compute the edit, so this still works.
    const md = '```ts\n  foo(1, 2, 3);\n```';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    const stale = detectStaleReferences(md, exports);
    const diag = makeDiagnostic(stale[0]);
    // Pretend the diagnostic was captured with a stale startCol=0.
    (diag.range as any).start = new Position(1, 0);
    const action = buildArityFix(makeDoc(md), diag, stale, exports);
    expect(action).not.toBeNull();
    const edit = action!.edit as WorkspaceEdit & { replaces: { newText: string; range: Range }[] };
    // Edit should target the actual call position, not the diagnostic's range.
    expect(edit.replaces[0].newText).toBe('foo(1, 2)');
    expect(edit.replaces[0].range.start.character).toBe(2);
  });

  it('builds a descriptive action title', () => {
    const md = '```ts\nfoo(1, 2, 3);\n```';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    const stale = detectStaleReferences(md, exports);
    const diag = makeDiagnostic(stale[0]);
    const action = buildArityFix(makeDoc(md), diag, stale, exports);
    expect(action!.title).toBe('Update call to foo() (2 arguments)');
  });

  it('uses singular wording for a 1-argument signature', () => {
    const md = '```ts\nfoo(1, 2);\n```';
    const exports = makeExports([exp('foo', ['a'])]);
    const stale = detectStaleReferences(md, exports);
    const diag = makeDiagnostic(stale[0]);
    const action = buildArityFix(makeDoc(md), diag, stale, exports);
    expect(action!.title).toBe('Update call to foo() (1 argument)');
  });
});

// ---------------------------------------------------------------------------
// isReadmeUri / isSourceFileUri
// ---------------------------------------------------------------------------

describe('isReadmeUri', () => {
  beforeEach(async () => {
    const vscode = await import('vscode');
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/test' } }];
  });

  it('matches README.md at the workspace root', () => {
    expect(isReadmeUri({ fsPath: '/test/README.md' } as any)).toBe(true);
  });

  it('does not match README.md in a subdirectory', () => {
    expect(isReadmeUri({ fsPath: '/test/docs/README.md' } as any)).toBe(false);
  });

  it('does not match other markdown files at the root', () => {
    expect(isReadmeUri({ fsPath: '/test/CONTRIBUTING.md' } as any)).toBe(false);
  });

  it('is case-sensitive on the filename', () => {
    expect(isReadmeUri({ fsPath: '/test/readme.md' } as any)).toBe(false);
  });
});

describe('isSourceFileUri', () => {
  beforeEach(async () => {
    const vscode = await import('vscode');
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/test' } }];
  });

  it('matches a .ts file under src/', () => {
    expect(isSourceFileUri({ fsPath: '/test/src/foo.ts' } as any)).toBe(true);
  });

  it('matches a .tsx file under src/', () => {
    expect(isSourceFileUri({ fsPath: '/test/src/Component.tsx' } as any)).toBe(true);
  });

  it('matches nested src files', () => {
    expect(isSourceFileUri({ fsPath: '/test/src/docs/readmeSync.ts' } as any)).toBe(true);
  });

  it('does not match files outside src/', () => {
    expect(isSourceFileUri({ fsPath: '/test/scripts/run.ts' } as any)).toBe(false);
  });

  it('does not match node_modules even under src/', () => {
    expect(isSourceFileUri({ fsPath: '/test/src/node_modules/foo/index.ts' } as any)).toBe(false);
  });

  it('does not match non-source extensions', () => {
    expect(isSourceFileUri({ fsPath: '/test/src/styles.css' } as any)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExportIndex
// ---------------------------------------------------------------------------

describe('ExportIndex', () => {
  it('starts empty', () => {
    const index = new ExportIndex();
    expect(index.size).toBe(0);
    expect(index.getByName().size).toBe(0);
  });

  it('indexes exported functions from a scanned file', async () => {
    const index = new ExportIndex();
    const vscode = await import('vscode');
    (vscode.workspace.fs.readFile as any) = vi.fn(async () =>
      Buffer.from(`export function add(a: number, b: number) {}\nexport const mul = (x: number, y: number) => x * y;`),
    );
    await index.scanFile({ fsPath: '/test/src/math.ts' } as any);
    const byName = index.getByName();
    expect(byName.get('add')?.paramNames).toEqual(['a', 'b']);
    expect(byName.get('mul')?.paramNames).toEqual(['x', 'y']);
    expect(index.size).toBe(1);
  });

  it('replaces an existing entry when a file is rescanned', async () => {
    const index = new ExportIndex();
    const vscode = await import('vscode');
    (vscode.workspace.fs.readFile as any) = vi.fn(async () => Buffer.from(`export function foo(a: number) {}`));
    await index.scanFile({ fsPath: '/test/src/foo.ts' } as any);
    expect(index.getByName().get('foo')?.paramNames).toEqual(['a']);

    (vscode.workspace.fs.readFile as any) = vi.fn(async () =>
      Buffer.from(`export function foo(a: number, b: number) {}`),
    );
    await index.scanFile({ fsPath: '/test/src/foo.ts' } as any);
    expect(index.getByName().get('foo')?.paramNames).toEqual(['a', 'b']);
    expect(index.size).toBe(1);
  });

  it('drops a file when remove() is called', async () => {
    const index = new ExportIndex();
    const vscode = await import('vscode');
    (vscode.workspace.fs.readFile as any) = vi.fn(async () => Buffer.from(`export function foo(a: number) {}`));
    await index.scanFile({ fsPath: '/test/src/foo.ts' } as any);
    expect(index.size).toBe(1);
    index.remove({ fsPath: '/test/src/foo.ts' } as any);
    expect(index.size).toBe(0);
    expect(index.getByName().size).toBe(0);
  });

  it('drops a file when scanning throws (unreadable / deleted)', async () => {
    const index = new ExportIndex();
    const vscode = await import('vscode');
    // First scan succeeds.
    (vscode.workspace.fs.readFile as any) = vi.fn(async () => Buffer.from(`export function foo(a: number) {}`));
    await index.scanFile({ fsPath: '/test/src/foo.ts' } as any);
    expect(index.size).toBe(1);
    // Second scan fails — the entry should be removed.
    (vscode.workspace.fs.readFile as any) = vi.fn(async () => {
      throw new Error('gone');
    });
    await index.scanFile({ fsPath: '/test/src/foo.ts' } as any);
    expect(index.size).toBe(0);
  });

  it('returns the first-scanned definition when multiple files export the same name', async () => {
    const index = new ExportIndex();
    const vscode = await import('vscode');
    (vscode.workspace.fs.readFile as any) = vi.fn(async () => Buffer.from(`export function foo(a: number) {}`));
    await index.scanFile({ fsPath: '/test/src/a.ts' } as any);
    (vscode.workspace.fs.readFile as any) = vi.fn(async () =>
      Buffer.from(`export function foo(x: number, y: number) {}`),
    );
    await index.scanFile({ fsPath: '/test/src/b.ts' } as any);
    // First one wins. Documents current behavior; if we change collision
    // handling later, this test will flag the intentional change.
    expect(index.getByName().get('foo')?.paramNames).toEqual(['a']);
  });
});
