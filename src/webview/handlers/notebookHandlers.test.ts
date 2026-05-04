import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from 'vscode';
import {
  notebookSystemPromptPrefix,
  handleNotebookStart,
  handleNotebookExit,
  isNotebookModeActive,
  getNotebookRequireCitations,
} from './notebookHandlers.js';
import * as notebookModule from '../../agent/tools/notebook.js';
import { __resetConfigCacheForTests } from '../../config/settings.js';

function makeMockState(overrides: Record<string, unknown> = {}) {
  return {
    postMessage: vi.fn(),
    notebookModeActive: false,
    notebookRequireCitations: 'strict' as 'strict' | 'advisory' | 'off',
    ...overrides,
  } as unknown as Parameters<typeof handleNotebookStart>[0];
}

describe('notebookSystemPromptPrefix', () => {
  it('includes MANDATORY citation rule in strict mode', () => {
    const prompt = notebookSystemPromptPrefix('strict');
    expect(prompt).toContain('MANDATORY');
    expect(prompt).toContain('inline citation');
    expect(prompt).toContain('Notebook Mode');
  });

  it('includes advisory citation in advisory mode', () => {
    const prompt = notebookSystemPromptPrefix('advisory');
    expect(prompt).not.toContain('MANDATORY');
    expect(prompt).toContain('Where possible');
  });

  it('omits citation text in off mode', () => {
    const prompt = notebookSystemPromptPrefix('off');
    expect(prompt).not.toContain('citation');
    expect(prompt).toContain('Notebook Mode');
  });

  it('ends with a trailing newline', () => {
    const prompt = notebookSystemPromptPrefix('strict');
    expect(prompt.endsWith('\n')).toBe(true);
  });
});

describe('handleNotebookStart', () => {
  beforeEach(() => {
    vi.spyOn(notebookModule, 'listIngestedSources').mockReturnValue([]);
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      get: <T>(key: string, defaultValue?: T): T => {
        if (key === 'notebookMode.requireCitations') return 'strict' as unknown as T;
        return defaultValue as T;
      },
      inspect: () => undefined,
      update: async () => {},
      has: () => false,
    } as unknown as ReturnType<typeof workspace.getConfiguration>);
  });

  it('sets notebookModeActive on state', () => {
    const state = makeMockState();
    handleNotebookStart(state);
    expect(isNotebookModeActive(state)).toBe(true);
  });

  it('posts an assistantMessage', () => {
    const state = makeMockState();
    handleNotebookStart(state);
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'assistantMessage' }));
  });

  it('posts done', () => {
    const state = makeMockState();
    handleNotebookStart(state);
    expect(state.postMessage).toHaveBeenCalledWith({ command: 'done' });
  });

  it('shows "none" when no sources are ingested', () => {
    const state = makeMockState();
    handleNotebookStart(state);
    const call = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as { command?: string }).command === 'assistantMessage',
    );
    expect(call?.[0].content).toContain('none');
  });

  it('lists ingested sources when present', () => {
    vi.spyOn(notebookModule, 'listIngestedSources').mockReturnValue([
      { id: 'src-1', title: 'Paper A', content: 'x', ingestedAt: '' },
    ]);
    const state = makeMockState();
    handleNotebookStart(state);
    const call = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as { command?: string }).command === 'assistantMessage',
    );
    expect(call?.[0].content).toContain('Paper A');
  });
});

describe('handleNotebookExit', () => {
  it('clears notebookModeActive', () => {
    const state = makeMockState();
    handleNotebookStart(state);
    handleNotebookExit(state);
    expect(isNotebookModeActive(state)).toBe(false);
  });

  it('calls clearIngestedSources', () => {
    const clearSpy = vi.spyOn(notebookModule, 'clearIngestedSources').mockImplementation(() => {});
    const state = makeMockState();
    handleNotebookExit(state);
    expect(clearSpy).toHaveBeenCalled();
  });

  it('posts assistantMessage and done', () => {
    const state = makeMockState();
    handleNotebookExit(state);
    const commands = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as { command?: string }).command,
    );
    expect(commands).toContain('assistantMessage');
    expect(commands).toContain('done');
  });
});

describe('isNotebookModeActive', () => {
  it('returns false on fresh state', () => {
    expect(isNotebookModeActive(makeMockState())).toBe(false);
  });
});

describe('getNotebookRequireCitations', () => {
  it('defaults to strict when not set', () => {
    expect(getNotebookRequireCitations(makeMockState())).toBe('strict');
  });

  it('returns the value set by handleNotebookStart', () => {
    __resetConfigCacheForTests();
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      get: <T>(key: string, defaultValue?: T): T => {
        if (key === 'notebookMode.requireCitations') return 'advisory' as unknown as T;
        return defaultValue as T;
      },
      inspect: () => undefined,
      update: async () => {},
      has: () => false,
    } as unknown as ReturnType<typeof workspace.getConfiguration>);
    vi.spyOn(notebookModule, 'listIngestedSources').mockReturnValue([]);
    const state = makeMockState();
    handleNotebookStart(state);
    expect(getNotebookRequireCitations(state)).toBe('advisory');
  });
});
