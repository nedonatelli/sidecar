import { describe, it, expect, vi, afterEach } from 'vitest';
import { window } from 'vscode';
import type { TerminalErrorEvent } from './errorWatcher.js';
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

// ---------------------------------------------------------------------------
// End-to-end handleExecution tests (v0.67 chunk 7).
//
// The vscode mock ships without `onDidStartTerminalShellExecution`, so
// TerminalErrorWatcher's feature detection returns early and the
// handleExecution pipeline (lines 87-180) is never exercised. These
// tests monkey-patch both start + end event emitters onto the window
// mock, synthesize execution events with controllable async iterators,
// and assert the full dispatch contract: enabled gating, ignored-
// terminal filtering, output tail-capping, ANSI stripping, dedup,
// and dispose-throws being swallowed.
// ---------------------------------------------------------------------------

type StartListener = (event: unknown) => void;
type EndListener = (event: unknown) => void;

interface TerminalShellHarness {
  fireStart(event: unknown): void;
  fireEnd(event: unknown): void;
  restore(): void;
}

/**
 * Patches `window.onDidStartTerminalShellExecution` +
 * `window.onDidEndTerminalShellExecution` so tests can synthesize
 * start/end events and capture the watcher's subscriptions.
 */
function installShellHarness(): TerminalShellHarness {
  const mutableWindow = window as unknown as {
    onDidStartTerminalShellExecution?: (l: StartListener) => { dispose: () => void };
    onDidEndTerminalShellExecution?: (l: EndListener) => { dispose: () => void };
  };
  const priorStart = mutableWindow.onDidStartTerminalShellExecution;
  const priorEnd = mutableWindow.onDidEndTerminalShellExecution;

  const startListeners = new Set<StartListener>();
  const endListeners = new Set<EndListener>();

  mutableWindow.onDidStartTerminalShellExecution = (listener: StartListener) => {
    startListeners.add(listener);
    return { dispose: () => startListeners.delete(listener) };
  };
  mutableWindow.onDidEndTerminalShellExecution = (listener: EndListener) => {
    endListeners.add(listener);
    return { dispose: () => endListeners.delete(listener) };
  };

  return {
    fireStart(event) {
      for (const l of [...startListeners]) l(event);
    },
    fireEnd(event) {
      for (const l of [...endListeners]) l(event);
    },
    restore() {
      mutableWindow.onDidStartTerminalShellExecution = priorStart;
      mutableWindow.onDidEndTerminalShellExecution = priorEnd;
    },
  };
}

/**
 * Build a pair of synthetic (start, end) events that share a single
 * `execution` identity object so the watcher's event-matching logic
 * links them. The `chunks` array becomes the async iterator returned
 * by `execution.read()`.
 */
function makeEvents({
  commandLine,
  chunks,
  exitCode,
  terminalName = 'zsh',
  cwd,
}: {
  commandLine: string;
  chunks: readonly string[];
  exitCode: number | undefined;
  terminalName?: string;
  cwd?: string;
}): {
  start: unknown;
  end: unknown;
} {
  const execution = {
    commandLine: { value: commandLine },
    cwd: cwd ? { fsPath: cwd } : undefined,
    read: async function* () {
      for (const c of chunks) yield c;
    },
  };
  const terminal = { name: terminalName };
  return {
    start: { terminal, execution },
    end: { terminal, execution, exitCode },
  };
}

