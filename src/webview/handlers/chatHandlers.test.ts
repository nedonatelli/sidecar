import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyError,
  languageToExtension,
  handleCreateFile,
  handleMoveFile,
  handleExportChat,
} from './chatHandlers.js';
import { workspace, window } from 'vscode';

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------
describe('classifyError', () => {
  it('classifies ECONNREFUSED as connection error', () => {
    const result = classifyError('connect ECONNREFUSED 127.0.0.1:11434');
    expect(result.errorType).toBe('connection');
    expect(result.errorAction).toBe('Check Connection');
    expect(result.errorActionCommand).toBe('openSettings');
  });

  it('classifies fetch failed as connection error', () => {
    expect(classifyError('fetch failed').errorType).toBe('connection');
  });

  it('classifies network error as connection', () => {
    expect(classifyError('Network request failed').errorType).toBe('connection');
  });

  it('classifies 401 as auth error', () => {
    const result = classifyError('API request failed: 401 Unauthorized');
    expect(result.errorType).toBe('auth');
    expect(result.errorAction).toBe('Check API Key');
  });

  it('classifies 403 as auth error', () => {
    expect(classifyError('403 Forbidden').errorType).toBe('auth');
  });

  it('classifies invalid api key as auth error', () => {
    expect(classifyError('Invalid API key provided').errorType).toBe('auth');
  });

  it('classifies 404 with model as model error', () => {
    const result = classifyError('404: model "llama3" not found');
    expect(result.errorType).toBe('model');
    expect(result.errorAction).toBe('Install Model');
  });

  it('classifies 404 without model keyword as unknown', () => {
    expect(classifyError('404 page').errorType).toBe('unknown');
  });

  it('classifies timeout as timeout error', () => {
    const result = classifyError('Request timed out after 30s');
    expect(result.errorType).toBe('timeout');
    expect(result.errorAction).toBe('Retry');
  });

  it('classifies ETIMEDOUT as timeout error', () => {
    expect(classifyError('connect ETIMEDOUT').errorType).toBe('timeout');
  });

  it('returns unknown for unrecognized errors', () => {
    const result = classifyError('Something weird happened');
    expect(result.errorType).toBe('unknown');
    expect(result.errorAction).toBeUndefined();
  });

  it('is case insensitive', () => {
    expect(classifyError('ECONNREFUSED').errorType).toBe('connection');
    expect(classifyError('UNAUTHORIZED access').errorType).toBe('auth');
    expect(classifyError('TIMEOUT exceeded').errorType).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// languageToExtension
// ---------------------------------------------------------------------------
describe('languageToExtension', () => {
  it('maps known languages to extensions', () => {
    expect(languageToExtension('typescript')).toBe('.ts');
    expect(languageToExtension('javascript')).toBe('.js');
    expect(languageToExtension('python')).toBe('.py');
    expect(languageToExtension('rust')).toBe('.rs');
    expect(languageToExtension('go')).toBe('.go');
    expect(languageToExtension('java')).toBe('.java');
    expect(languageToExtension('cpp')).toBe('.cpp');
    expect(languageToExtension('c')).toBe('.c');
    expect(languageToExtension('html')).toBe('.html');
    expect(languageToExtension('css')).toBe('.css');
    expect(languageToExtension('json')).toBe('.json');
    expect(languageToExtension('yaml')).toBe('.yaml');
    expect(languageToExtension('markdown')).toBe('.md');
    expect(languageToExtension('bash')).toBe('.sh');
    expect(languageToExtension('sh')).toBe('.sh');
    expect(languageToExtension('sql')).toBe('.sql');
    expect(languageToExtension('tsx')).toBe('.tsx');
    expect(languageToExtension('jsx')).toBe('.jsx');
  });

  it('is case insensitive', () => {
    expect(languageToExtension('TypeScript')).toBe('.ts');
    expect(languageToExtension('PYTHON')).toBe('.py');
  });

  it('returns .txt for unknown languages', () => {
    expect(languageToExtension('fortran')).toBe('.txt');
    expect(languageToExtension('')).toBe('.txt');
  });
});

// ---------------------------------------------------------------------------
// handleCreateFile
// ---------------------------------------------------------------------------
describe('handleCreateFile', () => {
  let state: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.restoreAllMocks();
    state = { postMessage: vi.fn() };
  });

  it('posts error when no workspace folder is open', async () => {
    const origFolders = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    await handleCreateFile(state as never, 'code', 'test.ts');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('No workspace') }),
    );

    (workspace as Record<string, unknown>).workspaceFolders = origFolders;
  });

  it('creates file when it does not exist', async () => {
    vi.spyOn(workspace.fs, 'stat').mockRejectedValue(new Error('not found'));
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);

    await handleCreateFile(state as never, 'const x = 1;', 'src/test.ts');
    expect(workspace.fs.writeFile).toHaveBeenCalled();
  });

  it('prompts for overwrite when file exists', async () => {
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);

    await handleCreateFile(state as never, 'code', 'existing.ts');
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
      expect.anything(),
      'Overwrite',
    );
  });

  it('does not overwrite when user cancels', async () => {
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile');

    await handleCreateFile(state as never, 'code', 'existing.ts');
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleMoveFile
// ---------------------------------------------------------------------------
describe('handleMoveFile', () => {
  let state: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.restoreAllMocks();
    state = { postMessage: vi.fn() };
  });

  it('posts error when source or dest is empty', async () => {
    await handleMoveFile(state as never, '', 'dest.ts');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('source and destination') }),
    );
  });

  it('posts error when source does not exist', async () => {
    vi.spyOn(workspace.fs, 'stat').mockRejectedValue(new Error('not found'));

    await handleMoveFile(state as never, 'missing.ts', 'dest.ts');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('Source not found') }),
    );
  });

  it('moves file when dest does not exist', async () => {
    vi.spyOn(workspace.fs, 'stat')
      .mockResolvedValueOnce({ type: 1, size: 100 } as never) // source exists
      .mockRejectedValueOnce(new Error('not found')); // dest does not exist
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renameSpy = vi.spyOn(workspace.fs as any, 'rename').mockResolvedValue(undefined);

    await handleMoveFile(state as never, 'src.ts', 'dest.ts');
    expect(renameSpy).toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'fileMoved', content: expect.stringContaining('Moved') }),
    );
  });

  it('prompts for overwrite when dest exists', async () => {
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);

    await handleMoveFile(state as never, 'src.ts', 'dest.ts');
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
      expect.anything(),
      'Overwrite',
    );
  });
});

// ---------------------------------------------------------------------------
// handleExportChat
// ---------------------------------------------------------------------------
describe('handleExportChat', () => {
  let state: { messages: { role: string; content: string }[]; postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.restoreAllMocks();
    state = { messages: [], postMessage: vi.fn() };
  });

  it('does nothing when messages are empty', async () => {
    const saveSpy = vi.spyOn(window, 'showSaveDialog');
    await handleExportChat(state as never);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('shows save dialog when messages exist', async () => {
    state.messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    vi.spyOn(window, 'showSaveDialog').mockResolvedValue(undefined as never);

    await handleExportChat(state as never);
    expect(window.showSaveDialog).toHaveBeenCalled();
  });
});
