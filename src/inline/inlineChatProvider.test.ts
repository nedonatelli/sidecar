import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { window, workspace, commands, Selection, Position } from 'vscode';
import { handleInlineChat } from './inlineChatProvider.js';
import type { SideCarClient } from '../ollama/client.js';

// ---------------------------------------------------------------------------
// Tests for inlineChatProvider.ts — streaming inline edit flow.
//
// `handleInlineChat` now:
//   1. Shows an input box for the instruction
//   2. Streams the LLM response via client.streamChat (cancellable)
//   3. Shows a diff preview (vscode.diff) using ProposedContentProvider
//   4. Shows an Accept/Reject modal
//   5. Applies the WorkspaceEdit only if the user accepts
//
// Test cases:
//   - no active editor
//   - user cancels inputBox
//   - stream returns empty text → warning, no diff shown
//   - stream throws → error surfaced, no diff shown
//   - user rejects diff → edit NOT applied
//   - with selection + accept → replace WorkspaceEdit applied
//   - without selection + accept → insert WorkspaceEdit applied
//   - applyEdit failure → error surfaced
//   - surrounding context clamped to file bounds
//   - workspace-relative filename in prompt
// ---------------------------------------------------------------------------

function makeSelection(start: Position, end: Position): Selection {
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

async function* textChunks(chunks: string[]) {
  for (const chunk of chunks) {
    yield { type: 'text' as const, text: chunk };
  }
}

function makeClient(chunks: string[] | Error): SideCarClient {
  return {
    streamChat: vi.fn(async function* () {
      if (chunks instanceof Error) throw chunks;
      yield* textChunks(chunks as string[]);
    }),
  } as unknown as SideCarClient;
}

function makeContentProvider() {
  const proposals = new Map<string, string>();
  return {
    addProposal: vi.fn((key: string, content: string) => {
      proposals.set(key, content);
      return { scheme: 'sidecar-proposed', path: key };
    }),
    removeProposal: vi.fn((key: string) => proposals.delete(key)),
    proposals,
  };
}

beforeEach(() => {
  (window as { activeTextEditor: unknown }).activeTextEditor = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleInlineChat — guard paths', () => {
  it('shows a warning and returns when there is no active editor', async () => {
    const warnSpy = vi.spyOn(window, 'showWarningMessage');
    const client = makeClient(['unreachable']);
    const provider = makeContentProvider();
    await handleInlineChat(client, provider as never);
    expect(warnSpy).toHaveBeenCalledWith('No active editor.');
    expect(client.streamChat).not.toHaveBeenCalled();
  });

  it('returns silently when the user cancels the input box', async () => {
    const { editor } = makeEditor(makeSelection(new Position(0, 0), new Position(0, 0)));
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined);
    const client = makeClient(['unused']);
    const provider = makeContentProvider();
    await handleInlineChat(client, provider as never);
    expect(client.streamChat).not.toHaveBeenCalled();
  });

  it('warns and returns when the stream yields only whitespace', async () => {
    const { editor } = makeEditor(makeSelection(new Position(5, 0), new Position(5, 10)));
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('add null check');
    const warnSpy = vi.spyOn(window, 'showWarningMessage');
    const client = makeClient(['   ', '\n  ']);
    const provider = makeContentProvider();
    await handleInlineChat(client, provider as never);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty response'));
    expect(provider.addProposal).not.toHaveBeenCalled();
  });

  it('surfaces thrown stream errors via showErrorMessage and shows no diff', async () => {
    const { editor } = makeEditor(makeSelection(new Position(0, 0), new Position(0, 0)));
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('do X');
    const errSpy = vi.spyOn(window, 'showErrorMessage');
    const client = makeClient(new Error('backend timeout'));
    const provider = makeContentProvider();
    await handleInlineChat(client, provider as never);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('backend timeout'));
    expect(provider.addProposal).not.toHaveBeenCalled();
  });
});

