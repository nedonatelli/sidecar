import { Disposable, languages, DiagnosticSeverity, Uri, Diagnostic } from 'vscode';

/**
 * Configuration for the reactive diagnostic fixer.
 */
export interface DiagnosticSubscriberConfig {
  enabled: boolean;
  debounceMs: number;
  severity: 'error' | 'warning';
}

/**
 * Subscribes to VS Code's diagnostic changes and fires a reactive fix callback
 * when diagnostics matching the configured severity appear.
 *
 * Usage:
 *   const subscriber = new DiagnosticSubscriber(config, async (uri, diagnostics) => {
 *     // Call runAgentLoopInSandbox with the diagnostic context
 *   });
 *   disposable = subscriber; // or: context.subscriptions.push(subscriber);
 */
export class DiagnosticSubscriber implements Disposable {
  private disposable: Disposable | undefined;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private severityThreshold: DiagnosticSeverity;

  constructor(
    private config: DiagnosticSubscriberConfig,
    private onDiagnosticsChanged: (uri: Uri, diagnostics: Diagnostic[]) => Promise<void>,
  ) {
    this.severityThreshold = config.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;

    if (config.enabled) {
      this.disposable = languages.onDidChangeDiagnostics((event) => {
        this.handleDiagnosticChange(event.uris);
      });
    }
  }

  /**
   * Handle a batch of URI diagnostics changes.
   * Filters to URIs with diagnostics at or above the configured severity,
   * then debounces the callback for each URI individually.
   */
  private handleDiagnosticChange(uris: readonly Uri[]): void {
    for (const uri of uris) {
      const diagnostics = languages.getDiagnostics(uri);

      // Check if any diagnostic meets the severity threshold
      const hasRelevantDiag = diagnostics.some((d) => d.severity !== undefined && d.severity <= this.severityThreshold);

      if (!hasRelevantDiag) {
        // Clear any pending timer for this URI if there are no relevant diagnostics
        const key = uri.fsPath;
        if (this.debounceTimers.has(key)) {
          clearTimeout(this.debounceTimers.get(key)!);
          this.debounceTimers.delete(key);
        }
        continue;
      }

      // Debounce the callback for this URI
      const key = uri.fsPath;
      if (this.debounceTimers.has(key)) {
        clearTimeout(this.debounceTimers.get(key)!);
      }

      const timer = setTimeout(() => {
        this.debounceTimers.delete(key);
        this.onDiagnosticsChanged(uri, diagnostics).catch(() => {
          // Swallow errors from the callback
        });
      }, this.config.debounceMs);

      this.debounceTimers.set(key, timer);
    }
  }

  dispose(): void {
    this.disposable?.dispose();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
