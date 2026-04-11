import { describe, it, expect } from 'vitest';
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
});