describe('handleInlineChat — diff preview and accept/reject', () => {
  it('opens a diff and applies edit when user accepts (selection present)', async () => {
    const selection = makeSelection(new Position(4, 0), new Position(6, 15));
    const { editor } = makeEditor(selection);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('convert to async');
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Accept' as never);
    const applyEdit = vi.fn(async () => true);
    (workspace as Record<string, unknown>).applyEdit = applyEdit;
    const client = makeClient(['const result = ', 'await fetch(url);']);
    const provider = makeContentProvider();

    await handleInlineChat(client, provider as never);

    // diff should have been opened
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      'SideCar: Proposed Edit',
      { preview: true },
    );
    // proposals should have been cleaned up
    expect(provider.removeProposal).toHaveBeenCalledTimes(2);
    // edit applied
    expect(applyEdit).toHaveBeenCalledOnce();
  });

  it('opens a diff but does NOT apply edit when user dismisses modal', async () => {
    const selection = makeSelection(new Position(0, 0), new Position(0, 5));
    const { editor } = makeEditor(selection);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('x');
    // showInformationMessage returns undefined = user closed without choosing
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const applyEdit = vi.fn(async () => true);
    (workspace as Record<string, unknown>).applyEdit = applyEdit;
    const client = makeClient(['new code']);
    const provider = makeContentProvider();

    await handleInlineChat(client, provider as never);

    expect(commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.any(Object),
    );
    expect(provider.removeProposal).toHaveBeenCalledTimes(2);
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it('applies an insert WorkspaceEdit on accept when no selection', async () => {
    const cursor = makeSelection(new Position(10, 0), new Position(10, 0));
    const { editor } = makeEditor(cursor);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('add import for lodash');
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Accept' as never);
    const applyEdit = vi.fn(async () => true);
    (workspace as Record<string, unknown>).applyEdit = applyEdit;
    const client = makeClient(["import _ from 'lodash';"]);
    const provider = makeContentProvider();

    await handleInlineChat(client, provider as never);

    expect(commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      'SideCar: Code to Insert',
      { preview: true },
    );
    expect(applyEdit).toHaveBeenCalledOnce();
  });

  it('surfaces an error when applyEdit returns false', async () => {
    const selection = makeSelection(new Position(0, 0), new Position(0, 5));
    const { editor } = makeEditor(selection);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('x');
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Accept' as never);
    (workspace as Record<string, unknown>).applyEdit = vi.fn(async () => false);
    const errSpy = vi.spyOn(window, 'showErrorMessage');
    const client = makeClient(['new code']);
    const provider = makeContentProvider();

    await handleInlineChat(client, provider as never);

    expect(errSpy).toHaveBeenCalledWith('Failed to apply inline edit.');
  });
});

describe('handleInlineChat — prompt content', () => {
  it('builds an edit-selection prompt with instruction and line range', async () => {
    const selection = makeSelection(new Position(4, 0), new Position(6, 15));
    const { editor } = makeEditor(selection);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('convert to async');
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const applyEdit = vi.fn(async () => true);
    (workspace as Record<string, unknown>).applyEdit = applyEdit;
    const client = makeClient(['result']);
    const provider = makeContentProvider();

    await handleInlineChat(client, provider as never);

    const streamMock = client.streamChat as ReturnType<typeof vi.fn>;
    expect(streamMock).toHaveBeenCalled();
    const prompt = streamMock.mock.calls[0][0][0].content as string;
    expect(prompt).toContain('Edit the following code');
    expect(prompt).toContain('convert to async');
    expect(prompt).toContain('lines 5-7');
    expect(prompt).toContain('Selected code to edit');
  });

  it('builds an insert-at-cursor prompt when there is no selection', async () => {
    const cursor = makeSelection(new Position(10, 0), new Position(10, 0));
    const { editor } = makeEditor(cursor);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('add import for lodash');
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
    (workspace as Record<string, unknown>).applyEdit = vi.fn(async () => true);
    const client = makeClient(["import _ from 'lodash';"]);
    const provider = makeContentProvider();

    await handleInlineChat(client, provider as never);

    const streamMock = client.streamChat as ReturnType<typeof vi.fn>;
    const prompt = streamMock.mock.calls[0][0][0].content as string;
    expect(prompt).toContain('Insert code at line 11');
    expect(prompt).toContain('add import for lodash');
    expect(prompt).not.toContain('Selected code to edit');
  });

  it('uses the workspace-relative filename in the prompt', async () => {
    const selection = makeSelection(new Position(2, 0), new Position(3, 0));
    const { editor } = makeEditor(selection);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('x');
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
    (workspace as Record<string, unknown>).applyEdit = vi.fn(async () => true);
    const client = makeClient(['new']);
    const provider = makeContentProvider();

    await handleInlineChat(client, provider as never);

    const streamMock = client.streamChat as ReturnType<typeof vi.fn>;
    const prompt = streamMock.mock.calls[0][0][0].content as string;
    expect(prompt).toContain('src/file.ts');
  });

  it('clamps the surrounding window to file bounds', async () => {
    const cursor = makeSelection(new Position(1, 0), new Position(1, 0));
    const { editor } = makeEditor(cursor, 5);
    (window as { activeTextEditor: unknown }).activeTextEditor = editor;
    vi.spyOn(window, 'showInputBox').mockResolvedValue('x');
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
    (workspace as Record<string, unknown>).applyEdit = vi.fn(async () => true);
    const client = makeClient(['inserted']);
    const provider = makeContentProvider();

    // Should not throw — clamping prevents negative line indices
    await expect(handleInlineChat(client, provider as never)).resolves.toBeUndefined();
  });
});
