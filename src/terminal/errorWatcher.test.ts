import { describe, it, expect } from 'vitest';
import { stripAnsi, shouldReportFailure, TerminalErrorWatcher } from './errorWatcher.js';

describe('stripAnsi', () => {
  it('removes CSI color sequences', () => {
    const input = '\x1B[31mError:\x1B[0m something failed';
    expect(stripAnsi(input)).toBe('Error: something failed');
  });

  it('removes complex CSI sequences with parameters', () => {
    const input = '\x1B[1;33;40mwarn\x1B[0m \x1B[2K\x1B[Gline';
    expect(stripAnsi(input)).toBe('warn line');
  });

  it('removes OSC title-set sequences', () => {
    const input = '\x1B]0;tab title\x07after';
    expect(stripAnsi(input)).toBe('after');
  });

  it('strips lone ESC + control characters', () => {
    const input = 'before\x1B=after';
    expect(stripAnsi(input)).toBe('beforeafter');
  });

  it('passes plain text through unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('handles empty input', () => {
    expect(stripAnsi('')).toBe('');
  });
});

describe('shouldReportFailure', () => {
  const cooldown = 30_000;
  const now = 1_000_000;

  it('reports a non-zero exit', () => {
    const recent = new Map<string, number>();
    expect(shouldReportFailure('npm test', 1, 'bash', undefined, recent, cooldown, now)).toBe(true);
  });

  it('skips zero exit', () => {
    const recent = new Map<string, number>();
    expect(shouldReportFailure('npm test', 0, 'bash', undefined, recent, cooldown, now)).toBe(false);
  });

  it('skips undefined exit (canceled or unknown)', () => {
    const recent = new Map<string, number>();
    expect(shouldReportFailure('npm test', undefined, 'bash', undefined, recent, cooldown, now)).toBe(false);
  });

  it('skips empty command lines', () => {
    const recent = new Map<string, number>();
    expect(shouldReportFailure('', 1, 'bash', undefined, recent, cooldown, now)).toBe(false);
    expect(shouldReportFailure('   ', 1, 'bash', undefined, recent, cooldown, now)).toBe(false);
  });

  it('skips terminals on the ignore list', () => {
    const recent = new Map<string, number>();
    const ignored = new Set(['SideCar']);
    expect(shouldReportFailure('npm test', 1, 'SideCar', ignored, recent, cooldown, now)).toBe(false);
  });

  it('reports when terminal name is not on the ignore list', () => {
    const recent = new Map<string, number>();
    const ignored = new Set(['SideCar']);
    expect(shouldReportFailure('npm test', 1, 'zsh', ignored, recent, cooldown, now)).toBe(true);
  });

  it('dedupes the same command within the cooldown window', () => {
    const recent = new Map<string, number>();
    recent.set('npm test', now - 10_000);
    expect(shouldReportFailure('npm test', 1, 'bash', undefined, recent, cooldown, now)).toBe(false);
  });

  it('reports the same command after the cooldown expires', () => {
    const recent = new Map<string, number>();
    recent.set('npm test', now - (cooldown + 1));
    expect(shouldReportFailure('npm test', 1, 'bash', undefined, recent, cooldown, now)).toBe(true);
  });

  it('treats different command lines independently for dedup', () => {
    const recent = new Map<string, number>();
    recent.set('npm test', now - 1000);
    expect(shouldReportFailure('npm build', 1, 'bash', undefined, recent, cooldown, now)).toBe(true);
  });
});

describe('TerminalErrorWatcher', () => {
  it('constructs as a no-op when shell execution events are unavailable', () => {
    // The vscode mock used in tests does not expose
    // onDidStartTerminalShellExecution, so the watcher should construct
    // without subscribing to anything and dispose cleanly.
    let called = false;
    const watcher = new TerminalErrorWatcher({
      enabled: () => true,
      onError: () => {
        called = true;
      },
    });
    expect(() => watcher.dispose()).not.toThrow();
    expect(called).toBe(false);
  });

  it('dispose is idempotent', () => {
    const watcher = new TerminalErrorWatcher({
      enabled: () => true,
      onError: () => {},
    });
    watcher.dispose();
    expect(() => watcher.dispose()).not.toThrow();
  });
});
