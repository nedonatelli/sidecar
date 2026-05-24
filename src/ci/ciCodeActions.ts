import {
  CodeAction,
  CodeActionKind,
  type CodeActionContext,
  type CodeActionProvider,
  type Command,
  type Diagnostic,
  type Range,
  type TextDocument,
} from 'vscode';

export class CiCodeActionProvider implements CodeActionProvider {
  provideCodeActions(_document: TextDocument, _range: Range, context: CodeActionContext): CodeAction[] {
    const ciDiags = context.diagnostics.filter((d) => d.source === 'sidecar-ci');
    if (ciDiags.length === 0) return [];

    return ciDiags.flatMap((diag) => buildActionsForDiagnostic(diag));
  }
}

function buildActionsForDiagnostic(diag: Diagnostic): CodeAction[] {
  const fix = new CodeAction('Ask SideCar to fix this CI failure', CodeActionKind.QuickFix);
  fix.diagnostics = [diag];
  fix.command = {
    command: 'sidecar.ci.fixFromDiagnostic',
    title: 'Ask SideCar to fix this CI failure',
    arguments: [diag.message],
  } satisfies Command;

  const analyze = new CodeAction('Analyze CI failure…', CodeActionKind.Empty);
  analyze.diagnostics = [diag];
  analyze.command = {
    command: 'sidecar.ci.analyze',
    title: 'Analyze CI failure',
  } satisfies Command;

  return [fix, analyze];
}
