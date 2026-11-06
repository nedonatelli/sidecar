import { describe, it, expect, vi, beforeEach } from 'vitest';

const { commandHandlers, mockApplyEdit, docText } = vi.hoisted(() => ({
  commandHandlers: new Map<string, () => unknown>(),
  mockApplyEdit: vi.fn(async (_edit: unknown) => true),
  docText: { value: '' },
}));

vi.mock('vscode', () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  // Single-line documents only: a position's character is its offset.
  const offset = (p: Position) => p.character;
  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }
  class WorkspaceEdit {
    edits: { uri: unknown; range: Range; newText: string }[] = [];
    replace(uri: unknown, range: Range, newText: string) {
      this.edits.push({ uri, range, newText });
    }
  }
  const doc = {
    getText: (range?: Range) => (range ? docText.value.slice(offset(range.start), offset(range.end)) : docText.value),
    positionAt: (i: number) => new Position(0, i),
  };
  return {
    Position,
    Range,
    WorkspaceEdit,
    Selection: class {},
    InlineCompletionItem: class {},
    TextEditorRevealType: { InCenter: 2 },
    StatusBarAlignment: { Right: 2 },
    Uri: { joinPath: (base: { fsPath: string }, p: string) => ({ fsPath: `${base.fsPath}/${p}` }) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/ws' } }],
      openTextDocument: async () => doc,
      applyEdit: mockApplyEdit,
    },
    window: {
      createStatusBarItem: () => ({ show: vi.fn(), hide: vi.fn(), dispose: vi.fn() }),
      showTextDocument: async () => ({ revealRange: vi.fn() }),
      showErrorMessage: vi.fn(),
    },
    commands: {
      registerCommand: (id: string, handler: () => unknown) => {
        commandHandlers.set(id, handler);
        return { dispose: () => {} };
      },
      executeCommand: vi.fn(async () => undefined),
    },
  };
});

import { InlineEditProvider } from './inlineEditProvider.js';

beforeEach(() => {
  commandHandlers.clear();
  mockApplyEdit.mockClear();
  docText.value = 'const greeting = "hi";';
});

// Accepting from the status bar or the command used to resolve the proposal
// as accepted without inserting anything -- only Tab inserts the ghost text --
// and the agent was told "Applied edit" (#423).
describe('InlineEditProvider — accept from the status bar / command', () => {
  it('applies the replacement before resolving the proposal as accepted', async () => {
    const provider = new InlineEditProvider();
    const accepted = provider.proposeEdit('a.ts', '"hi"', '"hello"');
    await vi.waitFor(() => expect(provider.hasPendingEdit()).toBe(true));

    await commandHandlers.get('sidecar.acceptInlineEdit')!();

    expect(mockApplyEdit).toHaveBeenCalledOnce();
    const edit = mockApplyEdit.mock.calls[0][0] as {
      edits: { range: { start: { character: number } }; newText: string }[];
    };
    expect(edit.edits).toEqual([expect.objectContaining({ newText: '"hello"' })]);
    expect(edit.edits[0].range.start.character).toBe(17);
    await expect(accepted).resolves.toBe(true);
    provider.dispose();
  });

  it('leaves the proposal pending when the text under it changed', async () => {
    const provider = new InlineEditProvider();
    void provider.proposeEdit('a.ts', '"hi"', '"hello"');
    await vi.waitFor(() => expect(provider.hasPendingEdit()).toBe(true));
    docText.value = 'const greeting = "yo";';

    await commandHandlers.get('sidecar.acceptInlineEdit')!();

    expect(mockApplyEdit).not.toHaveBeenCalled();
    expect(provider.hasPendingEdit()).toBe(true);
    provider.dispose();
  });

  it('Tab acceptance (text already inserted) resolves without applying again', async () => {
    const provider = new InlineEditProvider();
    const accepted = provider.proposeEdit('a.ts', '"hi"', '"hello"');
    await vi.waitFor(() => expect(provider.hasPendingEdit()).toBe(true));

    provider.accept();

    await expect(accepted).resolves.toBe(true);
    expect(mockApplyEdit).not.toHaveBeenCalled();
    provider.dispose();
  });
});
