import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock fns so vi.mock (also hoisted) can capture them without
// hitting the TDZ on the module-under-test's `import 'vscode'`.
const { showErrorMessage, executeCommand } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock('vscode', () => {
  // Minimal EventEmitter stub for healthStatus, which errorSurface now imports.
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    get event() {
      return (l: (e: T) => void) => {
        this.listeners.push(l);
        return { dispose: () => {} };
      };
    }
    fire(e: T) {
      for (const l of this.listeners) l(e);
    }
    dispose() {
      this.listeners = [];
    }
  }
  return {
    window: { showErrorMessage },
    commands: { executeCommand },
    EventEmitter,
  };
});

import { actionsForError, surfaceNativeToast, surfaceProviderError } from './errorSurface.js';

beforeEach(() => {
  showErrorMessage.mockReset();
  executeCommand.mockReset();
});

describe('actionsForError', () => {
  it('offers Set API Key first for auth errors', () => {
    const actions = actionsForError({ errorType: 'auth' });
    expect(actions[0]).toEqual({ label: 'Set API Key', command: 'sidecar.setApiKey' });
    expect(actions[1]).toEqual({ label: 'Switch Backend', command: 'sidecar.switchBackend' });
  });

  it('offers Switch Backend first for connection errors', () => {
    const actions = actionsForError({ errorType: 'connection' });
    expect(actions[0].label).toBe('Switch Backend');
    expect(actions[1].label).toBe('Set API Key');
  });

  it('returns an empty list for error types we do not promote', () => {
    expect(actionsForError({ errorType: 'rate_limit' })).toEqual([]);
    expect(actionsForError({ errorType: 'unknown' })).toEqual([]);
    expect(actionsForError({})).toEqual([]);
  });
});

describe('surfaceNativeToast', () => {
  it('does not show a toast for non-promoted error types', async () => {
    const shown = await surfaceNativeToast('oops', { errorType: 'rate_limit' });
    expect(shown).toBe(false);
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows a toast for auth errors with recovery actions', async () => {
    showErrorMessage.mockResolvedValueOnce(undefined);
    const shown = await surfaceNativeToast('Anthropic API request failed: 401 Unauthorized', {
      errorType: 'auth',
    });
    expect(shown).toBe(true);
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    const [body, ...items] = showErrorMessage.mock.calls[0];
    expect(body).toContain('SideCar');
    expect(body).toContain('401');
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: 'Set API Key' });
    expect(items[1]).toEqual({ title: 'Switch Backend' });
  });

  it('executes the matching command when the user picks an action', async () => {
    showErrorMessage.mockResolvedValueOnce({ title: 'Switch Backend' });
    await surfaceNativeToast('Cannot reach API', { errorType: 'connection' });
    expect(executeCommand).toHaveBeenCalledWith('sidecar.switchBackend');
  });

  it('does nothing on dismissal (undefined return)', async () => {
    showErrorMessage.mockResolvedValueOnce(undefined);
    await surfaceNativeToast('Cannot reach API', { errorType: 'connection' });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('strips noisy request-id JSON from the toast body', async () => {
    showErrorMessage.mockResolvedValueOnce(undefined);
    await surfaceNativeToast(
      'Anthropic API request failed: 401 Unauthorized — {"type":"error","request_id":"req_abc"}',
      { errorType: 'auth' },
    );
    const [body] = showErrorMessage.mock.calls[0];
    expect(body).not.toContain('request_id');
    expect(body).not.toContain('{');
    expect(body).toContain('401 Unauthorized');
  });

  it('caps very long messages to prevent toast overflow', async () => {
    showErrorMessage.mockResolvedValueOnce(undefined);
    const longMessage = 'x'.repeat(500);
    await surfaceNativeToast(longMessage, { errorType: 'auth' });
    const [body] = showErrorMessage.mock.calls[0];
    expect(body.length).toBeLessThanOrEqual(220);
    expect(body.endsWith('...')).toBe(true);
  });
});

describe('surfaceProviderError', () => {
  it('delegates to surfaceNativeToast with the given kind', async () => {
    showErrorMessage.mockResolvedValueOnce(undefined);
    await surfaceProviderError('Cannot connect to Ollama.', 'connection');
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    const items = showErrorMessage.mock.calls[0].slice(1);
    expect(items[0]).toEqual({ title: 'Switch Backend' });
  });
});
