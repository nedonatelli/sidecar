import {
  CodeAction,
  CodeActionKind,
  type CodeActionProvider,
  type CodeActionContext,
  type Range,
  type Selection,
  type TextDocument,
  type Diagnostic,
  DiagnosticSeverity,
} from 'vscode';
import * as path from 'path';

/**
 * Provides SideCar's lightbulb / code-actions menu entries.
 *
 * The lightbulb pattern is what makes VS Code extensions feel native:
 * when a diagnostic appears, the user clicks the 💡 and sees remediation
 * options from every provider in one list. SideCar contributes three:
 *
 *   - Fix with SideCar — QuickFix, bound to the diagnostic. Fires for
 *     errors, warnings, and info; hints are skipped to reduce noise.
 *   - Explain with SideCar — Empty kind, shows up in the full
 *     code-actions menu (Cmd+.) on diagnostics and selections.
 *   - Refactor with SideCar — RefactorRewrite, shows under "Refactor"
 *     in the code-actions menu when the user has a non-empty selection.
 *
 * Each action forwards the relevant code range (the diagnostic line for
 * Fix, the selection text for Refactor/Explain) plus the diagnostic
 * message when applicable, so the chat prompt is fully self-contained.
 */
export class SidecarCodeActionProvider implements CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    CodeActionKind.QuickFix,
    CodeActionKind.RefactorRewrite,
    CodeActionKind.Empty,
  ];

  public provideCodeActions(
    document: TextDocument,
    range: Range | Selection,
    context: CodeActionContext,
  ): CodeAction[] {
    const actions: CodeAction[] = [];
    const fileName = path.basename(document.fileName);

    // 1. Diagnostic-bound Fix actions — one per actionable diagnostic
    //    in the range. Bind each to its diagnostic so VS Code shows the
    //    lightbulb on the exact problem and groups the fix underneath.
    const actionableDiagnostics = context.diagnostics.filter(
      (d) =>
        d.severity === DiagnosticSeverity.Error ||
        d.severity === DiagnosticSeverity.Warning ||
        d.severity === DiagnosticSeverity.Information,
    );

    for (const diag of actionableDiagnostics) {
      // Pull the full line containing the diagnostic so the agent has
      // enough context to suggest a repair, not just the squiggle range.
      const line = document.lineAt(diag.range.start.line);
      const code = line.text;
      const diagnosticText = formatDiagnostic(diag);

      const fix = new CodeAction('Fix with SideCar', CodeActionKind.QuickFix);
      fix.diagnostics = [diag];
      fix.command = {
        command: 'sidecar.fixSelection',
        title: 'Fix with SideCar',
        arguments: [{ code, fileName, diagnostic: diagnosticText }],
      };
      actions.push(fix);

      const explainDiag = new CodeAction('Explain this error with SideCar', CodeActionKind.Empty);
      explainDiag.diagnostics = [diag];
      explainDiag.command = {
        command: 'sidecar.explainSelection',
        title: 'Explain with SideCar',
        arguments: [{ code, fileName, diagnostic: diagnosticText }],
      };
      actions.push(explainDiag);
    }

    // 2. Selection-scoped actions — only offered when the user has an
    //    actual selection (not just a cursor position). Avoids polluting
    //    every lightbulb with options that need selected text.
    if (!range.isEmpty) {
      const selectionText = document.getText(range);
      if (selectionText.trim().length > 0) {
        // Don't duplicate Explain when we already added a diagnostic-bound
        // one for the same range.
        const alreadyHaveExplain = actionableDiagnostics.length > 0;
        if (!alreadyHaveExplain) {
          const explain = new CodeAction('Explain with SideCar', CodeActionKind.Empty);
          explain.command = {
            command: 'sidecar.explainSelection',
            title: 'Explain with SideCar',
            arguments: [{ code: selectionText, fileName }],
          };
          actions.push(explain);
        }

        const refactor = new CodeAction('Refactor with SideCar', CodeActionKind.RefactorRewrite);
        refactor.command = {
          command: 'sidecar.refactorSelection',
          title: 'Refactor with SideCar',
          arguments: [{ code: selectionText, fileName }],
        };
        actions.push(refactor);
      }
    }

    return actions;
  }
}

/**
 * Render a Diagnostic into the format the chat prompt receives. Keeps
 * the source (e.g. "typescript"), code (e.g. "TS2339"), severity, and
 * message — everything a model would want to diagnose the error.
 */
function formatDiagnostic(diag: Diagnostic): string {
  const parts: string[] = [];
  if (diag.source) parts.push(`[${diag.source}]`);
  if (diag.code !== undefined) {
    const codeStr = typeof diag.code === 'object' ? diag.code.value : diag.code;
    parts.push(`${codeStr}`);
  }
  parts.push(severityLabel(diag.severity));
  parts.push(diag.message);
  return parts.join(' ');
}

function severityLabel(severity: DiagnosticSeverity): string {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return 'error:';
    case DiagnosticSeverity.Warning:
      return 'warning:';
    case DiagnosticSeverity.Information:
      return 'info:';
    default:
      return 'hint:';
  }
}