/** Yield to the microtask queue so the watcher's async machinery can run. */
async function drainMicrotasks(iterations = 4): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('TerminalErrorWatcher — handleExecution', () => {
  let harness: TerminalShellHarness | undefined;

  afterEach(() => {
    harness?.restore();
    harness = undefined;
  });

  it('subscribes to start events when the VS Code host exposes shell execution events', async () => {
    harness = installShellHarness();
    const events: TerminalErrorEvent[] = [];
    const watcher = new TerminalErrorWatcher({
      enabled: () => true,
      onError: (e) => events.push(e),
    });

    const { start, end } = makeEvents({
      commandLine: 'npm test',
      chunks: ['line A\n', 'line B\n'],
      exitCode: 1,
    });
    harness.fireStart(start);
    await drainMicrotasks();
    harness.fireEnd(end);
    await drainMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0].commandLine).toBe('npm test');
    expect(events[0].exitCode).toBe(1);
    expect(events[0].output).toContain('line A');
    expect(events[0].output).toContain('line B');

    watcher.dispose();
  });

  it('does not fire onError for a zero exit code', async () => {
    harness = installShellHarness();
    const onError = vi.fn();
    const watcher = new TerminalErrorWatcher({ enabled: () => true, onError });

    const { start, end } = makeEvents({ commandLine: 'npm test', chunks: ['ok'], exitCode: 0 });
    harness.fireStart(start);
    await drainMicrotasks();
    harness.fireEnd(end);
    await drainMicrotasks();

    expect(onError).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it('skips execution entirely when enabled() returns false', async () => {
    harness = installShellHarness();
    const onError = vi.fn();
    const watcher = new TerminalErrorWatcher({ enabled: () => false, onError });

    const { start, end } = makeEvents({ commandLine: 'npm test', chunks: ['x'], exitCode: 1 });
    harness.fireStart(start);
    await drainMicrotasks();
    harness.fireEnd(end);
    await drainMicrotasks();

    expect(onError).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it('skips execution when the terminal name is on the ignore list', async () => {
    harness = installShellHarness();
    const onError = vi.fn();
    const watcher = new TerminalErrorWatcher({
      enabled: () => true,
      ignoredTerminalNames: new Set(['SideCar Agent']),
      onError,
    });

    const { start, end } = makeEvents({
      commandLine: 'npm test',
      chunks: ['x'],
      exitCode: 1,
      terminalName: 'SideCar Agent',
    });
    harness.fireStart(start);
    await drainMicrotasks();
    harness.fireEnd(end);
    await drainMicrotasks();

    expect(onError).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it('strips ANSI sequences from the captured output before invoking onError', async () => {
    harness = installShellHarness();
    const events: TerminalErrorEvent[] = [];
    const watcher = new TerminalErrorWatcher({
      enabled: () => true,
      onError: (e) => events.push(e),
    });

    const { start, end } = makeEvents({
      commandLine: 'test',
      chunks: ['\x1B[31merror:\x1B[0m details'],
      exitCode: 2,
    });
    harness.fireStart(start);
    await drainMicrotasks();
    harness.fireEnd(end);
    await drainMicrotasks();

    expect(events[0].output).toBe('error: details');
    expect(events[0].output).not.toContain('\x1B');
    watcher.dispose();
  });

  it('tail-caps output to maxOutputChars on streams larger than the 2× buffer', async () => {
    harness = installShellHarness();
    const events: TerminalErrorEvent[] = [];
    const watcher = new TerminalErrorWatcher({
      enabled: () => true,
      maxOutputChars: 50,
      onError: (e) => events.push(e),
    });

    const bigChunks = Array.from({ length: 50 }, (_, i) => `chunk-${i}-filler-filler-filler\n`);
    const { start, end } = makeEvents({
      commandLine: 'verbose',
      chunks: bigChunks,
      exitCode: 1,
    });
    harness.fireStart(start);
    await drainMicrotasks(8);
    harness.fireEnd(end);
    await drainMicrotasks();

    // Captured output must not exceed the configured cap (after ANSI strip + trim).
    expect(events[0].output.length).toBeLessThanOrEqual(50);
    // The tail of the stream is what survives — last chunk's content should appear.
    expect(events[0].output).toContain('chunk-49');
    watcher.dispose();
  });

  it('dedupes the same command within the cooldown window', async () => {
    harness = installShellHarness();
    const events: TerminalErrorEvent[] = [];
    const watcher = new TerminalErrorWatcher({
      enabled: () => true,
      cooldownMs: 60_000,
      onError: (e) => events.push(e),
    });

    const firstRun = makeEvents({ commandLine: 'npm test', chunks: ['a'], exitCode: 1 });
    harness.fireStart(firstRun.start);
    await drainMicrotasks();
    harness.fireEnd(firstRun.end);
    await drainMicrotasks();

    const secondRun = makeEvents({ commandLine: 'npm test', chunks: ['b'], exitCode: 1 });
    harness.fireStart(secondRun.start);
    await drainMicrotasks();
    harness.fireEnd(secondRun.end);
    await drainMicrotasks();

    // Second run was within cooldown and dedup-suppressed.
    expect(events).toHaveLength(1);
    watcher.dispose();
  });

  it('captures cwd from the execution event when present', async () => {
    harness = installShellHarness();
    const events: TerminalErrorEvent[] = [];
    const watcher = new TerminalErrorWatcher({
      enabled: () => true,
      onError: (e) => events.push(e),
    });

    const { start, end } = makeEvents({
      commandLine: 'false',
      chunks: ['error'],
      exitCode: 1,
      cwd: '/workspaces/foo',
    });
    harness.fireStart(start);
    await drainMicrotasks();
    harness.fireEnd(end);
    await drainMicrotasks();

    expect(events[0].cwd).toBe('/workspaces/foo');
    watcher.dispose();
  });
});

describe('TerminalErrorWatcher.dispose — error swallowing', () => {
  it('continues disposing remaining disposables when one throws', () => {
    const harness = installShellHarness();
    try {
      const watcher = new TerminalErrorWatcher({
        enabled: () => true,
        onError: () => {},
      });
      // Inject a throwing disposable via private field access — simulates
      // a rogue SDK disposable whose dispose() raises.
      const rogueDispose = vi.fn(() => {
        throw new Error('rogue');
      });
      const followupDispose = vi.fn();
      (watcher as unknown as { disposables: Array<{ dispose: () => void }> }).disposables.push(
        { dispose: rogueDispose },
        { dispose: followupDispose },
      );
      expect(() => watcher.dispose()).not.toThrow();
      expect(rogueDispose).toHaveBeenCalled();
      expect(followupDispose).toHaveBeenCalled();
    } finally {
      harness.restore();
    }
  });
});
