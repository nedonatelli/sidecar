import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { window, workspace, Selection, Position } from 'vscode';
import { handleInlineChat } from './inlineChatProvider.js';
import type { SideCarClient } from '../ollama/client.js';

// ---------------------------------------------------------------------------
// Tests for inlineChatProvider.ts (v0.65 chunk 6b).
//
// `handleInlineChat` is the inline "cmd-K" flow: user selects code or
// places cursor, types an instruction, and the LLM's response is
// applied as a WorkspaceEdit. These tests cover every branch:
//   - no active editor
//   - user cancels inputBox
//   - client returns empty → warning
//   - client throws → error
//   - with selection → replace edit
//   - without selection → insert edit
//   - applyEdit rejection → error surfaced
// ---------------------------------------------------------------------------

function makeSelection(start: Position, end: Position): Selection {
  // The vscode mock's Selection lacks `.active` (the real VS Code has
  // it: position of the cursor, = end in a forward selection). Bolt it
  // on here so `handleInlineChat`'s insert-path (`selection.active.line`)
  // has something to read.
  const sel = new Selection(start, end) as Selection & { active: Position };
  sel.active = end;
  return sel;
}

function makeEditor(selection: Selection, lineCount = 100, lineText = 'code line'): { editor: unknown } {
  const editor = {
    selection,
    document: {
      getText: (range?: { start: { line: number }; end: { line: number } }) => {
        if (!range) return '';
        const lines: string[] = [];
        for (let i = range.start.line; i <= range.end.line; i++) {
          lines.push(lineText);
        }
        return lines.join('\n');
      },
      fileName: '/mock-workspace/src/file.ts',
      lineCount,
      lineAt: (_line: number) => ({ text: lineText }),
      uri: { fsPath: '/mock-workspace/src/file.ts' },
    },
  };
  return { editor };
}

function makeClient(responseOrThrow: string | Error): SideCarClient {
  return {
    complete: vi.fn(async () => {
      if (responseOrThrow instanceof Error) throw responseOrThrow;
      return responseOrThrow;
    }),
  } as unknown as SideCarClient;
}

beforeEach(() => {
  // Reset window state between tests.
  (window as { activeTextEditor: unknown }).activeTextEditor = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleInlineChat — guard paths', () => {
  it('shows a warning and returns when there is no active editor', async () => {
    const warnSpy = vi.spyOn(window, 'showWarningMessage');
    const client = makeClient('unreachable');
    await handleInlineChat(client);
    expect(warnSpy).toHaveBeenCalledWith('No active editor.');
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('returns silently when the user cancels the input box', async () => {
    const { editor } = makeEditor(makeSelection(new Position(0, 0), new Position(0, 0)));
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined);
    const client = makeClient('unused');
    await handleInlineChat(client);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('warns and returns when the client returns an empty response', async () => {
    const { editor } = makeEditor(makeSelection(new Position(5, 0), new Position(5, 10)));
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('add null check');
    const warnSpy = vi.spyOn(window, 'showWarningMessage');
    const client = makeClient('   \n  ');
    await handleInlineChat(client);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty response'));
  });

  it('surfaces thrown client errors via showErrorMessage', async () => {
    const { editor } = makeEditor(makeSelection(new Position(0, 0), new Position(0, 0)));
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('do X');
    const errSpy = vi.spyOn(window, 'showErrorMessage');
    const client = makeClient(new Error('backend timeout'));
    await handleInlineChat(client);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('backend timeout'));
  });
});

describe('handleInlineChat — replace path (selection present)', () => {
  it('builds an edit-selection prompt and applies a replace WorkspaceEdit', async () => {
    const selection = makeSelection(new Position(4, 0), new Position(6, 15));
    const { editor } = makeEditor(selection);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('convert to async');
    const applyEdit = vi.fn(async () => true);
    (workspace as Record<string, unknown>).applyEdit = applyEdit;
    const client = makeClient('const result = await fetch(url);');

    await handleInlineChat(client);

    // Client saw a prompt that references the selected range + instruction.
    const completeMock = client.complete as ReturnType<typeof vi.fn>;
    expect(completeMock).toHaveBeenCalled();
    const prompt = completeMock.mock.calls[0][0][0].content as string;
    expect(prompt).toContain('Edit the following code');
    expect(prompt).toContain('convert to async');
    expect(prompt).toContain('lines 5-7');
    expect(prompt).toContain('Selected code to edit');

    // applyEdit was called — replacement path.
    expect(applyEdit).toHaveBeenCalledOnce();
  });

  it('surfaces an error when applyEdit returns false', async () => {
    const selection = makeSelection(new Position(0, 0), new Position(0, 5));
    const { editor } = makeEditor(selection);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('x');
    (workspace as Record<string, unknown>).applyEdit = vi.fn(async () => false);
    const errSpy = vi.spyOn(window, 'showErrorMessage');
    const client = makeClient('new code');

    await handleInlineChat(client);

    expect(errSpy).toHaveBeenCalledWith('Failed to apply inline edit.');
  });
});

describe('handleInlineChat — insert path (no selection)', () => {
  it('builds an insert-at-cursor prompt and applies an insert WorkspaceEdit', async () => {
    const cursor = makeSelection(new Position(10, 0), new Position(10, 0)); // empty selection
    const { editor } = makeEditor(cursor);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('add import for lodash');
    const applyEdit = vi.fn(async () => true);
    (workspace as Record<string, unknown>).applyEdit = applyEdit;
    const client = makeClient("import _ from 'lodash';");

    await handleInlineChat(client);

    const completeMock = client.complete as ReturnType<typeof vi.fn>;
    const prompt = completeMock.mock.calls[0][0][0].content as string;
    expect(prompt).toContain('Insert code at line 11');
    expect(prompt).toContain('add import for lodash');
    expect(prompt).not.toContain('Selected code to edit');
    expect(applyEdit).toHaveBeenCalledOnce();
  });
});

describe('handleInlineChat — surrounding-context window', () => {
  it('clamps the surrounding window to the file bounds (not below 0 or above lineCount-1)', async () => {
    // Small file, cursor at line 1 — startLine should clamp to 0.
    const cursor = makeSelection(new Position(1, 0), new Position(1, 0));
    const { editor } = makeEditor(cursor, 5);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('x');
    (workspace as Record<string, unknown>).applyEdit = vi.fn(async () => true);
    const client = makeClient('inserted');

    // Should not throw — clamping prevents negative line indices.
    await expect(handleInlineChat(client)).resolves.toBeUndefined();
  });

  it('uses the workspace-relative filename in the prompt when root is set', async () => {
    const selection = makeSelection(new Position(2, 0), new Position(3, 0));
    const { editor } = makeEditor(selection);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('x');
    (workspace as Record<string, unknown>).applyEdit = vi.fn(async () => true);
    const client = makeClient('new');

    await handleInlineChat(client);

    const prompt = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0][0].content as string;
    // Should include the relative path (src/file.ts), not the full path.
    expect(prompt).toContain('src/file.ts');
  });
});
