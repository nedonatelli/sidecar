import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range,
  Uri,
  languages,
  workspace,
  type DiagnosticCollection,
} from 'vscode';
import type { FailureBlock } from '../review/ciFailure.js';

export interface CiRunMeta {
  runNumber: number;
  branch: string;
  workflowName: string;
  runUrl: string;
}

const ZERO_RANGE = new Range(new Position(0, 0), new Position(0, 0));

export class CiDiagnostics {
  private readonly collection: DiagnosticCollection;

  constructor() {
    this.collection = languages.createDiagnosticCollection('sidecar-ci');
  }

  async report(blocks: FailureBlock[], meta: CiRunMeta): Promise<void> {
    this.collection.clear();
    if (blocks.length === 0) return;

    const fileUri = await this.resolveTargetFile(meta.workflowName);
    if (!fileUri) return;

    const runTarget = Uri.parse(meta.runUrl);

    const diagnostics = blocks.map((block) => {
      const errorSummary = block.errorLines.slice(0, 2).join(' · ');
      const message = `CI #${meta.runNumber} — "${block.stepName}": ${errorSummary || 'step failed'}`;
      const severity = block.exitCode !== undefined ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
      const diag = new Diagnostic(ZERO_RANGE, message, severity);
      diag.source = 'sidecar-ci';
      diag.code = { value: `run-${meta.runNumber}`, target: runTarget };
      return diag;
    });

    this.collection.set(fileUri, diagnostics);
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }

  private async resolveTargetFile(workflowName: string): Promise<Uri | undefined> {
    // Try to match the workflow YAML by name first.
    const yamls = await workspace.findFiles('.github/workflows/*.{yml,yaml}', undefined, 20);
    if (yamls.length > 0) {
      const lower = workflowName.toLowerCase().replace(/\s+/g, '-');
      const match = yamls.find((u) => u.fsPath.toLowerCase().includes(lower));
      if (match) return match;
      return yamls[0];
    }

    // Fall back to a common manifest at workspace root.
    const manifests = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'];
    for (const m of manifests) {
      const found = await workspace.findFiles(m, undefined, 1);
      if (found.length > 0) return found[0];
    }

    return undefined;
  }
}
