import * as vscode from 'vscode';
import { Range, Position } from 'vscode';
import type { EditTimelineStore } from '../agent/editTimeline.js';
import { computeLineDiff } from '../agent/tools/diffUtils.js';

const AGENT_MOD_DECORATION = vscode.window.createTextEditorDecorationType({
  overviewRulerColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
  isWholeLine: false,
  borderWidth: '0 0 0 3px',
  borderStyle: 'solid',
  borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
});

export function parseModifiedRanges(patch: string): vscode.Range[] {
  if (!patch) return [];

  const lines = patch.split('\n');
  const ranges: vscode.Range[] = [];
  let newFileLine = 0;
  let runStart = -1;
  let runEnd = -1;

  const flushRun = () => {
    if (runStart !== -1) {
      ranges.push(new Range(new Position(runStart, 0), new Position(runEnd, 999)));
      runStart = -1;
      runEnd = -1;
    }
  };

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      flushRun();
      newFileLine = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;

    if (line.startsWith('+')) {
      if (runStart === -1) {
        runStart = newFileLine;
      }
      runEnd = newFileLine;
      newFileLine++;
    } else if (line.startsWith('-')) {
      flushRun();
    } else {
      flushRun();
      newFileLine++;
    }
  }

  flushRun();
  return ranges;
}

export class AgentModDecorationManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private store: EditTimelineStore | null = null;

  attach(store: EditTimelineStore): void {
    this.store = store;
    const unsub = store.onChange(() => this.applyToActiveEditor());
    this.disposables.push({ dispose: unsub });
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.applyToActiveEditor()));
    this.applyToActiveEditor();
  }

  private applyToActiveEditor(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.store) {
      vscode.window.activeTextEditor?.setDecorations(AGENT_MOD_DECORATION, []);
      return;
    }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const fsPath = editor.document.uri.fsPath;
    const relPath = fsPath.startsWith(wsRoot) ? fsPath.slice(wsRoot.length + 1).replace(/\\/g, '/') : null;
    if (!relPath) {
      editor.setDecorations(AGENT_MOD_DECORATION, []);
      return;
    }
    const entry = this.store.list().find((e) => e.relPath === relPath);
    if (!entry) {
      editor.setDecorations(AGENT_MOD_DECORATION, []);
      return;
    }
    const patch = computeLineDiff(entry.originalContent ?? '', entry.newContent, relPath);
    const ranges = patch ? parseModifiedRanges(patch) : [];
    editor.setDecorations(AGENT_MOD_DECORATION, ranges);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

let _manager: AgentModDecorationManager | null = null;

export function setAgentModDecorationManager(m: AgentModDecorationManager): void {
  _manager = m;
}

export function getAgentModDecorationManager(): AgentModDecorationManager | null {
  return _manager;
}
