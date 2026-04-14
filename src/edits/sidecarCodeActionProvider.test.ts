import { describe, it, expect } from 'vitest';
import {
  Position,
  Range,
  DiagnosticSeverity,
  type Diagnostic,
  type TextDocument,
  type CodeActionContext,
} from 'vscode';
import { SidecarCodeActionProvider } from './sidecarCodeActionProvider.js';

/** Minimal TextDocument stub — only the methods the provider touches. */
function mockDoc(lines: string[], fileName = '/tmp/example.ts'): TextDocument {
  return {
    fileName,
    lineAt: (line: number) => ({ text: lines[line] || '' }),
    getText: (range?: Range) => {
      if (!range) return lines.join('\n');
      // Simple single-line slice for tests; covers the provider's usage.
      const start = range.start as Position;
      const end = range.end as Position;
      if (start.line === end.line) {
        return (lines[start.line] || '').slice(start.character, end.character);
      }
      return lines.slice(start.line, end.line + 1).join('\n');
    },
  } as unknown as TextDocument;
}

function rng(startLine: number, startChar: number, endLine: number, endChar: number): Range {
  return new Range(new Position(startLine, startChar), new Position(endLine, endChar));
}

function diag(
  line: number,
  message: string,
  severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  source = 'typescript',
  code: string | number = 'TS2339',
): Diagnostic {
  return {
    range: rng(line, 0, line, 10),
    message,
    severity,
    source,
    code,
  } as unknown as Diagnostic;
}

function ctx(diagnostics: Diagnostic[] = []): CodeActionContext {
  return { diagnostics, triggerKind: 1, only: undefined } as unknown as CodeActionContext;
}

describe('SidecarCodeActionProvider', () => {
  const provider = new SidecarCodeActionProvider();

  it('produces no actions when the range is empty and there are no diagnostics', () => {
    const document = mockDoc(['const x = 1;']);
    const range = rng(0, 5, 0, 5); // cursor, no selection
    const actions = provider.provideCodeActions(document, range, ctx());
    expect(actions).toEqual([]);
  });

  it('produces Fix + Explain actions bound to each diagnostic (empty range)', () => {
    // Cursor on a line with an error, no actual selection — the lightbulb
    // scenario. Provider should emit Fix + Explain bound to the diagnostic
    // and nothing else.
    const document = mockDoc(['const x: string = 42;'], '/tmp/types.ts');
    const range = rng(0, 19, 0, 19);
    const d = diag(0, "Type 'number' is not assignable to type 'string'.");
    const actions = provider.provideCodeActions(document, range, ctx([d]));

    expect(actions).toHaveLength(2);

    const fix = actions[0];
    expect(fix.title).toBe('Fix with SideCar');
    expect(fix.diagnostics).toEqual([d]);
    expect(fix.command).toBeDefined();
    expect(fix.command!.command).toBe('sidecar.fixSelection');
    const args = fix.command!.arguments?.[0] as { code: string; fileName: string; diagnostic: string };
    expect(args.code).toBe('const x: string = 42;');
    expect(args.fileName).toBe('types.ts');
    expect(args.diagnostic).toContain('TS2339');
    expect(args.diagnostic).toContain('is not assignable');

    const explain = actions[1];
    expect(explain.title).toBe('Explain this error with SideCar');
    expect(explain.command!.command).toBe('sidecar.explainSelection');
  });

  it('adds Refactor when the user has a selection on a diagnostic line', () => {
    // Selection + diagnostic — user is actively working with the code,
    // so Refactor is also a valid follow-up.
    const document = mockDoc(['const x: string = 42;'], '/tmp/types.ts');
    const range = rng(0, 18, 0, 20);
    const d = diag(0, "Type 'number' is not assignable to type 'string'.");
    const actions = provider.provideCodeActions(document, range, ctx([d]));

    const titles = actions.map((a) => a.title);
    expect(titles).toContain('Fix with SideCar');
    expect(titles).toContain('Explain this error with SideCar');
    expect(titles).toContain('Refactor with SideCar');
    // But NOT a duplicate plain Explain — the diagnostic one already covers it.
    expect(titles.filter((t) => t === 'Explain with SideCar')).toHaveLength(0);
  });

  it('skips hint-severity diagnostics (too noisy for the lightbulb)', () => {
    const document = mockDoc(['const x = 1;']);
    const range = rng(0, 0, 0, 5);
    const d = diag(0, 'Consider using const.', DiagnosticSeverity.Hint);
    const actions = provider.provideCodeActions(document, range, ctx([d]));
    expect(actions.filter((a) => a.title.includes('Fix'))).toHaveLength(0);
  });

  it('offers Refactor + Explain on a non-empty selection without diagnostics', () => {
    const document = mockDoc(['function foo() { return 1; }']);
    const range = rng(0, 0, 0, 28);
    const actions = provider.provideCodeActions(document, range, ctx());

    const titles = actions.map((a) => a.title);
    expect(titles).toContain('Explain with SideCar');
    expect(titles).toContain('Refactor with SideCar');

    const refactor = actions.find((a) => a.title === 'Refactor with SideCar')!;
    const args = refactor.command!.arguments?.[0] as { code: string };
    expect(args.code).toContain('function foo');
  });

  it('does not duplicate Explain when a diagnostic already contributed one', () => {
    const document = mockDoc(['const x: string = 42;']);
    const range = rng(0, 0, 0, 20);
    const d = diag(0, 'type mismatch');
    const actions = provider.provideCodeActions(document, range, ctx([d]));

    const explainTitles = actions.map((a) => a.title).filter((t) => t.includes('Explain'));
    // One from the diagnostic, none added by the selection branch.
    expect(explainTitles).toHaveLength(1);
  });

  it('skips the selection branch when the selected text is whitespace only', () => {
    const document = mockDoc(['   ', '   ']);
    const range = rng(0, 0, 1, 3);
    const actions = provider.provideCodeActions(document, range, ctx());
    expect(actions).toEqual([]);
  });

  it('formats diagnostic messages with source, code, and severity', () => {
    const document = mockDoc(['broken();']);
    const range = rng(0, 0, 0, 9);
    const d = diag(0, 'function not found', DiagnosticSeverity.Warning, 'eslint', 'no-undef');
    const actions = provider.provideCodeActions(document, range, ctx([d]));
    const args = actions[0].command!.arguments?.[0] as { diagnostic: string };
    expect(args.diagnostic).toBe('[eslint] no-undef warning: function not found');
  });
});
