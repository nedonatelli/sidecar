import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Uri } from 'vscode';
import { runExportHandoff, runImportHandoff, type HandoffCommandUi, type ImportableState } from './handoffCommands.js';
import { buildBundle } from '../agent/handoff/handoff.js';
import type { ChatMessage } from '../ollama/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(count = 2): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: [{ type: 'text' as const, text: `msg ${i}` }],
  }));
}

function makeUi(overrides: Partial<HandoffCommandUi> = {}): HandoffCommandUi & {
  showWarning: ReturnType<typeof vi.fn>;
  showInfo: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
  promptNote: ReturnType<typeof vi.fn>;
  promptSaveUri: ReturnType<typeof vi.fn>;
  promptOpenUri: ReturnType<typeof vi.fn>;
  showBundlePreview: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
} {
  return {
    showWarning: vi.fn(),
    showInfo: vi.fn(),
    showError: vi.fn(),
    promptNote: vi.fn(async () => ''),
    promptSaveUri: vi.fn(async () => Uri.file('/tmp/handoff.json')),
    promptOpenUri: vi.fn(async () => [Uri.file('/tmp/handoff.json')]),
    showBundlePreview: vi.fn(async () => true),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => '{}'),
    ...overrides,
  } as never;
}

function makeState(messages: ChatMessage[] = []): ImportableState & {
  postMessage: ReturnType<typeof vi.fn>;
  autoSave: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  saveHistory: ReturnType<typeof vi.fn>;
} {
  return {
    messages,
    autoSave: vi.fn(),
    abort: vi.fn(),
    cancelCallbacks: null,
    abortController: null,
    chatGeneration: 0,
    currentSteerDisposer: null,
    currentSteerQueue: null,
    currentSessionId: null,
    postMessage: vi.fn(),
    saveHistory: vi.fn(),
  } as never;
}

// ---------------------------------------------------------------------------
// runExportHandoff
// ---------------------------------------------------------------------------

