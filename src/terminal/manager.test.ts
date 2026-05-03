import { describe, it, expect, vi } from 'vitest';
import { window } from 'vscode';
import { TerminalManager } from './manager.js';

describe('TerminalManager', () => {
  it('creates a terminal on first getOrCreateTerminal call', () => {
    const manager = new TerminalManager();
    const terminal = manager.getOrCreateTerminal();
    expect(terminal).toBeDefined();
  });

  it('reuses existing terminal on subsequent calls', () => {
    const manager = new TerminalManager();
    const first = manager.getOrCreateTerminal();
    const second = manager.getOrCreateTerminal();
    expect(first).toBe(second);
  });

  it('executeCommand returns null when no shell integration', async () => {
    const manager = new TerminalManager();
    const result = await manager.executeCommand('echo hello');
    // Without shell integration, returns null and uses sendText
    expect(result).toBeNull();
  });

  it('dispose cleans up without error', () => {
    const manager = new TerminalManager();
    manager.getOrCreateTerminal();
    expect(() => manager.dispose()).not.toThrow();
  });

  it('dispose is safe when no terminal was created', () => {
    const manager = new TerminalManager();
    expect(() => manager.dispose()).not.toThrow();
  });

  it('clears the terminal reference when the managed terminal is closed', () => {
    let closeCallback: ((t: unknown) => void) | undefined;
    vi.spyOn(window, 'onDidCloseTerminal').mockImplementation((cb) => {
      closeCallback = cb as (t: unknown) => void;
      return { dispose: vi.fn() };
    });

    const manager = new TerminalManager();
    const first = manager.getOrCreateTerminal();

    // Simulate terminal close event with our terminal
    closeCallback!(first);

    // Creating again should create a new terminal (not reuse closed one)
    const second = manager.getOrCreateTerminal();
    expect(second).not.toBe(first);
    vi.restoreAllMocks();
  });

  it('fires close handler without clearing terminal for a different terminal', () => {
    let closeCallback: ((t: unknown) => void) | undefined;
    vi.spyOn(window, 'onDidCloseTerminal').mockImplementation((cb) => {
      closeCallback = cb as (t: unknown) => void;
      return { dispose: vi.fn() };
    });

    const manager = new TerminalManager();
    const terminal = manager.getOrCreateTerminal();

    // Fire close for a different terminal object
    closeCallback!({ show: vi.fn(), sendText: vi.fn(), dispose: vi.fn() });

    // Our terminal should still be reused
    expect(manager.getOrCreateTerminal()).toBe(terminal);
    vi.restoreAllMocks();
  });

  it('returns output when shell integration executeCommand is available', async () => {
    const mockTerminal = {
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
      shellIntegration: {
        executeCommand: vi.fn().mockReturnValue({
          read: async function* () {
            yield 'hello ';
            yield 'world';
          },
        }),
      },
    };
    vi.spyOn(window, 'createTerminal').mockReturnValue(mockTerminal as never);

    const manager = new TerminalManager();
    const result = await manager.executeCommand('echo hello world');
    expect(result).toBe('hello world');
    vi.restoreAllMocks();
  });

  it('falls back to sendText when shell integration executeCommand throws', async () => {
    const mockTerminal = {
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
      shellIntegration: {
        executeCommand: vi.fn().mockImplementation(() => {
          throw new Error('shell integration unavailable');
        }),
      },
    };
    vi.spyOn(window, 'createTerminal').mockReturnValue(mockTerminal as never);

    const manager = new TerminalManager();
    const result = await manager.executeCommand('echo hello');
    expect(result).toBeNull();
    expect(mockTerminal.sendText).toHaveBeenCalledWith('echo hello', true);
    vi.restoreAllMocks();
  });
});
