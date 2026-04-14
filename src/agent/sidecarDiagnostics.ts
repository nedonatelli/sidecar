import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range,
  Uri,
  languages,
  type DiagnosticCollection,
  type Disposable,
} from 'vscode';
import type { SecurityIssue } from './securityScanner.js';
import type { StubMatch } from './stubValidator.js';

/**
 * Thin wrapper around a single `DiagnosticCollection` owned by the
 * extension activation. Anything SideCar detects — leaked secrets,
 * unfinished stubs, vulnerability patterns — ends up here so it
 * shows in the native Problems panel alongside the compiler's own
 * diagnostics. That's the native idiom for "here are issues in
 * your code" and removes the need for ad-hoc chat-only warnings.
 *
 * Each diagnostic carries a `source` tag so Problems panel entries
 * read like `sidecar-secrets` or `sidecar-stubs`, matching how
 * other analyzers identify themselves (`tsc`, `eslint`, etc.).
 *
 * The collection is a module-level singleton because it's
 * unambiguously one-per-extension — the same shared URI→issues map
 * that the chat handler, executor, and any future pre-commit hook
 * all write into.
 */

let collection: DiagnosticCollection | undefined;

/** Returns the shared collection, lazily creating it on first use. */
function ensure(): DiagnosticCollection {
  if (!collection) {
    collection = languages.createDiagnosticCollection('sidecar');
  }
  return collection;
}

function severityToVscode(s: 'error' | 'warning' | 'info'): DiagnosticSeverity {
  switch (s) {
    case 'error':
      return DiagnosticSeverity.Error;
    case 'warning':
      return DiagnosticSeverity.Warning;
    default:
      return DiagnosticSeverity.Information;
  }
}

/** Build a single-line Range that covers line `line` (1-based). */
function lineRange(line: number, columnEnd = 1000): Range {
  const zeroLine = Math.max(0, line - 1);
  return new Range(new Position(zeroLine, 0), new Position(zeroLine, columnEnd));
}

/**
 * Replace the secret / vulnerability diagnostics for a single file.
 * Calling this with an empty array clears the file's entry.
 */
export function reportSecurityIssues(filePath: string, issues: SecurityIssue[]): void {
  const uri = Uri.file(filePath);
  if (issues.length === 0) {
    ensure().delete(uri);
    return;
  }
  const diagnostics = issues.map((issue) => {
    const diag = new Diagnostic(lineRange(issue.line), issue.message, severityToVscode(issue.severity));
    diag.source = issue.category === 'secret' ? 'sidecar-secrets' : 'sidecar-vulns';
    diag.code = issue.category;
    return diag;
  });
  ensure().set(uri, diagnostics);
}

/**
 * Replace the stub / placeholder diagnostics for a single file. Stub
 * matches arrive without line numbers from `detectStubs`, so we
 * resolve them by searching the file content for the matched text.
 * If the caller can't provide content (e.g., the file was queued to
 * the shadow store), pass an empty string and each match lands on
 * line 1 as a fallback.
 */
export function reportStubs(filePath: string, fileContent: string, stubs: StubMatch[]): void {
  const uri = Uri.file(filePath);
  if (stubs.length === 0) {
    ensure().delete(uri);
    return;
  }
  const lines = fileContent.split('\n');
  const diagnostics = stubs.map((stub) => {
    // Resolve a 1-based line number by locating the matched text.
    // Fall back to line 1 if the match can't be found (content drift
    // between detection and report would land us here — harmless).
    let line = 1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(stub.match)) {
        line = i + 1;
        break;
      }
    }
    const diag = new Diagnostic(lineRange(line), `Stub / placeholder code: ${stub.match}`, DiagnosticSeverity.Warning);
    diag.source = 'sidecar-stubs';
    diag.code = stub.category;
    return diag;
  });
  ensure().set(uri, diagnostics);
}

/** Remove every diagnostic for a single file (secrets + stubs + vulns). */
export function clearFile(filePath: string): void {
  ensure().delete(Uri.file(filePath));
}

/** Wipe every SideCar-authored diagnostic from the Problems panel. */
export function clearAll(): void {
  ensure().clear();
}

/**
 * Dispose the underlying collection. Call from extension deactivate
 * so the Problems panel entries disappear when SideCar is disabled
 * or reloaded — otherwise VS Code leaks them until restart.
 */
export function dispose(): Disposable {
  return {
    dispose: () => {
      collection?.dispose();
      collection = undefined;
    },
  };
}