describe('runExportHandoff', () => {
  it('shows a warning and returns early when messages is empty', async () => {
    const ui = makeUi();
    await runExportHandoff([], ui);
    expect(ui.showWarning).toHaveBeenCalledWith(expect.stringContaining('nothing to export'));
    expect(ui.promptNote).not.toHaveBeenCalled();
    expect(ui.writeFile).not.toHaveBeenCalled();
  });

  it('returns early without writing when the user cancels the note prompt', async () => {
    const ui = makeUi({ promptNote: vi.fn(async () => undefined) });
    await runExportHandoff(makeMessages(), ui);
    expect(ui.promptSaveUri).not.toHaveBeenCalled();
    expect(ui.writeFile).not.toHaveBeenCalled();
  });

  it('returns early without writing when the user cancels the save dialog', async () => {
    const ui = makeUi({ promptSaveUri: vi.fn(async () => undefined) });
    await runExportHandoff(makeMessages(), ui);
    expect(ui.writeFile).not.toHaveBeenCalled();
    expect(ui.showInfo).not.toHaveBeenCalled();
  });

  it('writes a valid HandoffBundle JSON and shows an info toast on the happy path', async () => {
    const messages = makeMessages(3);
    const savedPath = '/tmp/out.json';
    const ui = makeUi({
      promptNote: vi.fn(async () => 'auth done, tests still needed'),
      promptSaveUri: vi.fn(async () => Uri.file(savedPath)),
    });

    await runExportHandoff(messages, ui);

    expect(ui.writeFile).toHaveBeenCalledOnce();
    const [path, content] = ui.writeFile.mock.calls[0] as [string, string];
    expect(path).toBe(savedPath);
    const bundle = JSON.parse(content) as { version: number; messages: unknown[]; note: string };
    expect(bundle.version).toBe(1);
    expect(bundle.messages).toHaveLength(3);
    expect(bundle.note).toBe('auth done, tests still needed');
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining(savedPath));
  });

  it('empty-string note is allowed (user left the box blank and pressed Enter)', async () => {
    const ui = makeUi({ promptNote: vi.fn(async () => '') });
    await runExportHandoff(makeMessages(), ui);
    expect(ui.writeFile).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// runImportHandoff
// ---------------------------------------------------------------------------

describe('runImportHandoff', () => {
  let validBundle: ReturnType<typeof buildBundle>;
  let validBundleJson: string;

  beforeEach(() => {
    validBundle = buildBundle(makeMessages(2), 'picked up where we left off');
    validBundleJson = JSON.stringify(validBundle);
  });

  it('returns early when the user cancels the open dialog', async () => {
    const state = makeState();
    const ui = makeUi({ promptOpenUri: vi.fn(async () => undefined) });
    await runImportHandoff(state, ui);
    expect(ui.readFile).not.toHaveBeenCalled();
    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('returns early when the open dialog returns an empty array', async () => {
    const state = makeState();
    const ui = makeUi({ promptOpenUri: vi.fn(async () => []) });
    await runImportHandoff(state, ui);
    expect(ui.readFile).not.toHaveBeenCalled();
  });

  it('shows an error and returns early when the file is invalid JSON', async () => {
    const state = makeState();
    const ui = makeUi({ readFile: vi.fn(async () => 'not json at all') });
    await runImportHandoff(state, ui);
    expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining('invalid handoff file'));
    expect(state.autoSave).not.toHaveBeenCalled();
  });

  it('shows an error when the bundle version is wrong', async () => {
    const state = makeState();
    const badBundle = { version: 99, exportedAt: Date.now(), task: 'x', note: '', messages: [] };
    const ui = makeUi({ readFile: vi.fn(async () => JSON.stringify(badBundle)) });
    await runImportHandoff(state, ui);
    expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining('invalid handoff file'));
  });

  it('returns early when the user cancels the bundle preview', async () => {
    const state = makeState();
    const ui = makeUi({
      readFile: vi.fn(async () => validBundleJson),
      showBundlePreview: vi.fn(async () => false),
    });
    await runImportHandoff(state, ui);
    expect(state.autoSave).not.toHaveBeenCalled();
    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('happy path: replaces state messages and sends the expected postMessage sequence', async () => {
    const state = makeState(makeMessages(5));
    const ui = makeUi({ readFile: vi.fn(async () => validBundleJson) });

    await runImportHandoff(state, ui);

    expect(state.autoSave).toHaveBeenCalledOnce();
    expect(state.abort).toHaveBeenCalledOnce();
    expect(state.saveHistory).toHaveBeenCalledOnce();
    expect(state.messages).toEqual(validBundle.messages);
    expect(state.currentSessionId).toBeNull();

    const commands = state.postMessage.mock.calls.map((c) => (c[0] as { command: string }).command);
    expect(commands).toContain('steerQueueUpdate');
    expect(commands).toContain('chatCleared');
    expect(commands).toContain('init');
    const initCall = state.postMessage.mock.calls.find((c) => (c[0] as { command: string }).command === 'init');
    expect((initCall![0] as { messages: unknown[] }).messages).toHaveLength(validBundle.messages.length);
  });

  it('happy path: calls cancelCallbacks and currentSteerDisposer when they are set', async () => {
    const cancelCallbacks = vi.fn();
    const steerDisposer = vi.fn();
    const state = makeState();
    state.cancelCallbacks = cancelCallbacks;
    state.currentSteerDisposer = steerDisposer;

    const ui = makeUi({ readFile: vi.fn(async () => validBundleJson) });
    await runImportHandoff(state, ui);

    expect(cancelCallbacks).toHaveBeenCalledOnce();
    expect(steerDisposer).toHaveBeenCalledOnce();
    expect(state.cancelCallbacks).toBeNull();
    expect(state.currentSteerDisposer).toBeNull();
  });

  it('happy path: increments chatGeneration by 1', async () => {
    const state = makeState();
    state.chatGeneration = 7;
    const ui = makeUi({ readFile: vi.fn(async () => validBundleJson) });
    await runImportHandoff(state, ui);
    expect(state.chatGeneration).toBe(8);
  });

  it('shows the info toast with task and note on success', async () => {
    const bundleWithNote = buildBundle(makeMessages(1), 'keep going');
    const ui = makeUi({ readFile: vi.fn(async () => JSON.stringify(bundleWithNote)) });
    const state = makeState();
    await runImportHandoff(state, ui);
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('keep going'));
  });

  it('shows the info toast without note text when note is empty', async () => {
    const bundleNoNote = buildBundle(makeMessages(1), '');
    const ui = makeUi({ readFile: vi.fn(async () => JSON.stringify(bundleNoNote)) });
    const state = makeState();
    await runImportHandoff(state, ui);
    const msg: string = ui.showInfo.mock.calls[0][0];
    expect(msg).toContain(bundleNoNote.task);
    expect(msg).not.toContain(' — '); // no " — <note>" suffix
  });
});
