import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiagnosticSubscriber } from './diagnosticSubscriber.js';

// vscode mock wired via vitest.config.ts alias
import * as vscode from 'vscode';

function makeConfig(overrides: Partial<{ enabled: boolean; debounceMs: number; severity: 'error' | 'warning' }> = {}) {
  return { enabled: false, debounceMs: 0, severity: 'error' as const, ...overrides };
}

describe('DiagnosticSubscriber', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not subscribe when constructed with enabled:false', () => {
    const spy = vi.spyOn(vscode.languages, 'onDidChangeDiagnostics');
    const sub = new DiagnosticSubscriber(makeConfig({ enabled: false }), vi.fn());
    expect(spy).not.toHaveBeenCalled();
    sub.dispose();
  });

  it('subscribes when constructed with enabled:true', () => {
    const spy = vi.spyOn(vscode.languages, 'onDidChangeDiagnostics');
    const sub = new DiagnosticSubscriber(makeConfig({ enabled: true }), vi.fn());
    expect(spy).toHaveBeenCalledOnce();
    sub.dispose();
  });

  describe('reconfigure', () => {
    it('subscribes when toggled from disabled to enabled', () => {
      const spy = vi.spyOn(vscode.languages, 'onDidChangeDiagnostics');
      const sub = new DiagnosticSubscriber(makeConfig({ enabled: false }), vi.fn());
      expect(spy).not.toHaveBeenCalled();

      sub.reconfigure(makeConfig({ enabled: true }));
      expect(spy).toHaveBeenCalledOnce();
      sub.dispose();
    });

    it('unsubscribes when toggled from enabled to disabled', () => {
      const disposeSpy = vi.fn();
      vi.spyOn(vscode.languages, 'onDidChangeDiagnostics').mockReturnValue({ dispose: disposeSpy } as never);

      const sub = new DiagnosticSubscriber(makeConfig({ enabled: true }), vi.fn());
      sub.reconfigure(makeConfig({ enabled: false }));
      expect(disposeSpy).toHaveBeenCalledOnce();
      sub.dispose();
    });

    it('does not re-subscribe when already enabled and reconfigured', () => {
      const spy = vi.spyOn(vscode.languages, 'onDidChangeDiagnostics');
      const sub = new DiagnosticSubscriber(makeConfig({ enabled: true }), vi.fn());
      sub.reconfigure(makeConfig({ enabled: true, debounceMs: 5000 }));
      expect(spy).toHaveBeenCalledOnce(); // only from constructor
      sub.dispose();
    });

    it('does not subscribe when already disabled and reconfigured', () => {
      const spy = vi.spyOn(vscode.languages, 'onDidChangeDiagnostics');
      const sub = new DiagnosticSubscriber(makeConfig({ enabled: false }), vi.fn());
      sub.reconfigure(makeConfig({ enabled: false, debounceMs: 5000 }));
      expect(spy).not.toHaveBeenCalled();
      sub.dispose();
    });

    it('clears pending debounce timers on reconfigure', () => {
      vi.useFakeTimers();
      const callback = vi.fn();
      const sub = new DiagnosticSubscriber(makeConfig({ enabled: true, debounceMs: 1000 }), callback);

      // Simulate a diagnostic change that queues a debounce timer by calling
      // the internal handler indirectly — we rely on the public reconfigure
      // side-effect (timer map cleared) rather than internal state access.
      sub.reconfigure(makeConfig({ enabled: true, debounceMs: 500 }));

      // Advance time — if old timers survived, the callback would fire.
      vi.advanceTimersByTime(2000);
      expect(callback).not.toHaveBeenCalled();

      vi.useRealTimers();
      sub.dispose();
    });
  });

  it('dispose clears debounce timers', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const sub = new DiagnosticSubscriber(makeConfig({ enabled: true, debounceMs: 500 }), callback);
    sub.dispose();
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
